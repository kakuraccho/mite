package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	dbgen "github.com/kakuraccho/mite/server/db/generated"
	"github.com/kakuraccho/mite/server/internal/domain"
)

type CleanupArtifact struct {
	ID         domain.ID
	StorageKey string
}

// SupportSessionTransaction exposes only the persistence operations needed by
// the support-session use cases. State validation remains in service/domain.
type SupportSessionTransaction interface {
	LockRequest(context.Context, domain.ID) (domain.SupportRequest, error)
	LockSession(context.Context, domain.ID) (domain.SupportSession, error)
	CreateSession(context.Context, domain.SupportSession) (domain.SupportSession, error)
	AttachSession(context.Context, domain.ID, domain.ID, time.Time) (domain.SupportRequest, error)
	ActivateRequest(context.Context, domain.ID, time.Time) (domain.SupportRequest, error)
	ActivateSession(context.Context, domain.ID, domain.Consent, time.Time) (domain.SupportSession, error)
	ResolveRequest(context.Context, domain.ID, time.Time) (domain.SupportRequest, error)
	ResolveSession(context.Context, domain.ID, domain.GuideDecision, time.Time) (domain.SupportSession, error)
	GenerationJobStatus(context.Context, domain.ID) (domain.GuideGenerationJobStatus, error)
	CleanupArtifacts(context.Context, domain.ID) ([]CleanupArtifact, error)
	QueueArtifactDeletion(context.Context, domain.ID, CleanupArtifact, time.Time) error
	EndWithoutGuide(context.Context, domain.ID, domain.SupportSessionEndReason, time.Time) (domain.SupportSession, error)
	DeleteGenerationJob(context.Context, domain.ID) error
	DeleteGuideMaterials(context.Context, domain.ID) error
	DeleteGuideMaterialBatch(context.Context, domain.ID) error
	DeleteGuideDraft(context.Context, domain.ID) error
	BeginIdempotency(context.Context, domain.IdempotencyScope, domain.RequestHash, time.Time) (bool, error)
	LockIdempotency(context.Context, domain.IdempotencyScope) (domain.IdempotencyRecord, bool, error)
	TakeOverIdempotency(context.Context, domain.IdempotencyScope, time.Time) (domain.IdempotencyRecord, bool, error)
	CompleteIdempotency(context.Context, domain.IdempotencyScope, int, json.RawMessage, time.Time) error
}

type SupportSessionStore interface {
	GetRequest(context.Context, domain.ID) (domain.SupportRequest, error)
	GetSession(context.Context, domain.ID) (domain.SupportSession, error)
	WithinTransaction(context.Context, func(SupportSessionTransaction) error) error
}

type PostgresSupportSessionStore struct {
	pool *pgxpool.Pool
}

func NewPostgresSupportSessionStore(pool *pgxpool.Pool) *PostgresSupportSessionStore {
	return &PostgresSupportSessionStore{pool: pool}
}

func (s *PostgresSupportSessionStore) GetRequest(ctx context.Context, id domain.ID) (domain.SupportRequest, error) {
	row, err := dbgen.New(s.pool).SessionGetSupportRequest(ctx, string(id))
	if err != nil {
		return domain.SupportRequest{}, sessionRepositoryError("get support request", err)
	}
	return sessionRequestFromDB(row)
}

func (s *PostgresSupportSessionStore) GetSession(ctx context.Context, id domain.ID) (domain.SupportSession, error) {
	row, err := dbgen.New(s.pool).SessionGetSupportSession(ctx, string(id))
	if err != nil {
		return domain.SupportSession{}, sessionRepositoryError("get support session", err)
	}
	return sessionFromDB(row)
}

func (s *PostgresSupportSessionStore) WithinTransaction(
	ctx context.Context,
	work func(SupportSessionTransaction) error,
) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin support session transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := work(&postgresSupportSessionTransaction{queries: dbgen.New(tx)}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit support session transaction: %w", err)
	}
	return nil
}

type postgresSupportSessionTransaction struct {
	queries *dbgen.Queries
}

func (t *postgresSupportSessionTransaction) LockRequest(ctx context.Context, id domain.ID) (domain.SupportRequest, error) {
	row, err := t.queries.SessionLockSupportRequest(ctx, string(id))
	if err != nil {
		return domain.SupportRequest{}, sessionRepositoryError("lock support request", err)
	}
	return sessionRequestFromDB(row)
}

func (t *postgresSupportSessionTransaction) LockSession(ctx context.Context, id domain.ID) (domain.SupportSession, error) {
	row, err := t.queries.SessionLockSupportSession(ctx, string(id))
	if err != nil {
		return domain.SupportSession{}, sessionRepositoryError("lock support session", err)
	}
	return sessionFromDB(row)
}

func (t *postgresSupportSessionTransaction) CreateSession(ctx context.Context, value domain.SupportSession) (domain.SupportSession, error) {
	row, err := t.queries.SessionCreateSupportSession(ctx, dbgen.SessionCreateSupportSessionParams{
		ID:               string(value.ID),
		SupportRequestID: string(value.SupportRequestID),
		UserID:           string(value.UserID),
		FamilyID:         string(value.FamilyID),
		LivekitRoomName:  value.LiveKitRoomName,
		CreatedAt:        pgTimestamp(value.CreatedAt),
	})
	if err != nil {
		return domain.SupportSession{}, fmt.Errorf("create support session: %w", err)
	}
	return sessionFromDB(row)
}

func (t *postgresSupportSessionTransaction) AttachSession(ctx context.Context, requestID, sessionID domain.ID, now time.Time) (domain.SupportRequest, error) {
	value := string(sessionID)
	row, err := t.queries.SessionAttachToSupportRequest(ctx, dbgen.SessionAttachToSupportRequestParams{
		ID: string(requestID), SupportSessionID: &value, UpdatedAt: pgTimestamp(now),
	})
	if err != nil {
		return domain.SupportRequest{}, fmt.Errorf("attach support session: %w", err)
	}
	return sessionRequestFromDB(row)
}

func (t *postgresSupportSessionTransaction) ActivateRequest(ctx context.Context, id domain.ID, now time.Time) (domain.SupportRequest, error) {
	row, err := t.queries.SessionActivateSupportRequest(ctx, dbgen.SessionActivateSupportRequestParams{ID: string(id), UpdatedAt: pgTimestamp(now)})
	if err != nil {
		return domain.SupportRequest{}, fmt.Errorf("activate support request: %w", err)
	}
	return sessionRequestFromDB(row)
}

func (t *postgresSupportSessionTransaction) ActivateSession(ctx context.Context, id domain.ID, consent domain.Consent, now time.Time) (domain.SupportSession, error) {
	encoded, err := json.Marshal(sessionConsentJSON{
		Audio: consent.Audio, ScreenShare: consent.ScreenShare,
		PeriodicCapture: consent.PeriodicCapture, TextVersion: consent.TextVersion,
	})
	if err != nil {
		return domain.SupportSession{}, fmt.Errorf("encode consent: %w", err)
	}
	row, err := t.queries.SessionActivateSupportSession(ctx, dbgen.SessionActivateSupportSessionParams{ID: string(id), Consent: encoded, ConsentedAt: pgTimestamp(now)})
	if err != nil {
		return domain.SupportSession{}, fmt.Errorf("activate support session: %w", err)
	}
	return sessionFromDB(row)
}

func (t *postgresSupportSessionTransaction) ResolveRequest(ctx context.Context, id domain.ID, now time.Time) (domain.SupportRequest, error) {
	row, err := t.queries.SessionResolveSupportRequest(ctx, dbgen.SessionResolveSupportRequestParams{ID: string(id), UpdatedAt: pgTimestamp(now)})
	if err != nil {
		return domain.SupportRequest{}, fmt.Errorf("resolve support request: %w", err)
	}
	return sessionRequestFromDB(row)
}

func (t *postgresSupportSessionTransaction) ResolveSession(ctx context.Context, id domain.ID, decision domain.GuideDecision, now time.Time) (domain.SupportSession, error) {
	var row *dbgen.SupportSession
	var err error
	if decision == domain.GuideDecisionCreate {
		row, err = t.queries.SessionResolveWithGuide(ctx, dbgen.SessionResolveWithGuideParams{ID: string(id), UpdatedAt: pgTimestamp(now)})
	} else {
		row, err = t.queries.SessionResolveWithoutGuide(ctx, dbgen.SessionResolveWithoutGuideParams{ID: string(id), EndedAt: pgTimestamp(now)})
	}
	if err != nil {
		return domain.SupportSession{}, fmt.Errorf("resolve support session: %w", err)
	}
	return sessionFromDB(row)
}

func (t *postgresSupportSessionTransaction) GenerationJobStatus(ctx context.Context, id domain.ID) (domain.GuideGenerationJobStatus, error) {
	status, err := t.queries.SessionGetGenerationJobStatus(ctx, string(id))
	if err != nil {
		return "", sessionRepositoryError("get guide generation job", err)
	}
	return domain.GuideGenerationJobStatus(status), nil
}

func (t *postgresSupportSessionTransaction) CleanupArtifacts(ctx context.Context, batchID domain.ID) ([]CleanupArtifact, error) {
	rows, err := t.queries.SessionListCleanupArtifacts(ctx, string(batchID))
	if err != nil {
		return nil, fmt.Errorf("list support session cleanup artifacts: %w", err)
	}
	result := make([]CleanupArtifact, 0, len(rows))
	for _, row := range rows {
		result = append(result, CleanupArtifact{ID: domain.ID(row.ID), StorageKey: row.StorageKey})
	}
	return result, nil
}

func (t *postgresSupportSessionTransaction) QueueArtifactDeletion(ctx context.Context, taskID domain.ID, artifact CleanupArtifact, now time.Time) error {
	artifactID := string(artifact.ID)
	if err := t.queries.SessionQueueArtifactDeletion(ctx, dbgen.SessionQueueArtifactDeletionParams{
		ID: string(taskID), ArtifactID: &artifactID, StorageKey: artifact.StorageKey, NextAttemptAt: pgTimestamp(now),
	}); err != nil {
		return fmt.Errorf("queue artifact deletion: %w", err)
	}
	return nil
}

func (t *postgresSupportSessionTransaction) EndWithoutGuide(ctx context.Context, id domain.ID, reason domain.SupportSessionEndReason, now time.Time) (domain.SupportSession, error) {
	reasonValue := string(reason)
	row, err := t.queries.SessionEndWithoutGuide(ctx, dbgen.SessionEndWithoutGuideParams{ID: string(id), EndedAt: pgTimestamp(now), EndReason: &reasonValue})
	if err != nil {
		return domain.SupportSession{}, fmt.Errorf("end support session without guide: %w", err)
	}
	return sessionFromDB(row)
}

func (t *postgresSupportSessionTransaction) DeleteGenerationJob(ctx context.Context, id domain.ID) error {
	return t.queries.SessionDeleteGenerationJob(ctx, string(id))
}
func (t *postgresSupportSessionTransaction) DeleteGuideMaterials(ctx context.Context, id domain.ID) error {
	return t.queries.SessionDeleteGuideMaterials(ctx, string(id))
}
func (t *postgresSupportSessionTransaction) DeleteGuideMaterialBatch(ctx context.Context, id domain.ID) error {
	return t.queries.SessionDeleteGuideMaterialBatch(ctx, string(id))
}
func (t *postgresSupportSessionTransaction) DeleteGuideDraft(ctx context.Context, id domain.ID) error {
	return t.queries.SessionDeleteGuideDraft(ctx, string(id))
}

func (t *postgresSupportSessionTransaction) BeginIdempotency(ctx context.Context, scope domain.IdempotencyScope, hash domain.RequestHash, now time.Time) (bool, error) {
	rows, err := t.queries.SessionCreateIdempotencyRecord(ctx, dbgen.SessionCreateIdempotencyRecordParams{
		ActorID: string(scope.ActorID), Path: scope.Path, Key: string(scope.Key), RequestHash: string(hash),
		LeaseExpiresAt: pgTimestamp(now.Add(domain.IdempotencyLease)), CreatedAt: pgTimestamp(now),
	})
	return rows == 1, err
}

func (t *postgresSupportSessionTransaction) LockIdempotency(ctx context.Context, scope domain.IdempotencyScope) (domain.IdempotencyRecord, bool, error) {
	record, err := t.queries.LockIdempotencyRecord(ctx, dbgen.LockIdempotencyRecordParams{
		ActorID: string(scope.ActorID), Method: scope.Method, Path: scope.Path, Key: string(scope.Key),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.IdempotencyRecord{}, false, nil
	}
	if err != nil {
		return domain.IdempotencyRecord{}, false, fmt.Errorf("lock idempotency record: %w", err)
	}
	value, err := idempotencyRecordFromDB(record)
	return value, err == nil, err
}

func (t *postgresSupportSessionTransaction) TakeOverIdempotency(ctx context.Context, scope domain.IdempotencyScope, now time.Time) (domain.IdempotencyRecord, bool, error) {
	record, err := t.queries.TakeOverExpiredIdempotencyLease(ctx, dbgen.TakeOverExpiredIdempotencyLeaseParams{
		ActorID: string(scope.ActorID), Method: scope.Method, Path: scope.Path, Key: string(scope.Key),
		NewLeaseExpiresAt: pgTimestamp(now.Add(domain.IdempotencyLease)), Now: pgTimestamp(now),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.IdempotencyRecord{}, false, nil
	}
	if err != nil {
		return domain.IdempotencyRecord{}, false, fmt.Errorf("take over idempotency record: %w", err)
	}
	value, err := idempotencyRecordFromDB(record)
	return value, err == nil, err
}

func (t *postgresSupportSessionTransaction) CompleteIdempotency(ctx context.Context, scope domain.IdempotencyScope, status int, body json.RawMessage, now time.Time) error {
	responseStatus := int32(status)
	_, err := t.queries.SessionCompleteIdempotencyRecord(ctx, dbgen.SessionCompleteIdempotencyRecordParams{
		ActorID: string(scope.ActorID), Method: scope.Method, Path: scope.Path, Key: string(scope.Key),
		ResponseStatus: &responseStatus, ResponseBody: body, CompletedAt: pgTimestamp(now),
	})
	if err != nil {
		return fmt.Errorf("complete idempotency record: %w", err)
	}
	return nil
}

type sessionConsentJSON struct {
	Audio           bool   `json:"audio"`
	ScreenShare     bool   `json:"screenShare"`
	PeriodicCapture bool   `json:"periodicCapture"`
	TextVersion     string `json:"textVersion"`
}

func sessionRequestFromDB(value *dbgen.SupportRequest) (domain.SupportRequest, error) {
	request := domain.SupportRequest{
		ID: domain.ID(value.ID), UserID: domain.ID(value.UserID), FamilyID: domain.ID(value.FamilyID),
		InitialScreenshotArtifactID: domain.ID(value.InitialScreenshotArtifactID), Comment: value.Comment,
		Status: domain.SupportRequestStatus(value.Status), SupportSessionID: stringPointerToID(value.SupportSessionID),
		CreatedAt: value.CreatedAt.Time, UpdatedAt: value.UpdatedAt.Time, Revision: value.Revision,
	}
	if len(value.GuideContext) > 0 {
		var raw struct {
			GuideRunID         string `json:"guideRunId"`
			GuideID            string `json:"guideId"`
			GuideVersionNumber int    `json:"guideVersionNumber"`
			StepNumber         int    `json:"stepNumber"`
			GuideTitle         string `json:"guideTitle"`
			StepInstruction    string `json:"stepInstruction"`
			StepArtifactID     string `json:"stepArtifactId"`
		}
		if err := json.Unmarshal(value.GuideContext, &raw); err != nil {
			return domain.SupportRequest{}, fmt.Errorf("decode guide context: %w", err)
		}
		request.GuideContext = &domain.GuideContext{GuideRunID: domain.ID(raw.GuideRunID), GuideID: domain.ID(raw.GuideID), GuideVersionNumber: raw.GuideVersionNumber, StepNumber: raw.StepNumber, GuideTitle: raw.GuideTitle, StepInstruction: raw.StepInstruction, StepArtifactID: domain.ID(raw.StepArtifactID)}
	}
	return request, nil
}

func sessionFromDB(value *dbgen.SupportSession) (domain.SupportSession, error) {
	session := domain.SupportSession{
		ID: domain.ID(value.ID), SupportRequestID: domain.ID(value.SupportRequestID), UserID: domain.ID(value.UserID), FamilyID: domain.ID(value.FamilyID),
		LiveKitRoomName: value.LivekitRoomName, Status: domain.SupportSessionStatus(value.Status),
		GuideDecision: stringPointerToGuideDecision(value.GuideDecision), GuideMaterialBatchID: stringPointerToID(value.GuideMaterialBatchID),
		GuideGenerationJobID: stringPointerToID(value.GuideGenerationJobID), GuideDraftID: stringPointerToID(value.GuideDraftID), GuideID: stringPointerToID(value.GuideID),
		ConsentedAt: optionalTime(value.ConsentedAt), StartedAt: optionalTime(value.StartedAt), EndedAt: optionalTime(value.EndedAt),
		EndReason: stringPointerToEndReason(value.EndReason), CreatedAt: value.CreatedAt.Time, UpdatedAt: value.UpdatedAt.Time, Revision: value.Revision,
	}
	if len(value.Consent) > 0 {
		var raw sessionConsentJSON
		if err := json.Unmarshal(value.Consent, &raw); err != nil {
			return domain.SupportSession{}, fmt.Errorf("decode consent: %w", err)
		}
		session.Consent = &domain.Consent{Audio: raw.Audio, ScreenShare: raw.ScreenShare, PeriodicCapture: raw.PeriodicCapture, TextVersion: raw.TextVersion}
	}
	return session, nil
}

func stringPointerToGuideDecision(value *string) *domain.GuideDecision {
	if value == nil {
		return nil
	}
	converted := domain.GuideDecision(*value)
	return &converted
}
func stringPointerToEndReason(value *string) *domain.SupportSessionEndReason {
	if value == nil {
		return nil
	}
	converted := domain.SupportSessionEndReason(*value)
	return &converted
}
func pgTimestamp(value time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: value, Valid: true}
}

func sessionRepositoryError(operation string, err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.NewError(domain.CodeNotFound, "対象が存在しない")
	}
	return fmt.Errorf("%s: %w", operation, err)
}
