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
	"net/http"
	"strings"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/repository"
)

const (
	createArtifactPath       = "/v1/artifacts"
	createSupportRequestPath = "/v1/support-requests"
)

type ArtifactSupportServiceOptions struct {
	Now   func() time.Time
	NewID func(string) (domain.ID, error)
}

type ArtifactSupportService struct {
	store     repository.ArtifactSupportStore
	storage   repository.ObjectStorage
	publisher EventPublisher
	logger    *slog.Logger
	now       func() time.Time
	newID     func(string) (domain.ID, error)
}

func NewArtifactSupportService(
	store repository.ArtifactSupportStore,
	storage repository.ObjectStorage,
	publisher EventPublisher,
	logger *slog.Logger,
	options ArtifactSupportServiceOptions,
) *ArtifactSupportService {
	if logger == nil {
		logger = slog.Default()
	}
	if options.Now == nil {
		options.Now = func() time.Time { return time.Now().UTC() }
	}
	if options.NewID == nil {
		options.NewID = newArtifactSupportID
	}
	return &ArtifactSupportService{
		store: store, storage: storage, publisher: publisher, logger: logger,
		now: options.Now, newID: options.NewID,
	}
}

type CreateArtifactInput struct {
	Purpose    domain.ArtifactPurpose
	CapturedAt time.Time
	File       io.Reader
}

type IdempotentArtifactResult struct {
	Artifact       domain.Artifact
	ResponseStatus int
	ResponseBody   json.RawMessage
	Replayed       bool
}

type ArtifactContent struct {
	Body io.ReadCloser
	Size int64
}

type CreateSupportRequestInput struct {
	InitialScreenshotArtifactID domain.ID
	Comment                     string
	RequestID                   string
}

type IdempotentSupportRequestResult struct {
	SupportRequest *domain.SupportRequest
	ResponseStatus int
	ResponseBody   json.RawMessage
	Replayed       bool
}

func (s *ArtifactSupportService) CreateArtifact(
	ctx context.Context,
	actor domain.Actor,
	rawKey string,
	input CreateArtifactInput,
) (IdempotentArtifactResult, error) {
	if err := requireRole(actor, domain.RoleUser); err != nil {
		return IdempotentArtifactResult{}, err
	}
	pair, err := s.authorizedPair(ctx, actor, domain.RoleUser)
	if err != nil {
		return IdempotentArtifactResult{}, err
	}
	if pair.UserID != actor.ID {
		return IdempotentArtifactResult{}, domain.NewError(domain.CodeForbidden, "画像を登録する権限がない")
	}
	if input.Purpose != domain.ArtifactPurposeRequestScreenshot {
		return IdempotentArtifactResult{}, domain.NewError(domain.CodeValidationError, "purposeが不正")
	}
	if input.CapturedAt.IsZero() {
		return IdempotentArtifactResult{}, domain.NewError(domain.CodeValidationError, "capturedAtが不正")
	}

	imageData, fileHash, width, height, err := validateArtifactJPEG(input.File)
	if err != nil {
		return IdempotentArtifactResult{}, err
	}
	key, err := domain.NewIdempotencyKey(rawKey)
	if err != nil {
		return IdempotentArtifactResult{}, err
	}
	capturedAt := input.CapturedAt.UTC()
	requestHash, err := domain.HashCanonicalMultipart([]domain.MultipartHashPart{
		{Name: "purpose", Value: string(input.Purpose)},
		{Name: "capturedAt", Value: capturedAt.Format(time.RFC3339Nano)},
	}, fileHash)
	if err != nil {
		return IdempotentArtifactResult{}, err
	}
	scope := domain.IdempotencyScope{ActorID: actor.ID, Method: http.MethodPost, Path: createArtifactPath, Key: key}
	proposedID, err := s.newID("art")
	if err != nil {
		return IdempotentArtifactResult{}, internalError("Artifact IDを生成できない", err)
	}
	now := s.now().UTC()
	var claim domain.IdempotencyRecord
	var decision IdempotencyDecision
	err = s.store.WithinTransaction(ctx, func(tx repository.ArtifactSupportTx) error {
		claim, decision, err = acquireIdempotency(ctx, tx, scope, requestHash, &proposedID, now)
		return err
	})
	if err != nil {
		return IdempotentArtifactResult{}, normalizeRepositoryError(err)
	}
	if decision == IdempotencyReplay {
		return artifactReplayResult(claim)
	}
	if claim.ResourceID == nil {
		return IdempotentArtifactResult{}, internalError("Artifact用resourceIdがない", nil)
	}

	artifactID := *claim.ResourceID
	storageKey := domain.ArtifactStorageKey(actor.ID, artifactID)
	if err := s.storage.Put(ctx, storageKey, bytes.NewReader(imageData), int64(len(imageData)), "image/jpeg"); err != nil {
		if !repository.IsStorageOutcomeUnknown(err) {
			releaseErr := s.store.WithinTransaction(ctx, func(tx repository.ArtifactSupportTx) error {
				return tx.ReleaseIdempotency(ctx, scope, s.now().UTC())
			})
			if releaseErr != nil {
				s.logger.WarnContext(ctx, "idempotency lease release failed", "path", scope.Path, "errorCode", "LEASE_RELEASE_FAILED")
			}
		}
		return IdempotentArtifactResult{}, domain.WrapError(
			domain.CodeExternalServiceUnavailable, "画像を保存できない", err,
		)
	}

	var result IdempotentArtifactResult
	err = s.store.WithinTransaction(ctx, func(tx repository.ArtifactSupportTx) error {
		current, found, err := tx.LockIdempotency(ctx, scope)
		if err != nil {
			return err
		}
		if !found {
			return internalError("ArtifactのIdempotencyRecordが見つからない", nil)
		}
		if current.RequestHash != requestHash {
			return domain.NewError(domain.CodeIdempotencyKeyReused, "同じIdempotency-Keyが異なるリクエストに使用されている")
		}
		if current.Status == domain.IdempotencyCompleted {
			result, err = artifactReplayResult(current)
			return err
		}
		if current.ResourceID == nil || *current.ResourceID != artifactID {
			return internalError("Artifact用resourceIdが一致しない", nil)
		}
		createdAt := current.CreatedAt.UTC()
		artifact := domain.Artifact{
			ID: artifactID, OwnerUserID: actor.ID, Purpose: input.Purpose, MimeType: "image/jpeg",
			StorageKey: storageKey, SHA256: string(fileHash), ByteSize: int64(len(imageData)),
			Width: width, Height: height, CapturedAt: capturedAt, CreatedAt: createdAt,
			UpdatedAt: createdAt, Revision: 1,
		}
		artifact, err = tx.CreateArtifact(ctx, artifact)
		if err != nil {
			return err
		}
		body, err := encodeArtifactResponse(artifact)
		if err != nil {
			return err
		}
		if _, completed, err := tx.CompleteIdempotency(ctx, scope, http.StatusCreated, body, s.now().UTC()); err != nil {
			return err
		} else if !completed {
			return internalError("ArtifactのIdempotencyRecordを完了できない", nil)
		}
		result = IdempotentArtifactResult{
			Artifact: artifact, ResponseStatus: http.StatusCreated, ResponseBody: body,
		}
		return nil
	})
	if err != nil {
		return IdempotentArtifactResult{}, normalizeRepositoryError(err)
	}
	return result, nil
}

func (s *ArtifactSupportService) GetArtifactContent(
	ctx context.Context,
	actor domain.Actor,
	id domain.ID,
) (ArtifactContent, error) {
	if err := requireAnyRole(actor); err != nil {
		return ArtifactContent{}, err
	}
	if _, err := domain.NewID(string(id)); err != nil {
		return ArtifactContent{}, err
	}
	pair, err := s.authorizedPair(ctx, actor, domain.RoleUser, domain.RoleFamily)
	if err != nil {
		return ArtifactContent{}, err
	}
	artifact, found, err := s.store.GetAvailableArtifact(ctx, id)
	if err != nil {
		return ArtifactContent{}, normalizeRepositoryError(err)
	}
	if !found {
		return ArtifactContent{}, domain.NewError(domain.CodeNotFound, "画像が見つからない")
	}
	if artifact.OwnerUserID != pair.UserID {
		return ArtifactContent{}, domain.NewError(domain.CodeForbidden, "画像を取得する権限がない")
	}
	object, err := s.storage.Get(ctx, artifact.StorageKey)
	if err != nil {
		return ArtifactContent{}, domain.WrapError(domain.CodeExternalServiceUnavailable, "画像を取得できない", err)
	}
	if object.Body == nil {
		return ArtifactContent{}, domain.NewError(domain.CodeExternalServiceUnavailable, "保存画像を読み取れない")
	}
	if object.ContentType != "" && !strings.HasPrefix(strings.ToLower(object.ContentType), "image/jpeg") {
		object.Body.Close()
		return ArtifactContent{}, domain.NewError(domain.CodeExternalServiceUnavailable, "保存画像の形式が不正")
	}
	if object.Size >= 0 && object.Size != artifact.ByteSize {
		object.Body.Close()
		return ArtifactContent{}, domain.NewError(domain.CodeExternalServiceUnavailable, "保存画像のサイズが不正")
	}
	return ArtifactContent{Body: object.Body, Size: artifact.ByteSize}, nil
}

func (s *ArtifactSupportService) CreateSupportRequest(
	ctx context.Context,
	actor domain.Actor,
	rawKey string,
	input CreateSupportRequestInput,
) (IdempotentSupportRequestResult, error) {
	if err := requireRole(actor, domain.RoleUser); err != nil {
		return IdempotentSupportRequestResult{}, err
	}
	if _, err := domain.NewID(string(input.InitialScreenshotArtifactID)); err != nil {
		return IdempotentSupportRequestResult{}, err
	}
	if err := domain.ValidateSupportRequestComment(input.Comment); err != nil {
		return IdempotentSupportRequestResult{}, err
	}
	if strings.TrimSpace(input.RequestID) == "" {
		return IdempotentSupportRequestResult{}, internalError("requestIdがない", nil)
	}
	key, err := domain.NewIdempotencyKey(rawKey)
	if err != nil {
		return IdempotentSupportRequestResult{}, err
	}
	normalized := struct {
		InitialScreenshotArtifactID string `json:"initialScreenshotArtifactId"`
		Comment                     string `json:"comment"`
	}{string(input.InitialScreenshotArtifactID), input.Comment}
	requestHash, err := domain.HashCanonicalJSON(normalized)
	if err != nil {
		return IdempotentSupportRequestResult{}, err
	}
	scope := domain.IdempotencyScope{ActorID: actor.ID, Method: http.MethodPost, Path: createSupportRequestPath, Key: key}
	requestID, err := s.newID("request")
	if err != nil {
		return IdempotentSupportRequestResult{}, internalError("SupportRequest IDを生成できない", err)
	}
	eventID, eventIDErr := s.newID("evt")
	now := s.now().UTC()
	var result IdempotentSupportRequestResult
	created := false
	err = s.store.WithinTransaction(ctx, func(tx repository.ArtifactSupportTx) error {
		claim, decision, err := acquireIdempotency(ctx, tx, scope, requestHash, nil, now)
		if err != nil {
			return err
		}
		if decision == IdempotencyReplay {
			result, err = supportRequestReplayResult(claim)
			return err
		}

		user, found, err := tx.LockUser(ctx, actor.ID)
		if err != nil {
			return err
		}
		if !found || user.Role != domain.RoleUser {
			return domain.NewError(domain.CodeForbidden, "支援依頼を作成する権限がない")
		}
		pair, found, err := tx.GetUserPair(ctx, actor.ID)
		if err != nil {
			return err
		}
		if !found {
			return domain.NewError(domain.CodeForbidden, "支援ペアが見つからない")
		}
		if err := pair.Authorize(actor, domain.RoleUser); err != nil {
			return err
		}
		active, err := tx.HasActiveSupportRequest(ctx, pair.UserID)
		if err != nil {
			return err
		}
		if active {
			return completeSupportRequestBusinessError(ctx, tx, scope, input.RequestID,
				domain.NewError(domain.CodeDuplicateActiveRequest, "進行中の支援依頼がある"), s.now().UTC(), &result)
		}
		openSession, err := tx.HasOpenSupportSession(ctx, pair.UserID)
		if err != nil {
			return err
		}
		if openSession {
			return completeSupportRequestBusinessError(ctx, tx, scope, input.RequestID,
				domain.NewError(domain.CodeDuplicateActiveRequest, "未終了の支援セッションがある"), s.now().UTC(), &result)
		}
		artifact, found, err := tx.LockAvailableArtifact(ctx, input.InitialScreenshotArtifactID)
		if err != nil {
			return err
		}
		if !found {
			return completeSupportRequestBusinessError(ctx, tx, scope, input.RequestID,
				domain.NewError(domain.CodeNotFound, "初期スクリーンショットが見つからない"), s.now().UTC(), &result)
		}
		deletionReserved, err := tx.HasArtifactDeletionTask(ctx, artifact.StorageKey)
		if err != nil {
			return err
		}
		if deletionReserved {
			return completeSupportRequestBusinessError(ctx, tx, scope, input.RequestID,
				domain.NewError(domain.CodeNotFound, "初期スクリーンショットが見つからない"), s.now().UTC(), &result)
		}
		if artifact.OwnerUserID != pair.UserID {
			return domain.NewError(domain.CodeForbidden, "画像を使用する権限がない")
		}
		if artifact.Purpose != domain.ArtifactPurposeRequestScreenshot {
			return completeSupportRequestBusinessError(ctx, tx, scope, input.RequestID,
				domain.NewError(domain.CodeValidationError, "支援依頼用画像を指定する"), s.now().UTC(), &result)
		}

		request := domain.SupportRequest{
			ID: requestID, UserID: pair.UserID, FamilyID: pair.FamilyID,
			InitialScreenshotArtifactID: artifact.ID, Comment: input.Comment,
			Status: domain.SupportRequestPending, CreatedAt: now, UpdatedAt: now, Revision: 1,
		}
		request, err = tx.CreateSupportRequest(ctx, request)
		if err != nil {
			return err
		}
		body, err := encodeSupportRequestResponse(request)
		if err != nil {
			return err
		}
		if _, completed, err := tx.CompleteIdempotency(ctx, scope, http.StatusCreated, body, s.now().UTC()); err != nil {
			return err
		} else if !completed {
			return internalError("SupportRequestのIdempotencyRecordを完了できない", nil)
		}
		result = IdempotentSupportRequestResult{
			SupportRequest: &request, ResponseStatus: http.StatusCreated, ResponseBody: body,
		}
		created = true
		return nil
	})
	if err != nil {
		return IdempotentSupportRequestResult{}, normalizeRepositoryError(err)
	}
	if created {
		if eventIDErr != nil {
			s.logger.WarnContext(ctx, "support request event ID generation failed", "entityId", requestID, "errorCode", "EVENT_ID_FAILED")
		} else {
			s.publishSupportRequestCreated(ctx, eventID, *result.SupportRequest)
		}
	}
	return result, nil
}

func (s *ArtifactSupportService) ListSupportRequests(
	ctx context.Context,
	actor domain.Actor,
	status *domain.SupportRequestStatus,
) ([]domain.SupportRequest, error) {
	if err := requireAnyRole(actor); err != nil {
		return nil, err
	}
	if status != nil && !status.Valid() {
		return nil, domain.NewError(domain.CodeValidationError, "statusが不正")
	}
	pair, err := s.authorizedPair(ctx, actor, domain.RoleUser, domain.RoleFamily)
	if err != nil {
		return nil, err
	}
	requests, err := s.store.ListSupportRequests(ctx, pair, status)
	if err != nil {
		return nil, normalizeRepositoryError(err)
	}
	if len(requests) > 20 {
		requests = requests[:20]
	}
	return requests, nil
}

func (s *ArtifactSupportService) GetSupportRequest(
	ctx context.Context,
	actor domain.Actor,
	id domain.ID,
) (domain.SupportRequest, error) {
	if err := requireAnyRole(actor); err != nil {
		return domain.SupportRequest{}, err
	}
	if _, err := domain.NewID(string(id)); err != nil {
		return domain.SupportRequest{}, err
	}
	pair, err := s.authorizedPair(ctx, actor, domain.RoleUser, domain.RoleFamily)
	if err != nil {
		return domain.SupportRequest{}, err
	}
	request, found, err := s.store.GetSupportRequest(ctx, id)
	if err != nil {
		return domain.SupportRequest{}, normalizeRepositoryError(err)
	}
	if !found {
		return domain.SupportRequest{}, domain.NewError(domain.CodeNotFound, "支援依頼が見つからない")
	}
	if request.UserID != pair.UserID || request.FamilyID != pair.FamilyID {
		return domain.SupportRequest{}, domain.NewError(domain.CodeForbidden, "支援依頼を取得する権限がない")
	}
	return request, nil
}

func (s *ArtifactSupportService) authorizedPair(
	ctx context.Context,
	actor domain.Actor,
	roles ...domain.Role,
) (domain.UserPair, error) {
	pair, found, err := s.store.GetUserPair(ctx, actor.ID)
	if err != nil {
		return domain.UserPair{}, normalizeRepositoryError(err)
	}
	if !found {
		return domain.UserPair{}, domain.NewError(domain.CodeForbidden, "支援ペアが見つからない")
	}
	if err := pair.Authorize(actor, roles...); err != nil {
		return domain.UserPair{}, err
	}
	return pair, nil
}

func acquireIdempotency(
	ctx context.Context,
	tx repository.ArtifactSupportTx,
	scope domain.IdempotencyScope,
	hash domain.RequestHash,
	resourceID *domain.ID,
	now time.Time,
) (domain.IdempotencyRecord, IdempotencyDecision, error) {
	proposed, err := NewInProgressIdempotencyRecord(scope, hash, resourceID, now)
	if err != nil {
		return domain.IdempotencyRecord{}, 0, err
	}
	created, err := tx.TryCreateIdempotency(ctx, proposed)
	if err != nil {
		return domain.IdempotencyRecord{}, 0, err
	}
	record, found, err := tx.LockIdempotency(ctx, scope)
	if err != nil {
		return domain.IdempotencyRecord{}, 0, err
	}
	if !found {
		return domain.IdempotencyRecord{}, 0, internalError("IdempotencyRecordが見つからない", nil)
	}
	if created {
		return record, IdempotencyStart, nil
	}
	evaluation, err := EvaluateIdempotency(&record, hash, now)
	if err != nil {
		return domain.IdempotencyRecord{}, 0, err
	}
	if evaluation.Decision != IdempotencyTakeOver {
		return record, evaluation.Decision, nil
	}
	record, taken, err := tx.TakeOverIdempotency(ctx, scope, resourceID, now)
	if err != nil {
		return domain.IdempotencyRecord{}, 0, err
	}
	if !taken {
		return domain.IdempotencyRecord{}, 0, domain.NewError(domain.CodeIdempotencyRequestInProgress, "同じリクエストを処理中")
	}
	return record, IdempotencyTakeOver, nil
}

func completeSupportRequestBusinessError(
	ctx context.Context,
	tx repository.ArtifactSupportTx,
	scope domain.IdempotencyScope,
	requestID string,
	businessErr *domain.Error,
	now time.Time,
	result *IdempotentSupportRequestResult,
) error {
	status := statusForBusinessCode(businessErr.Code)
	body, err := encodeErrorResponse(businessErr, requestID)
	if err != nil {
		return err
	}
	if _, completed, err := tx.CompleteIdempotency(ctx, scope, status, body, now); err != nil {
		return err
	} else if !completed {
		return internalError("業務エラーのIdempotencyRecordを完了できない", nil)
	}
	*result = IdempotentSupportRequestResult{ResponseStatus: status, ResponseBody: body}
	return nil
}

func (s *ArtifactSupportService) publishSupportRequestCreated(ctx context.Context, eventID domain.ID, request domain.SupportRequest) {
	if s.publisher == nil {
		return
	}
	data, err := encodeSupportRequest(request)
	if err != nil {
		s.logger.WarnContext(ctx, "support request event serialization failed", "entityId", request.ID, "errorCode", "EVENT_SERIALIZE_FAILED")
		return
	}
	event := domain.Event{
		EventID: eventID, Type: domain.EventSupportRequestCreated, OccurredAt: request.CreatedAt,
		EntityID: request.ID, Revision: request.Revision, Data: data,
		Audience: domain.UserPair{UserID: request.UserID, FamilyID: request.FamilyID},
	}
	if err := s.publisher.Publish(ctx, event); err != nil {
		s.logger.WarnContext(ctx, "event delivery failed", "eventId", event.EventID, "eventType", event.Type,
			"entityId", event.EntityID, "revision", event.Revision)
	}
}

func validateArtifactJPEG(reader io.Reader) ([]byte, domain.RequestHash, int, int, error) {
	if reader == nil {
		return nil, "", 0, 0, domain.NewError(domain.CodeValidationError, "JPEGファイルが必要")
	}
	data, err := io.ReadAll(io.LimitReader(reader, domain.MaxArtifactBytes+1))
	if err != nil {
		return nil, "", 0, 0, domain.WrapError(domain.CodeValidationError, "JPEGファイルを読み取れない", err)
	}
	if int64(len(data)) > domain.MaxArtifactBytes {
		return nil, "", 0, 0, domain.NewError(domain.CodeFileTooLarge, "JPEGファイルは10MB以下にする")
	}
	if len(data) == 0 {
		return nil, "", 0, 0, domain.NewError(domain.CodeValidationError, "JPEGファイルが空")
	}
	image, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, "", 0, 0, domain.WrapError(domain.CodeValidationError, "有効なJPEGファイルを指定する", err)
	}
	bounds := image.Bounds()
	if bounds.Dx() < 1 || bounds.Dy() < 1 {
		return nil, "", 0, 0, domain.NewError(domain.CodeValidationError, "JPEG画像の寸法が不正")
	}
	digest := sha256.Sum256(data)
	hash, err := domain.NewRequestHash(hex.EncodeToString(digest[:]))
	if err != nil {
		return nil, "", 0, 0, err
	}
	return data, hash, bounds.Dx(), bounds.Dy(), nil
}

type artifactJSON struct {
	ID          string                 `json:"id"`
	OwnerUserID string                 `json:"ownerUserId"`
	Purpose     domain.ArtifactPurpose `json:"purpose"`
	MimeType    string                 `json:"mimeType"`
	SHA256      string                 `json:"sha256"`
	ByteSize    int64                  `json:"byteSize"`
	Width       int                    `json:"width"`
	Height      int                    `json:"height"`
	CapturedAt  time.Time              `json:"capturedAt"`
	ContentURL  string                 `json:"contentUrl"`
	CreatedAt   time.Time              `json:"createdAt"`
	UpdatedAt   time.Time              `json:"updatedAt"`
	Revision    int64                  `json:"revision"`
}

type guideContextJSON struct {
	GuideRunID         string `json:"guideRunId"`
	GuideID            string `json:"guideId"`
	GuideVersionNumber int    `json:"guideVersionNumber"`
	StepNumber         int    `json:"stepNumber"`
	GuideTitle         string `json:"guideTitle"`
	StepInstruction    string `json:"stepInstruction"`
	StepArtifactID     string `json:"stepArtifactId"`
}

type supportRequestJSON struct {
	ID                          string                      `json:"id"`
	UserID                      string                      `json:"userId"`
	FamilyID                    string                      `json:"familyId"`
	InitialScreenshotArtifactID string                      `json:"initialScreenshotArtifactId"`
	Comment                     string                      `json:"comment"`
	Status                      domain.SupportRequestStatus `json:"status"`
	SupportSessionID            *string                     `json:"supportSessionId"`
	GuideContext                *guideContextJSON           `json:"guideContext"`
	CreatedAt                   time.Time                   `json:"createdAt"`
	UpdatedAt                   time.Time                   `json:"updatedAt"`
	Revision                    int64                       `json:"revision"`
}

func encodeArtifactResponse(artifact domain.Artifact) (json.RawMessage, error) {
	payload := struct {
		Data artifactJSON `json:"data"`
	}{Data: artifactToJSON(artifact)}
	return marshalResponse(payload)
}

func encodeSupportRequestResponse(request domain.SupportRequest) (json.RawMessage, error) {
	payload := struct {
		Data supportRequestJSON `json:"data"`
	}{Data: supportRequestToJSON(request)}
	return marshalResponse(payload)
}

func encodeSupportRequest(request domain.SupportRequest) (json.RawMessage, error) {
	return marshalResponse(supportRequestToJSON(request))
}

func encodeErrorResponse(err *domain.Error, requestID string) (json.RawMessage, error) {
	payload := struct {
		Error struct {
			Code      domain.ErrorCode `json:"code"`
			Message   string           `json:"message"`
			RequestID string           `json:"requestId"`
		} `json:"error"`
	}{}
	payload.Error.Code = err.Code
	payload.Error.Message = err.Message
	payload.Error.RequestID = requestID
	return marshalResponse(payload)
}

func marshalResponse(value any) (json.RawMessage, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return nil, internalError("Idempotency応答を生成できない", err)
	}
	return append(body, '\n'), nil
}

func artifactToJSON(artifact domain.Artifact) artifactJSON {
	return artifactJSON{
		ID: string(artifact.ID), OwnerUserID: string(artifact.OwnerUserID), Purpose: artifact.Purpose,
		MimeType: artifact.MimeType, SHA256: artifact.SHA256, ByteSize: artifact.ByteSize,
		Width: artifact.Width, Height: artifact.Height, CapturedAt: artifact.CapturedAt,
		ContentURL: "/v1/artifacts/" + string(artifact.ID) + "/content",
		CreatedAt:  artifact.CreatedAt, UpdatedAt: artifact.UpdatedAt, Revision: artifact.Revision,
	}
}

func supportRequestToJSON(request domain.SupportRequest) supportRequestJSON {
	var sessionID *string
	if request.SupportSessionID != nil {
		value := string(*request.SupportSessionID)
		sessionID = &value
	}
	var contextValue *guideContextJSON
	if request.GuideContext != nil {
		contextValue = &guideContextJSON{
			GuideRunID: string(request.GuideContext.GuideRunID), GuideID: string(request.GuideContext.GuideID),
			GuideVersionNumber: request.GuideContext.GuideVersionNumber, StepNumber: request.GuideContext.StepNumber,
			GuideTitle: request.GuideContext.GuideTitle, StepInstruction: request.GuideContext.StepInstruction,
			StepArtifactID: string(request.GuideContext.StepArtifactID),
		}
	}
	return supportRequestJSON{
		ID: string(request.ID), UserID: string(request.UserID), FamilyID: string(request.FamilyID),
		InitialScreenshotArtifactID: string(request.InitialScreenshotArtifactID), Comment: request.Comment,
		Status: request.Status, SupportSessionID: sessionID, GuideContext: contextValue,
		CreatedAt: request.CreatedAt, UpdatedAt: request.UpdatedAt, Revision: request.Revision,
	}
}

func artifactReplayResult(record domain.IdempotencyRecord) (IdempotentArtifactResult, error) {
	if record.ResponseStatus == nil || *record.ResponseStatus != http.StatusCreated {
		return IdempotentArtifactResult{}, internalError("Artifactの保存済み応答statusが不正", nil)
	}
	var payload struct {
		Data artifactJSON `json:"data"`
	}
	if err := json.Unmarshal(record.ResponseBody, &payload); err != nil {
		return IdempotentArtifactResult{}, internalError("Artifactの保存済み応答を復元できない", err)
	}
	artifact := domain.Artifact{
		ID: domain.ID(payload.Data.ID), OwnerUserID: domain.ID(payload.Data.OwnerUserID), Purpose: payload.Data.Purpose,
		MimeType: payload.Data.MimeType, StorageKey: domain.ArtifactStorageKey(domain.ID(payload.Data.OwnerUserID), domain.ID(payload.Data.ID)),
		SHA256: payload.Data.SHA256, ByteSize: payload.Data.ByteSize, Width: payload.Data.Width, Height: payload.Data.Height,
		CapturedAt: payload.Data.CapturedAt, CreatedAt: payload.Data.CreatedAt, UpdatedAt: payload.Data.UpdatedAt,
		Revision: payload.Data.Revision,
	}
	if err := artifact.Validate(); err != nil {
		return IdempotentArtifactResult{}, internalError("Artifactの保存済み応答が不正", err)
	}
	return IdempotentArtifactResult{
		Artifact: artifact, ResponseStatus: *record.ResponseStatus,
		ResponseBody: append(json.RawMessage(nil), record.ResponseBody...), Replayed: true,
	}, nil
}

func supportRequestReplayResult(record domain.IdempotencyRecord) (IdempotentSupportRequestResult, error) {
	if record.ResponseStatus == nil || len(record.ResponseBody) == 0 {
		return IdempotentSupportRequestResult{}, internalError("SupportRequestの保存済み応答が不正", nil)
	}
	result := IdempotentSupportRequestResult{
		ResponseStatus: *record.ResponseStatus, ResponseBody: append(json.RawMessage(nil), record.ResponseBody...), Replayed: true,
	}
	if *record.ResponseStatus != http.StatusCreated {
		return result, nil
	}
	var payload struct {
		Data supportRequestJSON `json:"data"`
	}
	if err := json.Unmarshal(record.ResponseBody, &payload); err != nil {
		return IdempotentSupportRequestResult{}, internalError("SupportRequestの保存済み応答を復元できない", err)
	}
	request := supportRequestFromJSON(payload.Data)
	if err := request.Validate(); err != nil {
		return IdempotentSupportRequestResult{}, internalError("SupportRequestの保存済み応答が不正", err)
	}
	result.SupportRequest = &request
	return result, nil
}

func supportRequestFromJSON(value supportRequestJSON) domain.SupportRequest {
	var sessionID *domain.ID
	if value.SupportSessionID != nil {
		id := domain.ID(*value.SupportSessionID)
		sessionID = &id
	}
	var contextValue *domain.GuideContext
	if value.GuideContext != nil {
		contextValue = &domain.GuideContext{
			GuideRunID: domain.ID(value.GuideContext.GuideRunID), GuideID: domain.ID(value.GuideContext.GuideID),
			GuideVersionNumber: value.GuideContext.GuideVersionNumber, StepNumber: value.GuideContext.StepNumber,
			GuideTitle: value.GuideContext.GuideTitle, StepInstruction: value.GuideContext.StepInstruction,
			StepArtifactID: domain.ID(value.GuideContext.StepArtifactID),
		}
	}
	return domain.SupportRequest{
		ID: domain.ID(value.ID), UserID: domain.ID(value.UserID), FamilyID: domain.ID(value.FamilyID),
		InitialScreenshotArtifactID: domain.ID(value.InitialScreenshotArtifactID), Comment: value.Comment,
		Status: value.Status, SupportSessionID: sessionID, GuideContext: contextValue,
		CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt, Revision: value.Revision,
	}
}

func requireAnyRole(actor domain.Actor) error {
	if err := actor.Validate(); err != nil {
		return err
	}
	if actor.Role != domain.RoleUser && actor.Role != domain.RoleFamily {
		return domain.NewError(domain.CodeForbidden, "この役割では実行できない")
	}
	return nil
}

func requireRole(actor domain.Actor, role domain.Role) error {
	if err := requireAnyRole(actor); err != nil {
		return err
	}
	if actor.Role != role {
		return domain.NewError(domain.CodeForbidden, "この役割では実行できない")
	}
	return nil
}

func statusForBusinessCode(code domain.ErrorCode) int {
	switch code {
	case domain.CodeValidationError:
		return http.StatusBadRequest
	case domain.CodeForbidden:
		return http.StatusForbidden
	case domain.CodeNotFound:
		return http.StatusNotFound
	case domain.CodeInvalidState, domain.CodeRevisionConflict, domain.CodeIdempotencyKeyReused,
		domain.CodeIdempotencyRequestInProgress, domain.CodeDuplicateActiveRequest, domain.CodeMaterialConflict:
		return http.StatusConflict
	case domain.CodeFileTooLarge:
		return http.StatusRequestEntityTooLarge
	default:
		return http.StatusInternalServerError
	}
}

func normalizeRepositoryError(err error) error {
	var domainErr *domain.Error
	if errors.As(err, &domainErr) {
		return err
	}
	return internalError("データベース処理に失敗した", err)
}

func internalError(message string, cause error) error {
	if cause == nil {
		return domain.NewError(domain.CodeInternalError, message)
	}
	return domain.WrapError(domain.CodeInternalError, message, cause)
}

func newArtifactSupportID(prefix string) (domain.ID, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return domain.ID(fmt.Sprintf("%s_%s", prefix, hex.EncodeToString(value[:]))), nil
}
