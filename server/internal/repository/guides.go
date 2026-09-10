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

// GuideStore owns PostgreSQL transaction creation for the guide feature.
type GuideStore interface {
	WithinTx(context.Context, pgx.TxOptions, func(GuideTx) error) error
}

// GuideTx exposes persistence primitives only. State validation and transition
// decisions remain in the service layer.
type GuideTx interface {
	GetIdempotency(context.Context, domain.IdempotencyScope) (domain.IdempotencyRecord, bool, error)
	CreateIdempotency(context.Context, domain.IdempotencyRecord) (domain.IdempotencyRecord, error)
	TakeOverIdempotency(context.Context, domain.IdempotencyScope, *domain.ID, domain.RequestHash, pgtype.Timestamptz) (domain.IdempotencyRecord, bool, error)
	CompleteIdempotency(context.Context, domain.IdempotencyScope, int, json.RawMessage, pgtype.Timestamptz) error
	ReleaseIdempotency(context.Context, domain.IdempotencyScope, pgtype.Timestamptz) error

	GetSession(context.Context, domain.ID, bool) (domain.SupportSession, error)
	CreateBatch(context.Context, domain.GuideMaterialBatch) (domain.GuideMaterialBatch, error)
	AttachBatch(context.Context, domain.ID, domain.ID, pgtype.Timestamptz) (domain.SupportSession, error)
	GetBatch(context.Context, domain.ID, bool) (domain.GuideMaterialBatch, error)
	ListMaterials(context.Context, domain.ID) ([]domain.GuideMaterial, error)
	GetMaterialByCaptureID(context.Context, domain.ID, string) (MaterialIdentity, error)
	GetMaterialBySequence(context.Context, domain.ID, int) (MaterialIdentity, error)
	CreateArtifact(context.Context, domain.Artifact) (domain.Artifact, error)
	GetArtifact(context.Context, domain.ID) (domain.Artifact, error)
	CreateMaterial(context.Context, domain.GuideMaterial) (domain.GuideMaterial, error)
	IncrementBatch(context.Context, domain.ID, pgtype.Timestamptz) (domain.GuideMaterialBatch, error)
	CreateDeletionTask(context.Context, domain.ArtifactDeletionTask) error
	GetMaterialManifest(context.Context, domain.ID) (MaterialManifest, error)
	CompleteBatch(context.Context, domain.ID, pgtype.Timestamptz) (domain.GuideMaterialBatch, error)

	CreateJob(context.Context, domain.GuideGenerationJob) (domain.GuideGenerationJob, error)
	AttachJob(context.Context, domain.ID, domain.ID, pgtype.Timestamptz) (domain.SupportSession, error)
	GetJob(context.Context, domain.ID, bool) (domain.GuideGenerationJob, error)
	GetSessionByJob(context.Context, domain.ID) (domain.SupportSession, error)
	RetryJob(context.Context, domain.ID, pgtype.Timestamptz) (domain.GuideGenerationJob, error)
	RecoverJobs(context.Context, pgtype.Timestamptz) ([]domain.GuideGenerationJob, error)
	ClaimJob(context.Context, pgtype.Timestamptz) (domain.GuideGenerationJob, error)
	GetGenerationContext(context.Context, domain.ID) (GenerationContext, error)
	ListGenerationMaterials(context.Context, domain.ID) ([]GenerationMaterial, error)
	CreateDraft(context.Context, domain.GuideDraft) (domain.GuideDraft, error)
	SucceedJob(context.Context, domain.ID, int64, domain.ID, pgtype.Timestamptz) (domain.GuideGenerationJob, error)
	FailJob(context.Context, domain.ID, int64, domain.GuideGenerationErrorCode, pgtype.Timestamptz) (domain.GuideGenerationJob, error)
	ReviewDraft(context.Context, domain.ID, domain.ID, pgtype.Timestamptz) (domain.SupportSession, error)

	ListDrafts(context.Context, domain.ID, bool) ([]domain.GuideDraft, error)
	GetDraft(context.Context, domain.ID, bool) (domain.GuideDraft, error)
	GetSessionByDraft(context.Context, domain.ID) (domain.SupportSession, error)
	ListAllowedDraftArtifacts(context.Context, domain.ID) (map[domain.ID]struct{}, error)
	UpdateDraft(context.Context, domain.ID, string, []domain.GuideStep, pgtype.Timestamptz) (domain.GuideDraft, error)
	CreateGuide(context.Context, domain.Guide) (domain.Guide, error)
	CreateGuideVersion(context.Context, domain.GuideVersion) (domain.GuideVersion, error)
	CreateGuideVersionStep(context.Context, domain.ID, domain.GuideStep) (domain.GuideStep, error)
	PromoteArtifact(context.Context, domain.ID, pgtype.Timestamptz) error
	ListUnusedArtifacts(context.Context, domain.ID, []domain.ID) ([]ArtifactReference, error)
	SaveDraft(context.Context, domain.ID, domain.ID, pgtype.Timestamptz) (domain.GuideDraft, error)
	FinishGuideSession(context.Context, domain.ID, domain.ID, pgtype.Timestamptz) (domain.SupportSession, error)
	DeleteGenerationJob(context.Context, domain.ID) error
	DeleteMaterials(context.Context, domain.ID) error
	DeleteBatch(context.Context, domain.ID) error

	ListGuides(context.Context, domain.ID) ([]domain.GuideSummary, error)
	GetGuide(context.Context, domain.ID) (domain.GuideDetail, error)
	CreateRun(context.Context, domain.GuideRun) (domain.GuideRun, error)
	GetRun(context.Context, domain.ID, bool) (domain.GuideRun, error)
	GetStepCount(context.Context, domain.ID, int) (int, error)
	MoveRun(context.Context, domain.ID, int, pgtype.Timestamptz) (domain.GuideRun, error)
	CompleteRun(context.Context, domain.ID, pgtype.Timestamptz) (domain.GuideRun, error)
	CancelRun(context.Context, domain.ID, pgtype.Timestamptz) (domain.GuideRun, error)
	GetPair(context.Context, domain.ID) (domain.UserPair, error)
	LockUser(context.Context, domain.ID) error
	HasActiveSupportFlow(context.Context, domain.ID) (bool, error)
	GetGuideContextStep(context.Context, domain.GuideRun) (GuideContextStep, error)
	CreateSupportRequest(context.Context, domain.SupportRequest) (domain.SupportRequest, error)
	PauseRun(context.Context, domain.ID, domain.ID, pgtype.Timestamptz) (domain.GuideRun, error)
}

type MaterialIdentity struct {
	Material domain.GuideMaterial
	SHA256   string
}

type MaterialManifest struct {
	MaterialCount  int
	CaptureIDCount int
	MinSequence    int
	MaxSequence    int
	SequenceCount  int
	MinCapturedAt  pgtype.Timestamptz
	MaxCapturedAt  pgtype.Timestamptz
}

type GenerationContext struct {
	JobID                       domain.ID
	BatchID                     domain.ID
	JobRevision                 int64
	SupportSessionID            domain.ID
	SupportRequestID            domain.ID
	UserID                      domain.ID
	FamilyID                    domain.ID
	Comment                     string
	InitialScreenshotArtifactID domain.ID
	InitialStorageKey           string
	InitialCapturedAt           pgtype.Timestamptz
}

type GenerationMaterial struct {
	ArtifactID domain.ID
	Sequence   int
	CapturedAt pgtype.Timestamptz
	StorageKey string
}

type ArtifactReference struct {
	ID         domain.ID
	StorageKey string
}

type GuideContextStep struct {
	Title       string
	Instruction string
	ArtifactID  domain.ID
}

type GuideRepository struct {
	pool *pgxpool.Pool
}

func NewGuideRepository(pool *pgxpool.Pool) *GuideRepository {
	return &GuideRepository{pool: pool}
}

func (r *GuideRepository) WithinTx(ctx context.Context, options pgx.TxOptions, work func(GuideTx) error) error {
	tx, err := r.pool.BeginTx(ctx, options)
	if err != nil {
		return fmt.Errorf("begin guide transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	guideTx := &postgresGuideTx{queries: dbgen.New(tx)}
	if err := work(guideTx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit guide transaction: %w", err)
	}
	return nil
}

type postgresGuideTx struct {
	queries *dbgen.Queries
}

func (t *postgresGuideTx) GetIdempotency(ctx context.Context, scope domain.IdempotencyScope) (domain.IdempotencyRecord, bool, error) {
	locked, err := t.queries.TryLockGuideIdempotencyScope(ctx, dbgen.TryLockGuideIdempotencyScopeParams{
		ActorID: string(scope.ActorID), Method: scope.Method, Path: scope.Path, Key: string(scope.Key),
	})
	if err != nil {
		return domain.IdempotencyRecord{}, false, err
	}
	if !locked {
		return domain.IdempotencyRecord{}, false, domain.NewError(domain.CodeIdempotencyRequestInProgress, "同じリクエストを処理中")
	}
	row, err := t.queries.LockIdempotencyRecord(ctx, dbgen.LockIdempotencyRecordParams{
		ActorID: string(scope.ActorID), Method: scope.Method, Path: scope.Path, Key: string(scope.Key),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.IdempotencyRecord{}, false, nil
	}
	if err != nil {
		return domain.IdempotencyRecord{}, false, err
	}
	value, err := idempotencyRecordFromDB(row)
	return value, true, err
}

func (t *postgresGuideTx) CreateIdempotency(ctx context.Context, record domain.IdempotencyRecord) (domain.IdempotencyRecord, error) {
	row, err := t.queries.CreateIdempotencyRecord(ctx, dbgen.CreateIdempotencyRecordParams{
		ActorID: string(record.Scope.ActorID), Method: record.Scope.Method, Path: record.Scope.Path,
		Key: string(record.Scope.Key), RequestHash: string(record.RequestHash),
		ResourceID: idPointerToString(record.ResourceID), LeaseExpiresAt: requiredTimestamptz(record.LeaseExpiresAt),
		CreatedAt: timestamp(record.CreatedAt),
	})
	if err != nil {
		return domain.IdempotencyRecord{}, err
	}
	return idempotencyRecordFromDB(row)
}

func (t *postgresGuideTx) TakeOverIdempotency(ctx context.Context, scope domain.IdempotencyScope, resourceID *domain.ID, _ domain.RequestHash, now pgtype.Timestamptz) (domain.IdempotencyRecord, bool, error) {
	row, err := t.queries.TakeOverExpiredIdempotencyLease(ctx, dbgen.TakeOverExpiredIdempotencyLeaseParams{
		ActorID: string(scope.ActorID), Method: scope.Method, Path: scope.Path, Key: string(scope.Key),
		NewLeaseExpiresAt: timestamp(now.Time.Add(domain.IdempotencyLease)), ResourceID: idPointerToString(resourceID), Now: now,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.IdempotencyRecord{}, false, nil
	}
	if err != nil {
		return domain.IdempotencyRecord{}, false, err
	}
	value, err := idempotencyRecordFromDB(row)
	return value, true, err
}

func (t *postgresGuideTx) CompleteIdempotency(ctx context.Context, scope domain.IdempotencyScope, status int, body json.RawMessage, now pgtype.Timestamptz) error {
	responseStatus := int32(status)
	_, err := t.queries.CompleteGuideIdempotencyRecord(ctx, dbgen.CompleteGuideIdempotencyRecordParams{
		ActorID: string(scope.ActorID), Method: scope.Method, Path: scope.Path, Key: string(scope.Key),
		ResponseStatus: &responseStatus, ResponseBody: body, CompletedAt: now,
	})
	return err
}

func (t *postgresGuideTx) ReleaseIdempotency(ctx context.Context, scope domain.IdempotencyScope, now pgtype.Timestamptz) error {
	return t.queries.ReleaseIdempotencyLease(ctx, dbgen.ReleaseIdempotencyLeaseParams{
		ActorID: string(scope.ActorID), Method: scope.Method, Path: scope.Path,
		Key: string(scope.Key), ReleasedAt: now,
	})
}

func (t *postgresGuideTx) GetSession(ctx context.Context, id domain.ID, lock bool) (domain.SupportSession, error) {
	var row *dbgen.SupportSession
	var err error
	if lock {
		row, err = t.queries.LockGuideSupportSession(ctx, string(id))
	} else {
		row, err = t.queries.GetGuideSupportSession(ctx, string(id))
	}
	if err != nil {
		return domain.SupportSession{}, err
	}
	return supportSessionFromDB(row)
}

func (t *postgresGuideTx) CreateBatch(ctx context.Context, value domain.GuideMaterialBatch) (domain.GuideMaterialBatch, error) {
	row, err := t.queries.CreateGuideMaterialBatchRow(ctx, dbgen.CreateGuideMaterialBatchRowParams{
		ID: string(value.ID), SupportSessionID: string(value.SupportSessionID),
		CaptureIntervalSeconds: int32(value.CaptureIntervalSeconds), ExpectedItemCount: int32(value.ExpectedItemCount),
		CapturedFrom: timestamp(value.CapturedFrom), CapturedTo: timestamp(value.CapturedTo), CreatedAt: timestamp(value.CreatedAt),
	})
	if err != nil {
		return domain.GuideMaterialBatch{}, err
	}
	return guideBatchFromDB(row), nil
}

func (t *postgresGuideTx) AttachBatch(ctx context.Context, sessionID, batchID domain.ID, now pgtype.Timestamptz) (domain.SupportSession, error) {
	value := string(batchID)
	row, err := t.queries.AttachGuideMaterialBatchToSession(ctx, dbgen.AttachGuideMaterialBatchToSessionParams{BatchID: &value, UpdatedAt: now, SessionID: string(sessionID)})
	if err != nil {
		return domain.SupportSession{}, err
	}
	return supportSessionFromDB(row)
}

func (t *postgresGuideTx) GetBatch(ctx context.Context, id domain.ID, lock bool) (domain.GuideMaterialBatch, error) {
	var row *dbgen.GuideMaterialBatch
	var err error
	if lock {
		row, err = t.queries.LockGuideMaterialBatchRow(ctx, string(id))
	} else {
		row, err = t.queries.GetGuideMaterialBatchRow(ctx, string(id))
	}
	if err != nil {
		return domain.GuideMaterialBatch{}, err
	}
	return guideBatchFromDB(row), nil
}

func (t *postgresGuideTx) ListMaterials(ctx context.Context, batchID domain.ID) ([]domain.GuideMaterial, error) {
	rows, err := t.queries.ListGuideMaterialRows(ctx, string(batchID))
	if err != nil {
		return nil, err
	}
	result := make([]domain.GuideMaterial, 0, len(rows))
	for _, row := range rows {
		result = append(result, guideMaterialFromDB(row))
	}
	return result, nil
}

func (t *postgresGuideTx) GetMaterialByCaptureID(ctx context.Context, batchID domain.ID, captureID string) (MaterialIdentity, error) {
	row, err := t.queries.GetGuideMaterialByCaptureID(ctx, dbgen.GetGuideMaterialByCaptureIDParams{BatchID: string(batchID), ClientCaptureID: captureID})
	if err != nil {
		return MaterialIdentity{}, err
	}
	return MaterialIdentity{Material: domain.GuideMaterial{ID: domain.ID(row.ID), BatchID: domain.ID(row.BatchID), ClientCaptureID: row.ClientCaptureID, ArtifactID: domain.ID(row.ArtifactID), Sequence: int(row.Sequence), CapturedAt: row.CapturedAt.Time, CreatedAt: row.CreatedAt.Time}, SHA256: row.ArtifactSha256}, nil
}

func (t *postgresGuideTx) GetMaterialBySequence(ctx context.Context, batchID domain.ID, sequence int) (MaterialIdentity, error) {
	row, err := t.queries.GetGuideMaterialBySequence(ctx, dbgen.GetGuideMaterialBySequenceParams{BatchID: string(batchID), Sequence: int32(sequence)})
	if err != nil {
		return MaterialIdentity{}, err
	}
	return MaterialIdentity{Material: domain.GuideMaterial{ID: domain.ID(row.ID), BatchID: domain.ID(row.BatchID), ClientCaptureID: row.ClientCaptureID, ArtifactID: domain.ID(row.ArtifactID), Sequence: int(row.Sequence), CapturedAt: row.CapturedAt.Time, CreatedAt: row.CreatedAt.Time}, SHA256: row.ArtifactSha256}, nil
}

func (t *postgresGuideTx) CreateArtifact(ctx context.Context, value domain.Artifact) (domain.Artifact, error) {
	row, err := t.queries.CreateGuideArtifactRow(ctx, dbgen.CreateGuideArtifactRowParams{ID: string(value.ID), OwnerUserID: string(value.OwnerUserID), Purpose: string(value.Purpose), StorageKey: value.StorageKey, Sha256: value.SHA256, ByteSize: value.ByteSize, Width: int32(value.Width), Height: int32(value.Height), CapturedAt: timestamp(value.CapturedAt), CreatedAt: timestamp(value.CreatedAt)})
	if err != nil {
		return domain.Artifact{}, err
	}
	return guideArtifactFromDB(row), nil
}

func (t *postgresGuideTx) GetArtifact(ctx context.Context, id domain.ID) (domain.Artifact, error) {
	row, err := t.queries.GetGuideArtifactRow(ctx, string(id))
	if err != nil {
		return domain.Artifact{}, err
	}
	return guideArtifactFromDB(row), nil
}

func (t *postgresGuideTx) CreateMaterial(ctx context.Context, value domain.GuideMaterial) (domain.GuideMaterial, error) {
	row, err := t.queries.CreateGuideMaterialRow(ctx, dbgen.CreateGuideMaterialRowParams{ID: string(value.ID), BatchID: string(value.BatchID), ClientCaptureID: value.ClientCaptureID, ArtifactID: string(value.ArtifactID), Sequence: int32(value.Sequence), CapturedAt: timestamp(value.CapturedAt), CreatedAt: timestamp(value.CreatedAt)})
	if err != nil {
		return domain.GuideMaterial{}, err
	}
	return guideMaterialFromDB(row), nil
}

func (t *postgresGuideTx) IncrementBatch(ctx context.Context, id domain.ID, now pgtype.Timestamptz) (domain.GuideMaterialBatch, error) {
	row, err := t.queries.IncrementGuideMaterialBatch(ctx, dbgen.IncrementGuideMaterialBatchParams{UpdatedAt: now, ID: string(id)})
	if err != nil {
		return domain.GuideMaterialBatch{}, err
	}
	return guideBatchFromDB(row), nil
}

func (t *postgresGuideTx) CreateDeletionTask(ctx context.Context, value domain.ArtifactDeletionTask) error {
	var artifactID *string
	if value.ArtifactID != nil {
		id := string(*value.ArtifactID)
		artifactID = &id
	}
	return t.queries.CreateGuideArtifactDeletionTask(ctx, dbgen.CreateGuideArtifactDeletionTaskParams{ID: string(value.ID), ArtifactID: artifactID, StorageKey: value.StorageKey, CreatedAt: timestamp(value.CreatedAt)})
}

func (t *postgresGuideTx) GetMaterialManifest(ctx context.Context, batchID domain.ID) (MaterialManifest, error) {
	row, err := t.queries.GetGuideMaterialManifest(ctx, string(batchID))
	if err != nil {
		return MaterialManifest{}, err
	}
	return MaterialManifest{MaterialCount: int(row.MaterialCount), CaptureIDCount: int(row.CaptureIDCount), MinSequence: int(row.MinSequence), MaxSequence: int(row.MaxSequence), SequenceCount: int(row.SequenceCount), MinCapturedAt: row.MinCapturedAt, MaxCapturedAt: row.MaxCapturedAt}, nil
}

func (t *postgresGuideTx) CompleteBatch(ctx context.Context, id domain.ID, now pgtype.Timestamptz) (domain.GuideMaterialBatch, error) {
	row, err := t.queries.CompleteGuideMaterialBatchRow(ctx, dbgen.CompleteGuideMaterialBatchRowParams{CompletedAt: now, ID: string(id)})
	if err != nil {
		return domain.GuideMaterialBatch{}, err
	}
	return guideBatchFromDB(row), nil
}

func (t *postgresGuideTx) CreateJob(ctx context.Context, value domain.GuideGenerationJob) (domain.GuideGenerationJob, error) {
	row, err := t.queries.CreateGuideGenerationJobRow(ctx, dbgen.CreateGuideGenerationJobRowParams{ID: string(value.ID), BatchID: string(value.BatchID), CreatedAt: timestamp(value.CreatedAt)})
	if err != nil {
		return domain.GuideGenerationJob{}, err
	}
	return guideJobFromDB(row), nil
}

func (t *postgresGuideTx) AttachJob(ctx context.Context, sessionID, jobID domain.ID, now pgtype.Timestamptz) (domain.SupportSession, error) {
	id := string(jobID)
	row, err := t.queries.AttachGuideGenerationJobToSession(ctx, dbgen.AttachGuideGenerationJobToSessionParams{JobID: &id, UpdatedAt: now, SessionID: string(sessionID)})
	if err != nil {
		return domain.SupportSession{}, err
	}
	return supportSessionFromDB(row)
}

func (t *postgresGuideTx) GetJob(ctx context.Context, id domain.ID, lock bool) (domain.GuideGenerationJob, error) {
	var row *dbgen.GuideGenerationJob
	var err error
	if lock {
		row, err = t.queries.LockGuideGenerationJobRow(ctx, string(id))
	} else {
		row, err = t.queries.GetGuideGenerationJobRow(ctx, string(id))
	}
	if err != nil {
		return domain.GuideGenerationJob{}, err
	}
	return guideJobFromDB(row), nil
}

func (t *postgresGuideTx) GetSessionByJob(ctx context.Context, id domain.ID) (domain.SupportSession, error) {
	row, err := t.queries.GetGuideSessionByJobID(ctx, string(id))
	if err != nil {
		return domain.SupportSession{}, err
	}
	return supportSessionFromDB(row)
}

func (t *postgresGuideTx) RetryJob(ctx context.Context, id domain.ID, now pgtype.Timestamptz) (domain.GuideGenerationJob, error) {
	row, err := t.queries.RetryGuideGenerationJobRow(ctx, dbgen.RetryGuideGenerationJobRowParams{UpdatedAt: now, ID: string(id)})
	if err != nil {
		return domain.GuideGenerationJob{}, err
	}
	return guideJobFromDB(row), nil
}

func (t *postgresGuideTx) RecoverJobs(ctx context.Context, now pgtype.Timestamptz) ([]domain.GuideGenerationJob, error) {
	rows, err := t.queries.RecoverGuideGenerationJobs(ctx, now)
	if err != nil {
		return nil, err
	}
	result := make([]domain.GuideGenerationJob, 0, len(rows))
	for _, row := range rows {
		result = append(result, guideJobFromDB(row))
	}
	return result, nil
}

func (t *postgresGuideTx) ClaimJob(ctx context.Context, now pgtype.Timestamptz) (domain.GuideGenerationJob, error) {
	row, err := t.queries.ClaimGuideGenerationJob(ctx, now)
	if err != nil {
		return domain.GuideGenerationJob{}, err
	}
	return guideJobFromDB(row), nil
}

func (t *postgresGuideTx) GetGenerationContext(ctx context.Context, id domain.ID) (GenerationContext, error) {
	row, err := t.queries.GetGuideGenerationContext(ctx, string(id))
	if err != nil {
		return GenerationContext{}, err
	}
	return GenerationContext{JobID: domain.ID(row.JobID), BatchID: domain.ID(row.BatchID), JobRevision: row.JobRevision, SupportSessionID: domain.ID(row.SupportSessionID), SupportRequestID: domain.ID(row.SupportRequestID), UserID: domain.ID(row.UserID), FamilyID: domain.ID(row.FamilyID), Comment: row.Comment, InitialScreenshotArtifactID: domain.ID(row.InitialScreenshotArtifactID), InitialStorageKey: row.InitialStorageKey, InitialCapturedAt: row.InitialCapturedAt}, nil
}

func (t *postgresGuideTx) ListGenerationMaterials(ctx context.Context, batchID domain.ID) ([]GenerationMaterial, error) {
	rows, err := t.queries.ListGuideGenerationMaterials(ctx, string(batchID))
	if err != nil {
		return nil, err
	}
	result := make([]GenerationMaterial, 0, len(rows))
	for _, row := range rows {
		result = append(result, GenerationMaterial{ArtifactID: domain.ID(row.ArtifactID), Sequence: int(row.Sequence), CapturedAt: row.CapturedAt, StorageKey: row.StorageKey})
	}
	return result, nil
}

func (t *postgresGuideTx) CreateDraft(ctx context.Context, value domain.GuideDraft) (domain.GuideDraft, error) {
	steps, err := json.Marshal(value.Steps)
	if err != nil {
		return domain.GuideDraft{}, err
	}
	row, err := t.queries.CreateGuideDraftRow(ctx, dbgen.CreateGuideDraftRowParams{Position: int32(max(1, value.Position)), ID: string(value.ID), SupportSessionID: string(value.SupportSessionID), Title: value.Title, Steps: steps, CreatedAt: timestamp(value.CreatedAt)})
	if err != nil {
		return domain.GuideDraft{}, err
	}
	return guideDraftFromDB(row)
}

func (t *postgresGuideTx) SucceedJob(ctx context.Context, id domain.ID, revision int64, draftID domain.ID, now pgtype.Timestamptz) (domain.GuideGenerationJob, error) {
	value := string(draftID)
	row, err := t.queries.SucceedGuideGenerationJob(ctx, dbgen.SucceedGuideGenerationJobParams{GuideDraftID: &value, FinishedAt: now, ID: string(id), ExpectedRevision: revision})
	if err != nil {
		return domain.GuideGenerationJob{}, err
	}
	return guideJobFromDB(row), nil
}

func (t *postgresGuideTx) FailJob(ctx context.Context, id domain.ID, revision int64, code domain.GuideGenerationErrorCode, now pgtype.Timestamptz) (domain.GuideGenerationJob, error) {
	row, err := t.queries.FailGuideGenerationJob(ctx, dbgen.FailGuideGenerationJobParams{ErrorCode: ptrString(string(code)), FinishedAt: now, ID: string(id), ExpectedRevision: revision})
	if err != nil {
		return domain.GuideGenerationJob{}, err
	}
	return guideJobFromDB(row), nil
}

func (t *postgresGuideTx) ReviewDraft(ctx context.Context, sessionID, draftID domain.ID, now pgtype.Timestamptz) (domain.SupportSession, error) {
	value := string(draftID)
	row, err := t.queries.ReviewGuideDraftInSession(ctx, dbgen.ReviewGuideDraftInSessionParams{GuideDraftID: &value, UpdatedAt: now, SessionID: string(sessionID)})
	if err != nil {
		return domain.SupportSession{}, err
	}
	return supportSessionFromDB(row)
}

func (t *postgresGuideTx) GetDraft(ctx context.Context, id domain.ID, lock bool) (domain.GuideDraft, error) {
	var row *dbgen.GuideDraft
	var err error
	if lock {
		row, err = t.queries.LockGuideDraftRow(ctx, string(id))
	} else {
		row, err = t.queries.GetGuideDraftRow(ctx, string(id))
	}
	if err != nil {
		return domain.GuideDraft{}, err
	}
	return guideDraftFromDB(row)
}

func (t *postgresGuideTx) GetSessionByDraft(ctx context.Context, id domain.ID) (domain.SupportSession, error) {
	value := string(id)
	row, err := t.queries.GetGuideSessionByDraftID(ctx, value)
	if err != nil {
		return domain.SupportSession{}, err
	}
	return supportSessionFromDB(row)
}

func (t *postgresGuideTx) ListAllowedDraftArtifacts(ctx context.Context, sessionID domain.ID) (map[domain.ID]struct{}, error) {
	rows, err := t.queries.ListAllowedGuideDraftArtifacts(ctx, string(sessionID))
	if err != nil {
		return nil, err
	}
	result := make(map[domain.ID]struct{}, len(rows))
	for _, id := range rows {
		result[domain.ID(id)] = struct{}{}
	}
	return result, nil
}

func (t *postgresGuideTx) UpdateDraft(ctx context.Context, id domain.ID, title string, steps []domain.GuideStep, now pgtype.Timestamptz) (domain.GuideDraft, error) {
	encoded, err := json.Marshal(steps)
	if err != nil {
		return domain.GuideDraft{}, err
	}
	row, err := t.queries.UpdateGuideDraftRow(ctx, dbgen.UpdateGuideDraftRowParams{Title: title, Steps: encoded, UpdatedAt: now, ID: string(id)})
	if err != nil {
		return domain.GuideDraft{}, err
	}
	return guideDraftFromDB(row)
}

func (t *postgresGuideTx) CreateGuide(ctx context.Context, value domain.Guide) (domain.Guide, error) {
	row, err := t.queries.CreateGuideRow(ctx, dbgen.CreateGuideRowParams{ID: string(value.ID), UserID: string(value.UserID), Title: value.Title, CreatedAt: timestamp(value.CreatedAt)})
	if err != nil {
		return domain.Guide{}, err
	}
	return guideFromDB(row), nil
}

func (t *postgresGuideTx) CreateGuideVersion(ctx context.Context, value domain.GuideVersion) (domain.GuideVersion, error) {
	row, err := t.queries.CreateGuideVersionRow(ctx, dbgen.CreateGuideVersionRowParams{GuideID: string(value.GuideID), Title: value.Title, CreatedBy: string(value.CreatedBy), CreatedAt: timestamp(value.CreatedAt)})
	if err != nil {
		return domain.GuideVersion{}, err
	}
	return guideVersionFromDB(row, nil), nil
}

func (t *postgresGuideTx) CreateGuideVersionStep(ctx context.Context, guideID domain.ID, step domain.GuideStep) (domain.GuideStep, error) {
	row, err := t.queries.CreateGuideVersionStepRow(ctx, dbgen.CreateGuideVersionStepRowParams{GuideID: string(guideID), Position: int32(step.Position), ArtifactID: string(step.ArtifactID), Instruction: step.Instruction})
	if err != nil {
		return domain.GuideStep{}, err
	}
	return domain.GuideStep{Position: int(row.Position), ArtifactID: domain.ID(row.ArtifactID), Instruction: row.Instruction}, nil
}

func (t *postgresGuideTx) PromoteArtifact(ctx context.Context, id domain.ID, now pgtype.Timestamptz) error {
	_, err := t.queries.PromoteGuideArtifact(ctx, dbgen.PromoteGuideArtifactParams{UpdatedAt: now, ID: string(id)})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	return err
}

func (t *postgresGuideTx) ListUnusedArtifacts(ctx context.Context, sessionID domain.ID, used []domain.ID) ([]ArtifactReference, error) {
	values := make([]string, len(used))
	for index, id := range used {
		values[index] = string(id)
	}
	rows, err := t.queries.ListUnusedGuideArtifacts(ctx, dbgen.ListUnusedGuideArtifactsParams{SessionID: string(sessionID), UsedArtifactIds: values})
	if err != nil {
		return nil, err
	}
	result := make([]ArtifactReference, 0, len(rows))
	for _, row := range rows {
		result = append(result, ArtifactReference{ID: domain.ID(row.ID), StorageKey: row.StorageKey})
	}
	return result, nil
}

func (t *postgresGuideTx) SaveDraft(ctx context.Context, id, guideID domain.ID, now pgtype.Timestamptz) (domain.GuideDraft, error) {
	row, err := t.queries.SaveGuideDraftRow(ctx, dbgen.SaveGuideDraftRowParams{GuideID: ptrString(string(guideID)), UpdatedAt: now, ID: string(id)})
	if err != nil {
		return domain.GuideDraft{}, err
	}
	return guideDraftFromDB(row)
}

func (t *postgresGuideTx) FinishGuideSession(ctx context.Context, sessionID, guideID domain.ID, now pgtype.Timestamptz) (domain.SupportSession, error) {
	id := string(guideID)
	row, err := t.queries.FinishGuideSession(ctx, dbgen.FinishGuideSessionParams{GuideID: &id, UpdatedAt: now, ID: string(sessionID)})
	if err != nil {
		return domain.SupportSession{}, err
	}
	return supportSessionFromDB(row)
}

func (t *postgresGuideTx) DeleteGenerationJob(ctx context.Context, id domain.ID) error {
	return t.queries.DeleteGuideGenerationJobByID(ctx, string(id))
}
func (t *postgresGuideTx) DeleteMaterials(ctx context.Context, id domain.ID) error {
	return t.queries.DeleteGuideMaterialsByBatchID(ctx, string(id))
}
func (t *postgresGuideTx) DeleteBatch(ctx context.Context, id domain.ID) error {
	return t.queries.DeleteGuideMaterialBatchByID(ctx, string(id))
}

func (t *postgresGuideTx) ListGuides(ctx context.Context, userID domain.ID) ([]domain.GuideSummary, error) {
	rows, err := t.queries.ListGuideRows(ctx, string(userID))
	if err != nil {
		return nil, err
	}
	result := make([]domain.GuideSummary, 0, len(rows))
	for _, row := range rows {
		result = append(result, domain.GuideSummary{ID: domain.ID(row.ID), Title: row.Title, CurrentVersionNumber: int(row.CurrentVersionNumber), RepresentativeArtifactID: domain.ID(row.RepresentativeArtifactID), UpdatedAt: row.UpdatedAt.Time})
	}
	return result, nil
}

func (t *postgresGuideTx) GetGuide(ctx context.Context, id domain.ID) (domain.GuideDetail, error) {
	row, err := t.queries.GetGuideRow(ctx, string(id))
	if err != nil {
		return domain.GuideDetail{}, err
	}
	steps, err := t.queries.ListGuideVersionSteps(ctx, dbgen.ListGuideVersionStepsParams{GuideID: row.ID, VersionNumber: row.CurrentVersionNumber})
	if err != nil {
		return domain.GuideDetail{}, err
	}
	domainSteps := make([]domain.GuideStep, 0, len(steps))
	for _, step := range steps {
		domainSteps = append(domainSteps, domain.GuideStep{Position: int(step.Position), ArtifactID: domain.ID(step.ArtifactID), Instruction: step.Instruction})
	}
	guide := domain.Guide{ID: domain.ID(row.ID), UserID: domain.ID(row.UserID), Title: row.Title, CurrentVersionNumber: int(row.CurrentVersionNumber), CreatedAt: row.CreatedAt.Time, UpdatedAt: row.UpdatedAt.Time, Revision: row.Revision}
	return domain.GuideDetail{Guide: guide, RepresentativeArtifactID: domain.ID(row.RepresentativeArtifactID), CurrentVersion: domain.GuideVersion{GuideID: guide.ID, VersionNumber: int(row.CurrentVersionNumber), Title: row.VersionTitle, CreatedBy: domain.ID(row.CreatedBy), CreatedAt: row.VersionCreatedAt.Time, Steps: domainSteps}}, nil
}

func (t *postgresGuideTx) CreateRun(ctx context.Context, value domain.GuideRun) (domain.GuideRun, error) {
	row, err := t.queries.CreateGuideRunRow(ctx, dbgen.CreateGuideRunRowParams{ID: string(value.ID), GuideID: string(value.GuideID), GuideVersionNumber: int32(value.GuideVersionNumber), UserID: string(value.UserID), StartedAt: timestamp(value.StartedAt)})
	if err != nil {
		return domain.GuideRun{}, err
	}
	return guideRunFromDB(row), nil
}

func (t *postgresGuideTx) GetRun(ctx context.Context, id domain.ID, lock bool) (domain.GuideRun, error) {
	var row *dbgen.GuideRun
	var err error
	if lock {
		row, err = t.queries.LockGuideRunRow(ctx, string(id))
	} else {
		row, err = t.queries.GetGuideRunRow(ctx, string(id))
	}
	if err != nil {
		return domain.GuideRun{}, err
	}
	return guideRunFromDB(row), nil
}

func (t *postgresGuideTx) GetStepCount(ctx context.Context, guideID domain.ID, version int) (int, error) {
	value, err := t.queries.GetGuideVersionStepCount(ctx, dbgen.GetGuideVersionStepCountParams{GuideID: string(guideID), VersionNumber: int32(version)})
	return int(value), err
}

func (t *postgresGuideTx) MoveRun(ctx context.Context, id domain.ID, step int, now pgtype.Timestamptz) (domain.GuideRun, error) {
	row, err := t.queries.MoveGuideRunRow(ctx, dbgen.MoveGuideRunRowParams{CurrentStepNumber: int32(step), UpdatedAt: now, ID: string(id)})
	if err != nil {
		return domain.GuideRun{}, err
	}
	return guideRunFromDB(row), nil
}

func (t *postgresGuideTx) CompleteRun(ctx context.Context, id domain.ID, now pgtype.Timestamptz) (domain.GuideRun, error) {
	row, err := t.queries.CompleteGuideRunRow(ctx, dbgen.CompleteGuideRunRowParams{CompletedAt: now, ID: string(id)})
	if err != nil {
		return domain.GuideRun{}, err
	}
	return guideRunFromDB(row), nil
}

func (t *postgresGuideTx) GetPair(ctx context.Context, actorID domain.ID) (domain.UserPair, error) {
	row, err := t.queries.GetUserPairByActorID(ctx, string(actorID))
	if err != nil {
		return domain.UserPair{}, err
	}
	return domain.UserPair{UserID: domain.ID(row.UserID), FamilyID: domain.ID(row.FamilyID)}, nil
}

func (t *postgresGuideTx) LockUser(ctx context.Context, id domain.ID) error {
	_, err := t.queries.LockGuideRunOwner(ctx, string(id))
	return err
}
func (t *postgresGuideTx) HasActiveSupportFlow(ctx context.Context, id domain.ID) (bool, error) {
	return t.queries.HasActiveGuideSupportFlow(ctx, string(id))
}

func (t *postgresGuideTx) GetGuideContextStep(ctx context.Context, run domain.GuideRun) (GuideContextStep, error) {
	row, err := t.queries.GetGuideContextStep(ctx, dbgen.GetGuideContextStepParams{VersionNumber: int32(run.GuideVersionNumber), StepNumber: int32(run.CurrentStepNumber), GuideID: string(run.GuideID), UserID: string(run.UserID)})
	if err != nil {
		return GuideContextStep{}, err
	}
	return GuideContextStep{Title: row.GuideTitle, Instruction: row.Instruction, ArtifactID: domain.ID(row.ArtifactID)}, nil
}

func (t *postgresGuideTx) CreateSupportRequest(ctx context.Context, value domain.SupportRequest) (domain.SupportRequest, error) {
	guideContext, err := json.Marshal(value.GuideContext)
	if err != nil {
		return domain.SupportRequest{}, err
	}
	row, err := t.queries.CreateGuideSupportRequest(ctx, dbgen.CreateGuideSupportRequestParams{ID: string(value.ID), UserID: string(value.UserID), FamilyID: string(value.FamilyID), InitialScreenshotArtifactID: string(value.InitialScreenshotArtifactID), Comment: value.Comment, GuideContext: guideContext, CreatedAt: timestamp(value.CreatedAt)})
	if err != nil {
		return domain.SupportRequest{}, err
	}
	return guideSupportRequestFromDB(row)
}

func (t *postgresGuideTx) PauseRun(ctx context.Context, runID, requestID domain.ID, now pgtype.Timestamptz) (domain.GuideRun, error) {
	id := string(requestID)
	row, err := t.queries.PauseGuideRunForSupport(ctx, dbgen.PauseGuideRunForSupportParams{SupportRequestID: &id, PausedAt: now, ID: string(runID)})
	if err != nil {
		return domain.GuideRun{}, err
	}
	return guideRunFromDB(row), nil
}

func timestamp(value time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: value.UTC(), Valid: true}
}

func ptrString(value string) *string { return &value }

func guideArtifactFromDB(row *dbgen.Artifact) domain.Artifact {
	return domain.Artifact{ID: domain.ID(row.ID), OwnerUserID: domain.ID(row.OwnerUserID), Purpose: domain.ArtifactPurpose(row.Purpose), MimeType: row.MimeType, StorageKey: row.StorageKey, SHA256: row.Sha256, ByteSize: row.ByteSize, Width: int(row.Width), Height: int(row.Height), CapturedAt: row.CapturedAt.Time, CreatedAt: row.CreatedAt.Time, UpdatedAt: row.UpdatedAt.Time, Revision: row.Revision}
}

func guideBatchFromDB(row *dbgen.GuideMaterialBatch) domain.GuideMaterialBatch {
	return domain.GuideMaterialBatch{ID: domain.ID(row.ID), SupportSessionID: domain.ID(row.SupportSessionID), Status: domain.GuideMaterialBatchStatus(row.Status), CaptureIntervalSeconds: int(row.CaptureIntervalSeconds), ExpectedItemCount: int(row.ExpectedItemCount), ReceivedItemCount: int(row.ReceivedItemCount), CapturedFrom: row.CapturedFrom.Time, CapturedTo: row.CapturedTo.Time, CompletedAt: optionalTime(row.CompletedAt), CreatedAt: row.CreatedAt.Time, UpdatedAt: row.UpdatedAt.Time, Revision: row.Revision}
}

func guideMaterialFromDB(row *dbgen.GuideMaterial) domain.GuideMaterial {
	return domain.GuideMaterial{ID: domain.ID(row.ID), BatchID: domain.ID(row.BatchID), ClientCaptureID: row.ClientCaptureID, ArtifactID: domain.ID(row.ArtifactID), Sequence: int(row.Sequence), CapturedAt: row.CapturedAt.Time, CreatedAt: row.CreatedAt.Time}
}

func guideJobFromDB(row *dbgen.GuideGenerationJob) domain.GuideGenerationJob {
	var code *domain.GuideGenerationErrorCode
	if row.ErrorCode != nil {
		value := domain.GuideGenerationErrorCode(*row.ErrorCode)
		code = &value
	}
	return domain.GuideGenerationJob{ID: domain.ID(row.ID), BatchID: domain.ID(row.BatchID), Status: domain.GuideGenerationJobStatus(row.Status), Attempt: int(row.Attempt), GuideDraftID: stringPointerToID(row.GuideDraftID), ErrorCode: code, CreatedAt: row.CreatedAt.Time, StartedAt: optionalTime(row.StartedAt), FinishedAt: optionalTime(row.FinishedAt), UpdatedAt: row.UpdatedAt.Time, Revision: row.Revision}
}

func guideDraftFromDB(row *dbgen.GuideDraft) (domain.GuideDraft, error) {
	var steps []domain.GuideStep
	if err := json.Unmarshal(row.Steps, &steps); err != nil {
		return domain.GuideDraft{}, fmt.Errorf("decode guide draft steps: %w", err)
	}
	return domain.GuideDraft{ID: domain.ID(row.ID), SupportSessionID: domain.ID(row.SupportSessionID), Position: int(row.Position), Title: row.Title, Steps: steps, Status: domain.GuideDraftStatus(row.Status), Revision: row.Revision, CreatedAt: row.CreatedAt.Time, UpdatedAt: row.UpdatedAt.Time}, nil
}

func guideFromDB(row *dbgen.Guide) domain.Guide {
	return domain.Guide{ID: domain.ID(row.ID), UserID: domain.ID(row.UserID), Title: row.Title, CurrentVersionNumber: int(row.CurrentVersionNumber), CreatedAt: row.CreatedAt.Time, UpdatedAt: row.UpdatedAt.Time, Revision: row.Revision}
}

func guideVersionFromDB(row *dbgen.GuideVersion, steps []domain.GuideStep) domain.GuideVersion {
	return domain.GuideVersion{GuideID: domain.ID(row.GuideID), VersionNumber: int(row.VersionNumber), Title: row.Title, CreatedBy: domain.ID(row.CreatedBy), CreatedAt: row.CreatedAt.Time, Steps: steps}
}

func guideRunFromDB(row *dbgen.GuideRun) domain.GuideRun {
	return domain.GuideRun{ID: domain.ID(row.ID), GuideID: domain.ID(row.GuideID), GuideVersionNumber: int(row.GuideVersionNumber), UserID: domain.ID(row.UserID), Status: domain.GuideRunStatus(row.Status), CurrentStepNumber: int(row.CurrentStepNumber), SupportRequestID: stringPointerToID(row.SupportRequestID), StartedAt: row.StartedAt.Time, CompletedAt: optionalTime(row.CompletedAt), PausedAt: optionalTime(row.PausedAt), UpdatedAt: row.UpdatedAt.Time, Revision: row.Revision}
}

func guideSupportRequestFromDB(row *dbgen.SupportRequest) (domain.SupportRequest, error) {
	var guideContext *domain.GuideContext
	if len(row.GuideContext) > 0 && string(row.GuideContext) != "null" {
		var value domain.GuideContext
		if err := json.Unmarshal(row.GuideContext, &value); err != nil {
			return domain.SupportRequest{}, fmt.Errorf("decode guide context: %w", err)
		}
		guideContext = &value
	}
	return domain.SupportRequest{ID: domain.ID(row.ID), UserID: domain.ID(row.UserID), FamilyID: domain.ID(row.FamilyID), InitialScreenshotArtifactID: domain.ID(row.InitialScreenshotArtifactID), Comment: row.Comment, Status: domain.SupportRequestStatus(row.Status), SupportSessionID: stringPointerToID(row.SupportSessionID), GuideContext: guideContext, AcknowledgedAt: optionalTime(row.AcknowledgedAt), AcknowledgementKind: stringPointerToAcknowledgementKind(row.AcknowledgementKind), EstimatedSupportAt: optionalTime(row.EstimatedSupportAt), CreatedAt: row.CreatedAt.Time, UpdatedAt: row.UpdatedAt.Time, Revision: row.Revision}, nil
}

func supportSessionFromDB(row *dbgen.SupportSession) (domain.SupportSession, error) {
	var consent *domain.Consent
	if len(row.Consent) > 0 && string(row.Consent) != "null" {
		var value domain.Consent
		if err := json.Unmarshal(row.Consent, &value); err != nil {
			return domain.SupportSession{}, fmt.Errorf("decode consent: %w", err)
		}
		consent = &value
	}
	var decision *domain.GuideDecision
	if row.GuideDecision != nil {
		value := domain.GuideDecision(*row.GuideDecision)
		decision = &value
	}
	var reason *domain.SupportSessionEndReason
	if row.EndReason != nil {
		value := domain.SupportSessionEndReason(*row.EndReason)
		reason = &value
	}
	return domain.SupportSession{ID: domain.ID(row.ID), SupportRequestID: domain.ID(row.SupportRequestID), UserID: domain.ID(row.UserID), FamilyID: domain.ID(row.FamilyID), LiveKitRoomName: row.LivekitRoomName, Status: domain.SupportSessionStatus(row.Status), GuideDecision: decision, GuideMaterialBatchID: stringPointerToID(row.GuideMaterialBatchID), GuideGenerationJobID: stringPointerToID(row.GuideGenerationJobID), GuideDraftID: stringPointerToID(row.GuideDraftID), GuideID: stringPointerToID(row.GuideID), Consent: consent, ConsentedAt: optionalTime(row.ConsentedAt), StartedAt: optionalTime(row.StartedAt), EndedAt: optionalTime(row.EndedAt), EndReason: reason, CreatedAt: row.CreatedAt.Time, UpdatedAt: row.UpdatedAt.Time, Revision: row.Revision}, nil
}

func (t *postgresGuideTx) ListDrafts(ctx context.Context, sessionID domain.ID, lock bool) ([]domain.GuideDraft, error) {
	var rows []*dbgen.GuideDraft
	var err error
	if lock {
		rows, err = t.queries.LockSessionGuideDraftRows(ctx, string(sessionID))
	} else {
		rows, err = t.queries.ListSessionGuideDraftRows(ctx, string(sessionID))
	}
	if err != nil {
		return nil, err
	}
	result := make([]domain.GuideDraft, 0, len(rows))
	for _, row := range rows {
		draft, err := guideDraftFromDB(row)
		if err != nil {
			return nil, err
		}
		result = append(result, draft)
	}
	return result, nil
}

func (t *postgresGuideTx) CancelRun(ctx context.Context, id domain.ID, now pgtype.Timestamptz) (domain.GuideRun, error) {
	row, err := t.queries.CancelGuideRunRow(ctx, dbgen.CancelGuideRunRowParams{UpdatedAt: now, ID: string(id)})
	if err != nil {
		return domain.GuideRun{}, err
	}
	return guideRunFromDB(row), nil
}
