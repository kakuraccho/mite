package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image/jpeg"
	"io"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/repository"
)

type IDFactory func(prefix string) domain.ID

type GuideService struct {
	store     repository.GuideStore
	storage   repository.ObjectStorage
	publisher EventPublisher
	logger    *slog.Logger
	now       func() time.Time
	newID     IDFactory
}

func NewGuideService(store repository.GuideStore, storage repository.ObjectStorage, publisher EventPublisher, logger *slog.Logger) *GuideService {
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &GuideService{store: store, storage: storage, publisher: publisher, logger: logger, now: func() time.Time { return time.Now().UTC() }, newID: guideRandomID}
}

func guideRandomID(prefix string) domain.ID {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		panic("crypto/rand unavailable: " + err.Error())
	}
	return domain.ID(prefix + hex.EncodeToString(value[:]))
}

type CommandMeta struct {
	Actor     domain.Actor
	Key       string
	RequestID string
}

type CreateGuideMaterialBatchCommand struct {
	Meta                    CommandMeta
	SupportSessionID        domain.ID
	ExpectedSessionRevision int64
	CaptureIntervalSeconds  int
	CapturedFrom            *time.Time
	CapturedTo              *time.Time
	ExpectedItemCount       int
}

type GuideMaterialBatchCreated struct {
	Batch          domain.GuideMaterialBatch `json:"batch"`
	SupportSession domain.SupportSession     `json:"supportSession"`
}

type GuideMaterialBatchView struct {
	Batch     domain.GuideMaterialBatch `json:"batch"`
	Materials []domain.GuideMaterial    `json:"materials"`
}

type CreateGuideMaterialCommand struct {
	Meta            CommandMeta
	BatchID         domain.ID
	ClientCaptureID string
	Sequence        int
	CapturedAt      time.Time
	JPEG            []byte
}

type GuideMaterialCreated struct {
	Material domain.GuideMaterial      `json:"material"`
	Batch    domain.GuideMaterialBatch `json:"batch"`
}

type GuideMaterialBatchCompleted struct {
	Batch          domain.GuideMaterialBatch `json:"batch"`
	Job            domain.GuideGenerationJob `json:"job"`
	SupportSession domain.SupportSession     `json:"supportSession"`
}

type CompleteGuideMaterialBatchCommand struct {
	Meta                  CommandMeta
	BatchID               domain.ID
	ExpectedBatchRevision int64
	ExpectedItemCount     int
}

type RetryGuideGenerationJobCommand struct {
	Meta                CommandMeta
	JobID               domain.ID
	ExpectedJobRevision int64
}

type UpdateGuideDraftCommand struct {
	Actor            domain.Actor
	DraftID          domain.ID
	ExpectedRevision int64
	Title            string
	Steps            []domain.GuideStep
}

type SaveGuideDraftCommand struct {
	Meta             CommandMeta
	DraftID          domain.ID
	ExpectedRevision int64
}

type GuideSaved struct {
	Guide          domain.GuideDetail    `json:"guide"`
	SupportSession domain.SupportSession `json:"supportSession"`
}

type CreateGuideRunCommand struct {
	Meta    CommandMeta
	GuideID domain.ID
}

type UpdateGuideRunCommand struct {
	Actor            domain.Actor
	RunID            domain.ID
	ExpectedRevision int64
	Action           domain.GuideRunAction
}

type CompleteGuideRunCommand struct {
	Meta             CommandMeta
	RunID            domain.ID
	ExpectedRevision int64
}

type CreateSupportRequestFromGuideRunCommand struct {
	Meta                        CommandMeta
	RunID                       domain.ID
	ExpectedRevision            int64
	InitialScreenshotArtifactID domain.ID
	Comment                     string
}

type GuideRunSupportRequestCreated struct {
	GuideRun       domain.GuideRun       `json:"guideRun"`
	SupportRequest domain.SupportRequest `json:"supportRequest"`
}

type GuideOperationError struct {
	DomainError *domain.Error
	RequestID   string
}

func (e *GuideOperationError) Error() string { return e.DomainError.Error() }
func (e *GuideOperationError) Unwrap() error { return e.DomainError }

type storedEnvelope[T any] struct {
	Data T `json:"data"`
}
type guideStoredErrorEnvelope struct {
	Error guideStoredError `json:"error"`
}
type guideStoredError struct {
	Code      domain.ErrorCode `json:"code"`
	Message   string           `json:"message"`
	RequestID string           `json:"requestId"`
}

func (s *GuideService) idempotent(
	ctx context.Context,
	meta CommandMeta,
	path string,
	hash domain.RequestHash,
	successStatus int,
	result any,
	work func(repository.GuideTx) ([]domain.Event, error),
) (int, []domain.Event, error) {
	key, err := domain.NewIdempotencyKey(meta.Key)
	if err != nil {
		return 0, nil, err
	}
	scope := domain.IdempotencyScope{ActorID: meta.Actor.ID, Method: "POST", Path: path, Key: key}
	now := s.now()
	var status int
	var events []domain.Event
	var operationErr error
	err = s.store.WithinTx(ctx, pgx.TxOptions{}, func(tx repository.GuideTx) error {
		record, found, err := tx.GetIdempotency(ctx, scope)
		if err != nil {
			return err
		}
		evaluation, err := EvaluateIdempotency(optionalRecord(record, found), hash, now)
		if err != nil {
			return err
		}
		switch evaluation.Decision {
		case IdempotencyReplay:
			status = *evaluation.Record.ResponseStatus
			if status >= 400 {
				var envelope guideStoredErrorEnvelope
				if err := json.Unmarshal(evaluation.Record.ResponseBody, &envelope); err != nil {
					return err
				}
				operationErr = &GuideOperationError{DomainError: domain.NewError(envelope.Error.Code, envelope.Error.Message), RequestID: envelope.Error.RequestID}
				return nil
			}
			if err := json.Unmarshal(evaluation.Record.ResponseBody, result); err != nil {
				return err
			}
			return nil
		case IdempotencyStart:
			record, err = NewInProgressIdempotencyRecord(scope, hash, nil, now)
			if err != nil {
				return err
			}
			if _, err := tx.CreateIdempotency(ctx, record); err != nil {
				return err
			}
		case IdempotencyTakeOver:
			if _, taken, err := tx.TakeOverIdempotency(ctx, scope, evaluation.Record.ResourceID, hash, timestamp(now)); err != nil {
				return err
			} else if !taken {
				return domain.NewError(domain.CodeIdempotencyRequestInProgress, "同じリクエストを処理中")
			}
		}
		events, err = work(tx)
		if err != nil {
			err = translateRepositoryError(err)
			if !persistableBusinessError(err) {
				return err
			}
			domainErr := publicDomainError(err)
			status = guideStatusForDomainCode(domainErr.Code)
			body, marshalErr := json.Marshal(guideStoredErrorEnvelope{Error: guideStoredError{Code: domainErr.Code, Message: domainErr.Message, RequestID: meta.RequestID}})
			if marshalErr != nil {
				return marshalErr
			}
			if err := tx.CompleteIdempotency(ctx, scope, status, body, timestamp(now)); err != nil {
				return err
			}
			operationErr = &GuideOperationError{DomainError: domainErr, RequestID: meta.RequestID}
			events = nil
			return nil
		}
		status = successStatus
		body, err := json.Marshal(result)
		if err != nil {
			return err
		}
		return tx.CompleteIdempotency(ctx, scope, status, body, timestamp(now))
	})
	if err != nil {
		return 0, nil, translateRepositoryError(err)
	}
	if operationErr != nil {
		return status, nil, operationErr
	}
	return status, events, nil
}

func optionalRecord(record domain.IdempotencyRecord, found bool) *domain.IdempotencyRecord {
	if !found {
		return nil
	}
	return &record
}

func persistableBusinessError(err error) bool {
	code, ok := domain.ErrorCodeOf(err)
	return ok && code != domain.CodeInternalError && code != domain.CodeExternalServiceUnavailable && code != domain.CodeUnauthenticated && code != domain.CodeValidationError
}

func publicDomainError(err error) *domain.Error {
	var value *domain.Error
	if errors.As(err, &value) {
		return value
	}
	return domain.NewError(domain.CodeInternalError, "サーバー内部でエラーが発生した")
}

func guideStatusForDomainCode(code domain.ErrorCode) int {
	switch code {
	case domain.CodeForbidden:
		return 403
	case domain.CodeNotFound:
		return 404
	case domain.CodeInvalidState, domain.CodeRevisionConflict, domain.CodeIdempotencyKeyReused, domain.CodeIdempotencyRequestInProgress, domain.CodeDuplicateActiveRequest, domain.CodeMaterialConflict:
		return 409
	case domain.CodeFileTooLarge:
		return 413
	case domain.CodeInsufficientMaterials:
		return 422
	case domain.CodeExternalServiceUnavailable:
		return 503
	case domain.CodeValidationError:
		return 400
	case domain.CodeUnauthenticated:
		return 401
	default:
		return 500
	}
}

func timestamp(value time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}

func translateRepositoryError(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.NewError(domain.CodeNotFound, "対象が見つからない")
	}
	if _, ok := domain.ErrorCodeOf(err); ok {
		return err
	}
	return domain.WrapError(domain.CodeInternalError, "データベース処理に失敗した", err)
}

func validateActorRole(actor domain.Actor, role domain.Role) error {
	if err := actor.Validate(); err != nil {
		return err
	}
	if actor.Role != role {
		return domain.NewError(domain.CodeForbidden, "この役割では実行できない")
	}
	return nil
}

func pairForSession(session domain.SupportSession) domain.UserPair {
	return domain.UserPair{UserID: session.UserID, FamilyID: session.FamilyID}
}

func checkRevision(actual, expected int64) error {
	if actual != expected {
		return domain.NewError(domain.CodeRevisionConflict, "revisionが更新されている")
	}
	return nil
}

func (s *GuideService) publish(ctx context.Context, events []domain.Event) {
	if s.publisher == nil {
		return
	}
	for _, event := range events {
		if err := s.publisher.Publish(ctx, event); err != nil {
			s.logger.WarnContext(ctx, "event delivery failed", "eventId", event.EventID, "eventType", event.Type, "entityId", event.EntityID, "revision", event.Revision)
		}
	}
}

func (s *GuideService) event(eventType domain.EventType, id domain.ID, revision int64, data any, pair domain.UserPair) domain.Event {
	body, _ := json.Marshal(data)
	return domain.Event{EventID: s.newID("evt_"), Type: eventType, OccurredAt: s.now(), EntityID: id, Revision: revision, Data: body, Audience: pair}
}

func (s *GuideService) CreateGuideMaterialBatch(ctx context.Context, command CreateGuideMaterialBatchCommand) (GuideMaterialBatchCreated, error) {
	if err := validateActorRole(command.Meta.Actor, domain.RoleUser); err != nil {
		return GuideMaterialBatchCreated{}, err
	}
	if command.ExpectedSessionRevision < 1 || command.CaptureIntervalSeconds != domain.CaptureIntervalSeconds || command.ExpectedItemCount < 0 || command.ExpectedItemCount > domain.MaxGuideMaterials {
		return GuideMaterialBatchCreated{}, domain.NewError(domain.CodeValidationError, "ガイド材料バッチの入力が不正")
	}
	if command.ExpectedItemCount > 0 {
		if command.CapturedFrom == nil || command.CapturedTo == nil || command.CapturedFrom.After(*command.CapturedTo) {
			return GuideMaterialBatchCreated{}, domain.NewError(domain.CodeValidationError, "撮影期間が不正")
		}
		capturedFrom := command.CapturedFrom.UTC().Truncate(time.Microsecond)
		capturedTo := command.CapturedTo.UTC().Truncate(time.Microsecond)
		command.CapturedFrom = &capturedFrom
		command.CapturedTo = &capturedTo
	} else if command.CapturedFrom != nil || command.CapturedTo != nil {
		return GuideMaterialBatchCreated{}, domain.NewError(domain.CodeValidationError, "画像0件では撮影期間を指定しない")
	}
	hash, err := domain.HashCanonicalJSON(struct {
		ExpectedSessionRevision int64      `json:"expectedSessionRevision"`
		CaptureIntervalSeconds  int        `json:"captureIntervalSeconds"`
		CapturedFrom            *time.Time `json:"capturedFrom"`
		CapturedTo              *time.Time `json:"capturedTo"`
		ExpectedItemCount       int        `json:"expectedItemCount"`
	}{command.ExpectedSessionRevision, command.CaptureIntervalSeconds, command.CapturedFrom, command.CapturedTo, command.ExpectedItemCount})
	if err != nil {
		return GuideMaterialBatchCreated{}, err
	}
	result := storedEnvelope[GuideMaterialBatchCreated]{}
	path := "/v1/support-sessions/" + string(command.SupportSessionID) + "/guide-material-batches"
	_, events, err := s.idempotent(ctx, command.Meta, path, hash, 201, &result, func(tx repository.GuideTx) ([]domain.Event, error) {
		session, err := tx.GetSession(ctx, command.SupportSessionID, true)
		if err != nil {
			return nil, err
		}
		if err := pairForSession(session).Authorize(command.Meta.Actor, domain.RoleUser); err != nil {
			return nil, err
		}
		if err := checkRevision(session.Revision, command.ExpectedSessionRevision); err != nil {
			return nil, err
		}
		if session.Status != domain.SupportSessionGeneratingGuide || session.GuideDecision == nil || *session.GuideDecision != domain.GuideDecisionCreate || session.GuideMaterialBatchID != nil {
			return nil, domain.NewError(domain.CodeInvalidState, "現在の支援状態ではバッチを作成できない")
		}
		if command.ExpectedItemCount == 0 {
			return nil, domain.NewError(domain.CodeInsufficientMaterials, "ガイド生成に使える画像がない")
		}
		now := s.now()
		batch := domain.GuideMaterialBatch{ID: s.newID("batch_"), SupportSessionID: session.ID, Status: domain.GuideMaterialBatchUploading, CaptureIntervalSeconds: command.CaptureIntervalSeconds, ExpectedItemCount: command.ExpectedItemCount, CapturedFrom: command.CapturedFrom.UTC(), CapturedTo: command.CapturedTo.UTC(), CreatedAt: now, UpdatedAt: now, Revision: 1}
		batch, err = tx.CreateBatch(ctx, batch)
		if err != nil {
			return nil, err
		}
		session, err = tx.AttachBatch(ctx, session.ID, batch.ID, timestamp(now))
		if err != nil {
			return nil, err
		}
		result.Data = GuideMaterialBatchCreated{Batch: batch, SupportSession: session}
		pair := pairForSession(session)
		return []domain.Event{s.event(domain.EventGuideMaterialBatchCreated, batch.ID, batch.Revision, batch, pair), s.event(domain.EventSupportSessionUpdated, session.ID, session.Revision, session, pair)}, nil
	})
	if err != nil {
		return GuideMaterialBatchCreated{}, err
	}
	s.publish(ctx, events)
	return result.Data, nil
}

func (s *GuideService) GetGuideMaterialBatch(ctx context.Context, actor domain.Actor, id domain.ID) (GuideMaterialBatchView, error) {
	if err := actor.Validate(); err != nil {
		return GuideMaterialBatchView{}, err
	}
	var result GuideMaterialBatchView
	err := s.store.WithinTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx repository.GuideTx) error {
		batch, err := tx.GetBatch(ctx, id, false)
		if err != nil {
			return err
		}
		session, err := tx.GetSession(ctx, batch.SupportSessionID, false)
		if err != nil {
			return err
		}
		if err := pairForSession(session).Authorize(actor, domain.RoleUser, domain.RoleFamily); err != nil {
			return err
		}
		materials, err := tx.ListMaterials(ctx, batch.ID)
		if err != nil {
			return err
		}
		result = GuideMaterialBatchView{Batch: batch, Materials: materials}
		return nil
	})
	return result, translateRepositoryErrorOrNil(err)
}

func validateGuideMaterialJPEG(data []byte) (string, int, int, error) {
	if int64(len(data)) > domain.MaxArtifactBytes {
		return "", 0, 0, domain.NewError(domain.CodeFileTooLarge, "画像は10MB以下にする")
	}
	if len(data) == 0 {
		return "", 0, 0, domain.NewError(domain.CodeValidationError, "JPEG画像が必要")
	}
	decoded, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil || decoded.Bounds().Dx() < 1 || decoded.Bounds().Dy() < 1 {
		return "", 0, 0, domain.NewError(domain.CodeValidationError, "JPEG画像が不正")
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:]), decoded.Bounds().Dx(), decoded.Bounds().Dy(), nil
}

func translateRepositoryErrorOrNil(err error) error {
	if err == nil {
		return nil
	}
	return translateRepositoryError(err)
}

type materialReservation struct {
	Scope      domain.IdempotencyScope
	ArtifactID domain.ID
	Replay     *storedEnvelope[GuideMaterialCreated]
	Status     int
	ReplayErr  error
}

func (s *GuideService) reserveMaterial(ctx context.Context, meta CommandMeta, path string, hash domain.RequestHash) (materialReservation, error) {
	key, err := domain.NewIdempotencyKey(meta.Key)
	if err != nil {
		return materialReservation{}, err
	}
	scope := domain.IdempotencyScope{ActorID: meta.Actor.ID, Method: "POST", Path: path, Key: key}
	now := s.now()
	candidate := s.newID("art_")
	reservation := materialReservation{Scope: scope}
	err = s.store.WithinTx(ctx, pgx.TxOptions{}, func(tx repository.GuideTx) error {
		record, found, err := tx.GetIdempotency(ctx, scope)
		if err != nil {
			return err
		}
		evaluation, err := EvaluateIdempotency(optionalRecord(record, found), hash, now)
		if err != nil {
			return err
		}
		switch evaluation.Decision {
		case IdempotencyReplay:
			reservation.Status = *evaluation.Record.ResponseStatus
			if reservation.Status >= 400 {
				var envelope guideStoredErrorEnvelope
				if err := json.Unmarshal(evaluation.Record.ResponseBody, &envelope); err != nil {
					return err
				}
				reservation.ReplayErr = &GuideOperationError{DomainError: domain.NewError(envelope.Error.Code, envelope.Error.Message), RequestID: envelope.Error.RequestID}
				return nil
			}
			var envelope storedEnvelope[GuideMaterialCreated]
			if err := json.Unmarshal(evaluation.Record.ResponseBody, &envelope); err != nil {
				return err
			}
			reservation.Replay = &envelope
			return nil
		case IdempotencyStart:
			record, err = NewInProgressIdempotencyRecord(scope, hash, &candidate, now)
			if err != nil {
				return err
			}
			record, err = tx.CreateIdempotency(ctx, record)
			if err != nil {
				return err
			}
		case IdempotencyTakeOver:
			resourceID := evaluation.Record.ResourceID
			if resourceID == nil {
				resourceID = &candidate
			}
			var taken bool
			record, taken, err = tx.TakeOverIdempotency(ctx, scope, resourceID, hash, timestamp(now))
			if err != nil {
				return err
			}
			if !taken {
				return domain.NewError(domain.CodeIdempotencyRequestInProgress, "同じリクエストを処理中")
			}
		}
		if record.ResourceID == nil {
			return errors.New("material idempotency resource id is missing")
		}
		reservation.ArtifactID = *record.ResourceID
		return nil
	})
	if err != nil {
		return materialReservation{}, translateRepositoryError(err)
	}
	return reservation, nil
}

func (s *GuideService) releaseMaterialLease(ctx context.Context, scope domain.IdempotencyScope) {
	_ = s.store.WithinTx(ctx, pgx.TxOptions{}, func(tx repository.GuideTx) error { return tx.ReleaseIdempotency(ctx, scope, timestamp(s.now())) })
}

func (s *GuideService) finishMaterialReservationError(ctx context.Context, reservation materialReservation, meta CommandMeta, failure error) (int, error) {
	failure = translateRepositoryError(failure)
	if !persistableBusinessError(failure) {
		s.releaseMaterialLease(ctx, reservation.Scope)
		return guideStatusForDomainCode(publicDomainError(failure).Code), failure
	}
	domainErr := publicDomainError(failure)
	status := guideStatusForDomainCode(domainErr.Code)
	body, err := json.Marshal(guideStoredErrorEnvelope{Error: guideStoredError{Code: domainErr.Code, Message: domainErr.Message, RequestID: meta.RequestID}})
	if err != nil {
		s.releaseMaterialLease(ctx, reservation.Scope)
		return 0, err
	}
	if err := s.store.WithinTx(ctx, pgx.TxOptions{}, func(tx repository.GuideTx) error {
		return tx.CompleteIdempotency(ctx, reservation.Scope, status, body, timestamp(s.now()))
	}); err != nil {
		return 0, translateRepositoryError(err)
	}
	return status, &GuideOperationError{DomainError: domainErr, RequestID: meta.RequestID}
}

func (s *GuideService) CreateGuideMaterial(ctx context.Context, command CreateGuideMaterialCommand) (GuideMaterialCreated, int, error) {
	if err := validateActorRole(command.Meta.Actor, domain.RoleUser); err != nil {
		return GuideMaterialCreated{}, 0, err
	}
	if _, err := domain.NewID(command.ClientCaptureID); err != nil {
		return GuideMaterialCreated{}, 0, err
	}
	if command.Sequence < 1 || command.Sequence > domain.MaxGuideMaterials || command.CapturedAt.IsZero() {
		return GuideMaterialCreated{}, 0, domain.NewError(domain.CodeValidationError, "ガイド材料の入力が不正")
	}
	command.CapturedAt = command.CapturedAt.UTC().Truncate(time.Microsecond)
	sha, width, height, err := validateGuideMaterialJPEG(command.JPEG)
	if err != nil {
		return GuideMaterialCreated{}, 0, err
	}
	fileHash, _ := domain.NewRequestHash(sha)
	hash, err := domain.HashCanonicalMultipart([]domain.MultipartHashPart{{Name: "clientCaptureId", Value: command.ClientCaptureID}, {Name: "sequence", Value: fmt.Sprint(command.Sequence)}, {Name: "capturedAt", Value: command.CapturedAt.UTC().Format(time.RFC3339Nano)}}, fileHash)
	if err != nil {
		return GuideMaterialCreated{}, 0, err
	}
	path := "/v1/guide-material-batches/" + string(command.BatchID) + "/materials"
	reservation, err := s.reserveMaterial(ctx, command.Meta, path, hash)
	if err != nil {
		return GuideMaterialCreated{}, 0, err
	}
	if reservation.ReplayErr != nil {
		return GuideMaterialCreated{}, reservation.Status, reservation.ReplayErr
	}
	if reservation.Replay != nil {
		return reservation.Replay.Data, reservation.Status, nil
	}
	// Resolve the owner only after replay evaluation. This preserves an earlier
	// completed response even after saveGuideDraft has cleaned up the batch.
	// Final state is checked again under the session and batch locks after upload.
	var owner domain.ID
	err = s.store.WithinTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx repository.GuideTx) error {
		batch, err := tx.GetBatch(ctx, command.BatchID, false)
		if err != nil {
			return err
		}
		session, err := tx.GetSession(ctx, batch.SupportSessionID, false)
		if err != nil {
			return err
		}
		if err := pairForSession(session).Authorize(command.Meta.Actor, domain.RoleUser); err != nil {
			return err
		}
		owner = session.UserID
		return nil
	})
	if err != nil {
		status, operationErr := s.finishMaterialReservationError(ctx, reservation, command.Meta, err)
		return GuideMaterialCreated{}, status, operationErr
	}
	if s.storage == nil {
		s.releaseMaterialLease(ctx, reservation.Scope)
		return GuideMaterialCreated{}, 0, domain.NewError(domain.CodeExternalServiceUnavailable, "画像Storageを利用できない")
	}
	storageKey := string(owner) + "/" + string(reservation.ArtifactID) + ".jpg"
	if err := s.storage.Put(ctx, storageKey, bytes.NewReader(command.JPEG), int64(len(command.JPEG)), "image/jpeg"); err != nil {
		if !repository.IsStorageOutcomeUnknown(err) {
			s.releaseMaterialLease(ctx, reservation.Scope)
		}
		return GuideMaterialCreated{}, 0, domain.WrapError(domain.CodeExternalServiceUnavailable, "画像を保存できない", err)
	}

	result := storedEnvelope[GuideMaterialCreated]{}
	status := 0
	var events []domain.Event
	var operationErr error
	now := s.now()
	err = s.store.WithinTx(ctx, pgx.TxOptions{}, func(tx repository.GuideTx) error {
		record, found, err := tx.GetIdempotency(ctx, reservation.Scope)
		if err != nil {
			return err
		}
		if !found {
			return errors.New("material idempotency record disappeared")
		}
		if record.RequestHash != hash {
			return domain.NewError(domain.CodeIdempotencyKeyReused, "同じIdempotency-Keyが異なるリクエストに使用されている")
		}
		if record.Status == domain.IdempotencyCompleted {
			status = *record.ResponseStatus
			if status >= 400 {
				var envelope guideStoredErrorEnvelope
				if err := json.Unmarshal(record.ResponseBody, &envelope); err != nil {
					return err
				}
				operationErr = &GuideOperationError{DomainError: domain.NewError(envelope.Error.Code, envelope.Error.Message), RequestID: envelope.Error.RequestID}
				return nil
			}
			return json.Unmarshal(record.ResponseBody, &result)
		}
		cleanup := func() error {
			return tx.CreateDeletionTask(ctx, domain.ArtifactDeletionTask{ID: s.newID("delete_"), StorageKey: storageKey, Status: domain.ArtifactDeletionPending, NextAttemptAt: now, CreatedAt: now})
		}
		completeFailure := func(failure error) error {
			if err := cleanup(); err != nil {
				return err
			}
			domainErr := publicDomainError(failure)
			status = guideStatusForDomainCode(domainErr.Code)
			if domainErr.Code == domain.CodeValidationError {
				if err := tx.ReleaseIdempotency(ctx, reservation.Scope, timestamp(now)); err != nil {
					return err
				}
				operationErr = &GuideOperationError{DomainError: domainErr, RequestID: command.Meta.RequestID}
				return nil
			}
			body, err := json.Marshal(guideStoredErrorEnvelope{Error: guideStoredError{Code: domainErr.Code, Message: domainErr.Message, RequestID: command.Meta.RequestID}})
			if err != nil {
				return err
			}
			if err := tx.CompleteIdempotency(ctx, reservation.Scope, status, body, timestamp(now)); err != nil {
				return err
			}
			operationErr = &GuideOperationError{DomainError: domainErr, RequestID: command.Meta.RequestID}
			return nil
		}
		unlockedBatch, err := tx.GetBatch(ctx, command.BatchID, false)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return completeFailure(translateRepositoryError(err))
			}
			return err
		}
		session, err := tx.GetSession(ctx, unlockedBatch.SupportSessionID, true)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return completeFailure(translateRepositoryError(err))
			}
			return err
		}
		batch, err := tx.GetBatch(ctx, command.BatchID, true)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return completeFailure(translateRepositoryError(err))
			}
			return err
		}
		if err := pairForSession(session).Authorize(command.Meta.Actor, domain.RoleUser); err != nil {
			return completeFailure(err)
		}
		if batch.Status != domain.GuideMaterialBatchUploading || session.Status != domain.SupportSessionGeneratingGuide || session.GuideMaterialBatchID == nil || *session.GuideMaterialBatchID != batch.ID {
			return completeFailure(domain.NewError(domain.CodeInvalidState, "現在の状態では材料を登録できない"))
		}
		if command.Sequence > batch.ExpectedItemCount || command.CapturedAt.Before(batch.CapturedFrom) || command.CapturedAt.After(batch.CapturedTo) {
			return completeFailure(domain.NewError(domain.CodeValidationError, "材料のsequenceまたはcapturedAtがバッチ範囲外"))
		}
		byCapture, captureErr := tx.GetMaterialByCaptureID(ctx, batch.ID, command.ClientCaptureID)
		if captureErr == nil {
			if byCapture.Material.Sequence != command.Sequence || !byCapture.Material.CapturedAt.Equal(command.CapturedAt) || byCapture.SHA256 != sha {
				return completeFailure(domain.NewError(domain.CodeMaterialConflict, "同じclientCaptureIdに異なる材料が指定された"))
			}
			if err := cleanup(); err != nil {
				return err
			}
			status = 200
			result.Data = GuideMaterialCreated{Material: byCapture.Material, Batch: batch}
			body, _ := json.Marshal(result)
			return tx.CompleteIdempotency(ctx, reservation.Scope, status, body, timestamp(now))
		}
		if !errors.Is(captureErr, pgx.ErrNoRows) {
			return captureErr
		}
		if _, sequenceErr := tx.GetMaterialBySequence(ctx, batch.ID, command.Sequence); sequenceErr == nil {
			return completeFailure(domain.NewError(domain.CodeMaterialConflict, "同じsequenceに異なる材料が指定された"))
		} else if !errors.Is(sequenceErr, pgx.ErrNoRows) {
			return sequenceErr
		}
		artifact := domain.Artifact{ID: reservation.ArtifactID, OwnerUserID: owner, Purpose: domain.ArtifactPurposeGuideMaterial, MimeType: "image/jpeg", StorageKey: storageKey, SHA256: sha, ByteSize: int64(len(command.JPEG)), Width: width, Height: height, CapturedAt: command.CapturedAt.UTC(), CreatedAt: now, UpdatedAt: now, Revision: 1}
		if _, err := tx.CreateArtifact(ctx, artifact); err != nil {
			return err
		}
		material := domain.GuideMaterial{ID: s.newID("material_"), BatchID: batch.ID, ClientCaptureID: command.ClientCaptureID, ArtifactID: artifact.ID, Sequence: command.Sequence, CapturedAt: command.CapturedAt.UTC(), CreatedAt: now}
		material, err = tx.CreateMaterial(ctx, material)
		if err != nil {
			return err
		}
		batch, err = tx.IncrementBatch(ctx, batch.ID, timestamp(now))
		if err != nil {
			return err
		}
		status = 201
		result.Data = GuideMaterialCreated{Material: material, Batch: batch}
		body, _ := json.Marshal(result)
		if err := tx.CompleteIdempotency(ctx, reservation.Scope, status, body, timestamp(now)); err != nil {
			return err
		}
		pair := pairForSession(session)
		events = []domain.Event{s.event(domain.EventGuideMaterialBatchUpdated, batch.ID, batch.Revision, batch, pair)}
		return nil
	})
	if err != nil {
		return GuideMaterialCreated{}, 0, translateRepositoryError(err)
	}
	if operationErr != nil {
		return GuideMaterialCreated{}, status, operationErr
	}
	s.publish(ctx, events)
	return result.Data, status, nil
}

func (s *GuideService) CompleteGuideMaterialBatch(ctx context.Context, command CompleteGuideMaterialBatchCommand) (GuideMaterialBatchCompleted, error) {
	if err := validateActorRole(command.Meta.Actor, domain.RoleUser); err != nil {
		return GuideMaterialBatchCompleted{}, err
	}
	if command.ExpectedBatchRevision < 1 || command.ExpectedItemCount < 1 || command.ExpectedItemCount > domain.MaxGuideMaterials {
		return GuideMaterialBatchCompleted{}, domain.NewError(domain.CodeValidationError, "バッチ完了の入力が不正")
	}
	hash, err := domain.HashCanonicalJSON(struct {
		ExpectedBatchRevision int64 `json:"expectedBatchRevision"`
		ExpectedItemCount     int   `json:"expectedItemCount"`
	}{command.ExpectedBatchRevision, command.ExpectedItemCount})
	if err != nil {
		return GuideMaterialBatchCompleted{}, err
	}
	result := storedEnvelope[GuideMaterialBatchCompleted]{}
	path := "/v1/guide-material-batches/" + string(command.BatchID) + "/complete"
	_, events, err := s.idempotent(ctx, command.Meta, path, hash, 202, &result, func(tx repository.GuideTx) ([]domain.Event, error) {
		unlockedBatch, err := tx.GetBatch(ctx, command.BatchID, false)
		if err != nil {
			return nil, err
		}
		session, err := tx.GetSession(ctx, unlockedBatch.SupportSessionID, true)
		if err != nil {
			return nil, err
		}
		batch, err := tx.GetBatch(ctx, command.BatchID, true)
		if err != nil {
			return nil, err
		}
		if err := pairForSession(session).Authorize(command.Meta.Actor, domain.RoleUser); err != nil {
			return nil, err
		}
		if err := checkRevision(batch.Revision, command.ExpectedBatchRevision); err != nil {
			return nil, err
		}
		if batch.Status != domain.GuideMaterialBatchUploading || session.Status != domain.SupportSessionGeneratingGuide || session.GuideMaterialBatchID == nil || *session.GuideMaterialBatchID != batch.ID || session.GuideGenerationJobID != nil || command.ExpectedItemCount != batch.ExpectedItemCount || batch.ReceivedItemCount != batch.ExpectedItemCount {
			return nil, domain.NewError(domain.CodeInvalidState, "ガイド材料バッチを完了できない")
		}
		manifest, err := tx.GetMaterialManifest(ctx, batch.ID)
		if err != nil {
			return nil, err
		}
		if manifest.MaterialCount != batch.ExpectedItemCount || manifest.CaptureIDCount != batch.ExpectedItemCount || manifest.SequenceCount != batch.ExpectedItemCount || manifest.MinSequence != 1 || manifest.MaxSequence != batch.ExpectedItemCount || !manifest.MinCapturedAt.Valid || !manifest.MaxCapturedAt.Valid || !manifest.MinCapturedAt.Time.Equal(batch.CapturedFrom) || !manifest.MaxCapturedAt.Time.Equal(batch.CapturedTo) {
			return nil, domain.NewError(domain.CodeInvalidState, "ガイド材料が揃っていない")
		}
		now := s.now()
		batch, err = tx.CompleteBatch(ctx, batch.ID, timestamp(now))
		if err != nil {
			return nil, err
		}
		job := domain.GuideGenerationJob{ID: s.newID("job_"), BatchID: batch.ID, Status: domain.GuideGenerationJobQueued, Attempt: 0, CreatedAt: now, UpdatedAt: now, Revision: 1}
		job, err = tx.CreateJob(ctx, job)
		if err != nil {
			return nil, err
		}
		session, err = tx.AttachJob(ctx, session.ID, job.ID, timestamp(now))
		if err != nil {
			return nil, err
		}
		result.Data = GuideMaterialBatchCompleted{Batch: batch, Job: job, SupportSession: session}
		pair := pairForSession(session)
		return []domain.Event{s.event(domain.EventGuideMaterialBatchUpdated, batch.ID, batch.Revision, batch, pair), s.event(domain.EventGuideGenerationJobCreated, job.ID, job.Revision, job, pair), s.event(domain.EventSupportSessionUpdated, session.ID, session.Revision, session, pair)}, nil
	})
	if err != nil {
		return GuideMaterialBatchCompleted{}, err
	}
	s.publish(ctx, events)
	return result.Data, nil
}

func (s *GuideService) GetGuideGenerationJob(ctx context.Context, actor domain.Actor, id domain.ID) (domain.GuideGenerationJob, error) {
	if err := actor.Validate(); err != nil {
		return domain.GuideGenerationJob{}, err
	}
	var result domain.GuideGenerationJob
	err := s.store.WithinTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx repository.GuideTx) error {
		job, err := tx.GetJob(ctx, id, false)
		if err != nil {
			return err
		}
		session, err := tx.GetSessionByJob(ctx, id)
		if err != nil {
			return err
		}
		if err := pairForSession(session).Authorize(actor, domain.RoleUser, domain.RoleFamily); err != nil {
			return err
		}
		result = job
		return nil
	})
	return result, translateRepositoryErrorOrNil(err)
}

func (s *GuideService) RetryGuideGenerationJob(ctx context.Context, command RetryGuideGenerationJobCommand) (domain.GuideGenerationJob, error) {
	if err := validateActorRole(command.Meta.Actor, domain.RoleFamily); err != nil {
		return domain.GuideGenerationJob{}, err
	}
	if command.ExpectedJobRevision < 1 {
		return domain.GuideGenerationJob{}, domain.NewError(domain.CodeValidationError, "expectedJobRevisionが不正")
	}
	hash, err := domain.HashCanonicalJSON(struct {
		ExpectedJobRevision int64 `json:"expectedJobRevision"`
	}{command.ExpectedJobRevision})
	if err != nil {
		return domain.GuideGenerationJob{}, err
	}
	result := storedEnvelope[domain.GuideGenerationJob]{}
	path := "/v1/guide-generation-jobs/" + string(command.JobID) + "/retry"
	_, events, err := s.idempotent(ctx, command.Meta, path, hash, 202, &result, func(tx repository.GuideTx) ([]domain.Event, error) {
		unlockedJob, err := tx.GetJob(ctx, command.JobID, false)
		if err != nil {
			return nil, err
		}
		unlockedSession, err := tx.GetSessionByJob(ctx, unlockedJob.ID)
		if err != nil {
			return nil, err
		}
		session, err := tx.GetSession(ctx, unlockedSession.ID, true)
		if err != nil {
			return nil, err
		}
		job, err := tx.GetJob(ctx, command.JobID, true)
		if err != nil {
			return nil, err
		}
		if err := pairForSession(session).Authorize(command.Meta.Actor, domain.RoleFamily); err != nil {
			return nil, err
		}
		if err := checkRevision(job.Revision, command.ExpectedJobRevision); err != nil {
			return nil, err
		}
		if job.Status != domain.GuideGenerationJobFailed || job.Attempt >= domain.MaxGuideJobAttempts || session.Status != domain.SupportSessionGeneratingGuide || session.GuideGenerationJobID == nil || *session.GuideGenerationJobID != job.ID {
			return nil, domain.NewError(domain.CodeInvalidState, "生成ジョブを再試行できない")
		}
		job, err = tx.RetryJob(ctx, job.ID, timestamp(s.now()))
		if err != nil {
			return nil, err
		}
		result.Data = job
		pair := pairForSession(session)
		return []domain.Event{s.event(domain.EventGuideGenerationJobUpdated, job.ID, job.Revision, job, pair)}, nil
	})
	if err != nil {
		return domain.GuideGenerationJob{}, err
	}
	s.publish(ctx, events)
	return result.Data, nil
}

func (s *GuideService) GetGuideDraft(ctx context.Context, actor domain.Actor, id domain.ID) (domain.GuideDraft, error) {
	if err := actor.Validate(); err != nil {
		return domain.GuideDraft{}, err
	}
	var result domain.GuideDraft
	err := s.store.WithinTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx repository.GuideTx) error {
		draft, err := tx.GetDraft(ctx, id, false)
		if err != nil {
			return err
		}
		session, err := tx.GetSessionByDraft(ctx, id)
		if err != nil {
			return err
		}
		if err := pairForSession(session).Authorize(actor, domain.RoleUser, domain.RoleFamily); err != nil {
			return err
		}
		result = draft
		return nil
	})
	return result, translateRepositoryErrorOrNil(err)
}

func (s *GuideService) UpdateGuideDraft(ctx context.Context, command UpdateGuideDraftCommand) (domain.GuideDraft, error) {
	if err := validateActorRole(command.Actor, domain.RoleFamily); err != nil {
		return domain.GuideDraft{}, err
	}
	if command.ExpectedRevision < 1 {
		return domain.GuideDraft{}, domain.NewError(domain.CodeValidationError, "expectedRevisionが不正")
	}
	// Shape and text validation is performed before touching persistent state;
	// allowed artifact membership is checked in the transaction.
	allArtifacts := make(map[domain.ID]struct{}, len(command.Steps))
	for _, step := range command.Steps {
		if _, err := domain.NewID(string(step.ArtifactID)); err != nil {
			return domain.GuideDraft{}, err
		}
		allArtifacts[step.ArtifactID] = struct{}{}
	}
	if err := domain.ValidateGuideDraftContent(command.Title, command.Steps, allArtifacts); err != nil {
		return domain.GuideDraft{}, err
	}
	var result domain.GuideDraft
	var events []domain.Event
	err := s.store.WithinTx(ctx, pgx.TxOptions{}, func(tx repository.GuideTx) error {
		unlockedSession, err := tx.GetSessionByDraft(ctx, command.DraftID)
		if err != nil {
			return err
		}
		session, err := tx.GetSession(ctx, unlockedSession.ID, true)
		if err != nil {
			return err
		}
		draft, err := tx.GetDraft(ctx, command.DraftID, true)
		if err != nil {
			return err
		}
		if err := pairForSession(session).Authorize(command.Actor, domain.RoleFamily); err != nil {
			return err
		}
		if err := checkRevision(draft.Revision, command.ExpectedRevision); err != nil {
			return err
		}
		if session.Status != domain.SupportSessionReviewingGuide || session.GuideDraftID == nil || *session.GuideDraftID != draft.ID || draft.Status != domain.GuideDraftEditing {
			return domain.NewError(domain.CodeInvalidState, "下書きを更新できない")
		}
		allowed, err := tx.ListAllowedDraftArtifacts(ctx, session.ID)
		if err != nil {
			return err
		}
		if err := domain.ValidateGuideDraftContent(command.Title, command.Steps, allowed); err != nil {
			return err
		}
		result, err = tx.UpdateDraft(ctx, draft.ID, command.Title, command.Steps, timestamp(s.now()))
		if err != nil {
			return err
		}
		pair := pairForSession(session)
		events = []domain.Event{s.event(domain.EventGuideDraftUpdated, result.ID, result.Revision, result, pair)}
		return nil
	})
	if err != nil {
		return domain.GuideDraft{}, translateRepositoryError(err)
	}
	s.publish(ctx, events)
	return result, nil
}

func (s *GuideService) SaveGuideDraft(ctx context.Context, command SaveGuideDraftCommand) (GuideSaved, error) {
	if err := validateActorRole(command.Meta.Actor, domain.RoleFamily); err != nil {
		return GuideSaved{}, err
	}
	if command.ExpectedRevision < 1 {
		return GuideSaved{}, domain.NewError(domain.CodeValidationError, "expectedRevisionが不正")
	}
	hash, err := domain.HashCanonicalJSON(struct {
		ExpectedRevision int64 `json:"expectedRevision"`
	}{command.ExpectedRevision})
	if err != nil {
		return GuideSaved{}, err
	}
	result := storedEnvelope[GuideSaved]{}
	path := "/v1/guide-drafts/" + string(command.DraftID) + "/save"
	_, events, err := s.idempotent(ctx, command.Meta, path, hash, 201, &result, func(tx repository.GuideTx) ([]domain.Event, error) {
		unlockedSession, err := tx.GetSessionByDraft(ctx, command.DraftID)
		if err != nil {
			return nil, err
		}
		session, err := tx.GetSession(ctx, unlockedSession.ID, true)
		if err != nil {
			return nil, err
		}
		if err := pairForSession(session).Authorize(command.Meta.Actor, domain.RoleFamily); err != nil {
			return nil, err
		}
		if session.GuideMaterialBatchID != nil {
			if _, err := tx.GetBatch(ctx, *session.GuideMaterialBatchID, true); err != nil {
				return nil, err
			}
		}
		if session.GuideGenerationJobID != nil {
			if _, err := tx.GetJob(ctx, *session.GuideGenerationJobID, true); err != nil {
				return nil, err
			}
		}
		draft, err := tx.GetDraft(ctx, command.DraftID, true)
		if err != nil {
			return nil, err
		}
		if err := pairForSession(session).Authorize(command.Meta.Actor, domain.RoleFamily); err != nil {
			return nil, err
		}
		if err := checkRevision(draft.Revision, command.ExpectedRevision); err != nil {
			return nil, err
		}
		if session.GuideMaterialBatchID == nil || session.GuideGenerationJobID == nil || session.Status != domain.SupportSessionReviewingGuide || session.GuideDraftID == nil || *session.GuideDraftID != draft.ID || draft.Status != domain.GuideDraftEditing {
			return nil, domain.NewError(domain.CodeInvalidState, "下書きを保存できない")
		}
		batchID, jobID := *session.GuideMaterialBatchID, *session.GuideGenerationJobID
		allowed, err := tx.ListAllowedDraftArtifacts(ctx, session.ID)
		if err != nil {
			return nil, err
		}
		if err := domain.ValidateGuideDraftContent(draft.Title, draft.Steps, allowed); err != nil {
			return nil, err
		}
		now := s.now()
		guide := domain.Guide{ID: s.newID("guide_"), UserID: session.UserID, Title: draft.Title, CurrentVersionNumber: 1, CreatedAt: now, UpdatedAt: now, Revision: 1}
		guide, err = tx.CreateGuide(ctx, guide)
		if err != nil {
			return nil, err
		}
		version := domain.GuideVersion{GuideID: guide.ID, VersionNumber: 1, Title: guide.Title, CreatedBy: command.Meta.Actor.ID, CreatedAt: now, Steps: append([]domain.GuideStep(nil), draft.Steps...)}
		if _, err := tx.CreateGuideVersion(ctx, version); err != nil {
			return nil, err
		}
		used := make([]domain.ID, 0, len(draft.Steps))
		seen := make(map[domain.ID]struct{})
		for _, step := range draft.Steps {
			if _, err := tx.CreateGuideVersionStep(ctx, guide.ID, step); err != nil {
				return nil, err
			}
			if _, ok := seen[step.ArtifactID]; !ok {
				seen[step.ArtifactID] = struct{}{}
				used = append(used, step.ArtifactID)
			}
			if err := tx.PromoteArtifact(ctx, step.ArtifactID, timestamp(now)); err != nil {
				return nil, err
			}
		}
		unused, err := tx.ListUnusedArtifacts(ctx, session.ID, used)
		if err != nil {
			return nil, err
		}
		for _, artifact := range unused {
			id := artifact.ID
			if err := tx.CreateDeletionTask(ctx, domain.ArtifactDeletionTask{ID: s.newID("delete_"), ArtifactID: &id, StorageKey: artifact.StorageKey, Status: domain.ArtifactDeletionPending, NextAttemptAt: now, CreatedAt: now}); err != nil {
				return nil, err
			}
		}
		draft, err = tx.SaveDraft(ctx, draft.ID, timestamp(now))
		if err != nil {
			return nil, err
		}
		session, err = tx.SaveGuideInSession(ctx, session.ID, guide.ID, timestamp(now))
		if err != nil {
			return nil, err
		}
		if err := tx.DeleteGenerationJob(ctx, jobID); err != nil {
			return nil, err
		}
		if err := tx.DeleteMaterials(ctx, batchID); err != nil {
			return nil, err
		}
		if err := tx.DeleteBatch(ctx, batchID); err != nil {
			return nil, err
		}
		detail := domain.GuideDetail{Guide: guide, RepresentativeArtifactID: draft.Steps[0].ArtifactID, CurrentVersion: version}
		result.Data = GuideSaved{Guide: detail, SupportSession: session}
		pair := pairForSession(session)
		return []domain.Event{s.event(domain.EventGuideDraftUpdated, draft.ID, draft.Revision, draft, pair), s.event(domain.EventGuideCreated, guide.ID, guide.Revision, detail, pair), s.event(domain.EventSupportSessionUpdated, session.ID, session.Revision, session, pair)}, nil
	})
	if err != nil {
		return GuideSaved{}, err
	}
	s.publish(ctx, events)
	return result.Data, nil
}

func (s *GuideService) ListGuides(ctx context.Context, actor domain.Actor) ([]domain.GuideSummary, error) {
	if err := validateActorRole(actor, domain.RoleUser); err != nil {
		return nil, err
	}
	var result []domain.GuideSummary
	err := s.store.WithinTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx repository.GuideTx) error {
		var err error
		result, err = tx.ListGuides(ctx, actor.ID)
		return err
	})
	if err != nil {
		return nil, translateRepositoryError(err)
	}
	if result == nil {
		result = []domain.GuideSummary{}
	}
	return result, nil
}

func (s *GuideService) GetGuide(ctx context.Context, actor domain.Actor, id domain.ID) (domain.GuideDetail, error) {
	if err := validateActorRole(actor, domain.RoleUser); err != nil {
		return domain.GuideDetail{}, err
	}
	var result domain.GuideDetail
	err := s.store.WithinTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx repository.GuideTx) error {
		var err error
		result, err = tx.GetGuide(ctx, id)
		if err != nil {
			return err
		}
		if result.Guide.UserID != actor.ID {
			return domain.NewError(domain.CodeForbidden, "対象のガイドを参照できない")
		}
		return nil
	})
	return result, translateRepositoryErrorOrNil(err)
}

func (s *GuideService) CreateGuideRun(ctx context.Context, command CreateGuideRunCommand) (domain.GuideRun, error) {
	if err := validateActorRole(command.Meta.Actor, domain.RoleUser); err != nil {
		return domain.GuideRun{}, err
	}
	if _, err := domain.NewID(string(command.GuideID)); err != nil {
		return domain.GuideRun{}, err
	}
	hash, err := domain.HashCanonicalJSON(struct {
		GuideID domain.ID `json:"guideId"`
	}{command.GuideID})
	if err != nil {
		return domain.GuideRun{}, err
	}
	result := storedEnvelope[domain.GuideRun]{}
	_, events, err := s.idempotent(ctx, command.Meta, "/v1/guide-runs", hash, 201, &result, func(tx repository.GuideTx) ([]domain.Event, error) {
		guide, err := tx.GetGuide(ctx, command.GuideID)
		if err != nil {
			return nil, err
		}
		if guide.Guide.UserID != command.Meta.Actor.ID {
			return nil, domain.NewError(domain.CodeForbidden, "対象のガイドを利用できない")
		}
		now := s.now()
		run := domain.GuideRun{ID: s.newID("run_"), GuideID: guide.Guide.ID, GuideVersionNumber: guide.Guide.CurrentVersionNumber, UserID: command.Meta.Actor.ID, Status: domain.GuideRunInProgress, CurrentStepNumber: 1, StartedAt: now, UpdatedAt: now, Revision: 1}
		run, err = tx.CreateRun(ctx, run)
		if err != nil {
			return nil, err
		}
		result.Data = run
		pair, err := tx.GetPair(ctx, run.UserID)
		if err != nil {
			return nil, err
		}
		return []domain.Event{s.event(domain.EventGuideRunCreated, run.ID, run.Revision, run, pair)}, nil
	})
	if err != nil {
		return domain.GuideRun{}, err
	}
	s.publish(ctx, events)
	return result.Data, nil
}

func (s *GuideService) GetGuideRun(ctx context.Context, actor domain.Actor, id domain.ID) (domain.GuideRun, error) {
	if err := validateActorRole(actor, domain.RoleUser); err != nil {
		return domain.GuideRun{}, err
	}
	var result domain.GuideRun
	err := s.store.WithinTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx repository.GuideTx) error {
		var err error
		result, err = tx.GetRun(ctx, id, false)
		if err != nil {
			return err
		}
		if result.UserID != actor.ID {
			return domain.NewError(domain.CodeForbidden, "対象のガイド利用を参照できない")
		}
		return nil
	})
	return result, translateRepositoryErrorOrNil(err)
}

func (s *GuideService) UpdateGuideRun(ctx context.Context, command UpdateGuideRunCommand) (domain.GuideRun, error) {
	if err := validateActorRole(command.Actor, domain.RoleUser); err != nil {
		return domain.GuideRun{}, err
	}
	if command.ExpectedRevision < 1 || !command.Action.Valid() {
		return domain.GuideRun{}, domain.NewError(domain.CodeValidationError, "ガイド利用更新の入力が不正")
	}
	var result domain.GuideRun
	var events []domain.Event
	err := s.store.WithinTx(ctx, pgx.TxOptions{}, func(tx repository.GuideTx) error {
		unlockedRun, err := tx.GetRun(ctx, command.RunID, false)
		if err != nil {
			return err
		}
		if unlockedRun.UserID != command.Actor.ID {
			return domain.NewError(domain.CodeForbidden, "対象のガイド利用を更新できない")
		}
		if err := tx.LockUser(ctx, unlockedRun.UserID); err != nil {
			return err
		}
		run, err := tx.GetRun(ctx, command.RunID, true)
		if err != nil {
			return err
		}
		if err := checkRevision(run.Revision, command.ExpectedRevision); err != nil {
			return err
		}
		if run.Status != domain.GuideRunInProgress {
			return domain.NewError(domain.CodeInvalidState, "ガイド利用を更新できない")
		}
		count, err := tx.GetStepCount(ctx, run.GuideID, run.GuideVersionNumber)
		if err != nil {
			return err
		}
		next, err := domain.MoveGuideStep(run.CurrentStepNumber, count, command.Action)
		if err != nil {
			return err
		}
		result, err = tx.MoveRun(ctx, run.ID, next, timestamp(s.now()))
		if err != nil {
			return err
		}
		pair, err := tx.GetPair(ctx, result.UserID)
		if err != nil {
			return err
		}
		events = []domain.Event{s.event(domain.EventGuideRunUpdated, result.ID, result.Revision, result, pair)}
		return nil
	})
	if err != nil {
		return domain.GuideRun{}, translateRepositoryError(err)
	}
	s.publish(ctx, events)
	return result, nil
}

func (s *GuideService) CompleteGuideRun(ctx context.Context, command CompleteGuideRunCommand) (domain.GuideRun, error) {
	if err := validateActorRole(command.Meta.Actor, domain.RoleUser); err != nil {
		return domain.GuideRun{}, err
	}
	if command.ExpectedRevision < 1 {
		return domain.GuideRun{}, domain.NewError(domain.CodeValidationError, "expectedRevisionが不正")
	}
	hash, err := domain.HashCanonicalJSON(struct {
		ExpectedRevision int64 `json:"expectedRevision"`
	}{command.ExpectedRevision})
	if err != nil {
		return domain.GuideRun{}, err
	}
	result := storedEnvelope[domain.GuideRun]{}
	path := "/v1/guide-runs/" + string(command.RunID) + "/complete"
	_, events, err := s.idempotent(ctx, command.Meta, path, hash, 200, &result, func(tx repository.GuideTx) ([]domain.Event, error) {
		unlockedRun, err := tx.GetRun(ctx, command.RunID, false)
		if err != nil {
			return nil, err
		}
		if unlockedRun.UserID != command.Meta.Actor.ID {
			return nil, domain.NewError(domain.CodeForbidden, "対象のガイド利用を完了できない")
		}
		if err := tx.LockUser(ctx, unlockedRun.UserID); err != nil {
			return nil, err
		}
		run, err := tx.GetRun(ctx, command.RunID, true)
		if err != nil {
			return nil, err
		}
		if err := checkRevision(run.Revision, command.ExpectedRevision); err != nil {
			return nil, err
		}
		if run.Status != domain.GuideRunInProgress {
			return nil, domain.NewError(domain.CodeInvalidState, "ガイド利用を完了できない")
		}
		count, err := tx.GetStepCount(ctx, run.GuideID, run.GuideVersionNumber)
		if err != nil {
			return nil, err
		}
		if !domain.CanCompleteGuideRun(run.CurrentStepNumber, count) {
			return nil, domain.NewError(domain.CodeInvalidState, "最終ステップ以外では完了できない")
		}
		run, err = tx.CompleteRun(ctx, run.ID, timestamp(s.now()))
		if err != nil {
			return nil, err
		}
		result.Data = run
		pair, err := tx.GetPair(ctx, run.UserID)
		if err != nil {
			return nil, err
		}
		return []domain.Event{s.event(domain.EventGuideRunUpdated, run.ID, run.Revision, run, pair)}, nil
	})
	if err != nil {
		return domain.GuideRun{}, err
	}
	s.publish(ctx, events)
	return result.Data, nil
}

func (s *GuideService) CreateSupportRequestFromGuideRun(ctx context.Context, command CreateSupportRequestFromGuideRunCommand) (GuideRunSupportRequestCreated, error) {
	if err := validateActorRole(command.Meta.Actor, domain.RoleUser); err != nil {
		return GuideRunSupportRequestCreated{}, err
	}
	if command.ExpectedRevision < 1 {
		return GuideRunSupportRequestCreated{}, domain.NewError(domain.CodeValidationError, "expectedRevisionが不正")
	}
	if err := domain.ValidateText(command.Comment, 0, 500, false); err != nil {
		return GuideRunSupportRequestCreated{}, err
	}
	if _, err := domain.NewID(string(command.InitialScreenshotArtifactID)); err != nil {
		return GuideRunSupportRequestCreated{}, err
	}
	hash, err := domain.HashCanonicalJSON(struct {
		ExpectedRevision            int64     `json:"expectedRevision"`
		InitialScreenshotArtifactID domain.ID `json:"initialScreenshotArtifactId"`
		Comment                     string    `json:"comment"`
	}{command.ExpectedRevision, command.InitialScreenshotArtifactID, command.Comment})
	if err != nil {
		return GuideRunSupportRequestCreated{}, err
	}
	result := storedEnvelope[GuideRunSupportRequestCreated]{}
	path := "/v1/guide-runs/" + string(command.RunID) + "/support-request"
	_, events, err := s.idempotent(ctx, command.Meta, path, hash, 201, &result, func(tx repository.GuideTx) ([]domain.Event, error) {
		unlockedRun, err := tx.GetRun(ctx, command.RunID, false)
		if err != nil {
			return nil, err
		}
		if unlockedRun.UserID != command.Meta.Actor.ID {
			return nil, domain.NewError(domain.CodeForbidden, "対象のガイド利用から依頼できない")
		}
		if err := tx.LockUser(ctx, unlockedRun.UserID); err != nil {
			return nil, err
		}
		run, err := tx.GetRun(ctx, command.RunID, true)
		if err != nil {
			return nil, err
		}
		if err := checkRevision(run.Revision, command.ExpectedRevision); err != nil {
			return nil, err
		}
		if run.Status != domain.GuideRunInProgress {
			return nil, domain.NewError(domain.CodeInvalidState, "現在のガイド利用状態では依頼できない")
		}
		active, err := tx.HasActiveSupportFlow(ctx, run.UserID)
		if err != nil {
			return nil, err
		}
		if active {
			return nil, domain.NewError(domain.CodeDuplicateActiveRequest, "進行中の支援処理がある")
		}
		artifact, err := tx.GetArtifact(ctx, command.InitialScreenshotArtifactID)
		if err != nil {
			return nil, err
		}
		if artifact.OwnerUserID != run.UserID || artifact.Purpose != domain.ArtifactPurposeRequestScreenshot {
			return nil, domain.NewError(domain.CodeForbidden, "支援依頼に画像を利用できない")
		}
		step, err := tx.GetGuideContextStep(ctx, run)
		if err != nil {
			return nil, err
		}
		pair, err := tx.GetPair(ctx, run.UserID)
		if err != nil {
			return nil, err
		}
		now := s.now()
		requestID := s.newID("request_")
		guideContext := &domain.GuideContext{GuideRunID: run.ID, GuideID: run.GuideID, GuideVersionNumber: run.GuideVersionNumber, StepNumber: run.CurrentStepNumber, GuideTitle: step.Title, StepInstruction: step.Instruction, StepArtifactID: step.ArtifactID}
		request := domain.SupportRequest{ID: requestID, UserID: run.UserID, FamilyID: pair.FamilyID, InitialScreenshotArtifactID: artifact.ID, Comment: command.Comment, Status: domain.SupportRequestPending, GuideContext: guideContext, CreatedAt: now, UpdatedAt: now, Revision: 1}
		request, err = tx.CreateSupportRequest(ctx, request)
		if err != nil {
			return nil, err
		}
		run, err = tx.PauseRun(ctx, run.ID, request.ID, timestamp(now))
		if err != nil {
			return nil, err
		}
		result.Data = GuideRunSupportRequestCreated{GuideRun: run, SupportRequest: request}
		return []domain.Event{s.event(domain.EventSupportRequestCreated, request.ID, request.Revision, request, pair), s.event(domain.EventGuideRunUpdated, run.ID, run.Revision, run, pair)}, nil
	})
	if err != nil {
		return GuideRunSupportRequestCreated{}, err
	}
	s.publish(ctx, events)
	return result.Data, nil
}
