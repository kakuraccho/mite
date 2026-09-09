package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	dbgen "github.com/kakuraccho/mite/server/db/generated"
	"github.com/kakuraccho/mite/server/internal/domain"
)

type ExpiredIdempotencyRecord struct {
	Scope      domain.IdempotencyScope
	Status     domain.IdempotencyStatus
	ResourceID *domain.ID
}

// ArtifactSupportStore is the PostgreSQL boundary used by the Artifact and
// SupportRequest use cases. The service owns the transaction scope and row
// lock order through WithinTransaction.
type ArtifactSupportStore interface {
	WithinTransaction(context.Context, func(ArtifactSupportTx) error) error
	GetUserPair(context.Context, domain.ID) (domain.UserPair, bool, error)
	GetAvailableArtifact(context.Context, domain.ID) (domain.Artifact, bool, error)
	GetSupportRequest(context.Context, domain.ID) (domain.SupportRequest, bool, error)
	ListSupportRequests(context.Context, domain.UserPair, *domain.SupportRequestStatus) ([]domain.SupportRequest, error)
}

type ArtifactSupportTx interface {
	TryCreateIdempotency(context.Context, domain.IdempotencyRecord) (bool, error)
	LockIdempotency(context.Context, domain.IdempotencyScope) (domain.IdempotencyRecord, bool, error)
	TakeOverIdempotency(context.Context, domain.IdempotencyScope, *domain.ID, time.Time) (domain.IdempotencyRecord, bool, error)
	ReleaseIdempotency(context.Context, domain.IdempotencyScope, time.Time) error
	CompleteIdempotency(context.Context, domain.IdempotencyScope, int, json.RawMessage, time.Time) (domain.IdempotencyRecord, bool, error)
	LockUser(context.Context, domain.ID) (domain.User, bool, error)
	GetUserPair(context.Context, domain.ID) (domain.UserPair, bool, error)
	LockAvailableArtifact(context.Context, domain.ID) (domain.Artifact, bool, error)
	HasArtifactDeletionTask(context.Context, string) (bool, error)
	ArtifactHasReferences(context.Context, domain.ID) (bool, error)
	CreateArtifact(context.Context, domain.Artifact) (domain.Artifact, error)
	HasActiveSupportRequest(context.Context, domain.ID) (bool, error)
	HasOpenSupportSession(context.Context, domain.ID) (bool, error)
	CreateSupportRequest(context.Context, domain.SupportRequest) (domain.SupportRequest, error)
	LockSupportRequest(context.Context, domain.ID) (domain.SupportRequest, bool, error)
	UpdateSupportRequestAcknowledgement(context.Context, domain.SupportRequest) (domain.SupportRequest, error)
	CancelSupportRequest(context.Context, domain.SupportRequest) (domain.SupportRequest, error)
	ListStaleRequestArtifacts(context.Context, time.Time, int) ([]domain.Artifact, error)
	ListExpiredIdempotency(context.Context, time.Time, int) ([]ExpiredIdempotencyRecord, error)
	CreateArtifactDeletionTask(context.Context, domain.ArtifactDeletionTask) error
	DeleteIdempotency(context.Context, domain.IdempotencyScope) error
	ResetRunningArtifactDeletionTasks(context.Context) (int64, error)
	LockNextArtifactDeletionTask(context.Context, time.Time) (domain.ArtifactDeletionTask, bool, error)
	MarkArtifactDeletionTaskRunning(context.Context, domain.ID) (domain.ArtifactDeletionTask, bool, error)
	RetryArtifactDeletionTask(context.Context, domain.ID, time.Time) error
	DeleteArtifactIfUnreferenced(context.Context, domain.ID) (bool, error)
	DeleteArtifactDeletionTask(context.Context, domain.ID) error
}

type ArtifactSupportRepository struct {
	pool *pgxpool.Pool
}

func NewArtifactSupportRepository(pool *pgxpool.Pool) *ArtifactSupportRepository {
	return &ArtifactSupportRepository{pool: pool}
}

func (r *ArtifactSupportRepository) WithinTransaction(
	ctx context.Context,
	work func(ArtifactSupportTx) error,
) error {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return fmt.Errorf("begin artifact support transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if err := work(&postgresArtifactSupportTx{db: tx, queries: dbgen.New(tx)}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit artifact support transaction: %w", err)
	}
	return nil
}

func (r *ArtifactSupportRepository) GetUserPair(ctx context.Context, actorID domain.ID) (domain.UserPair, bool, error) {
	return getUserPair(ctx, dbgen.New(r.pool), actorID)
}

func (r *ArtifactSupportRepository) GetAvailableArtifact(ctx context.Context, id domain.ID) (domain.Artifact, bool, error) {
	row, err := dbgen.New(r.pool).GetAvailableArtifactByID(ctx, string(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Artifact{}, false, nil
	}
	if err != nil {
		return domain.Artifact{}, false, fmt.Errorf("get available artifact: %w", err)
	}
	artifact, err := artifactSupportArtifactFromDB(row)
	return artifact, true, err
}

func (r *ArtifactSupportRepository) GetSupportRequest(ctx context.Context, id domain.ID) (domain.SupportRequest, bool, error) {
	row, err := dbgen.New(r.pool).GetSupportRequestByID(ctx, string(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.SupportRequest{}, false, nil
	}
	if err != nil {
		return domain.SupportRequest{}, false, fmt.Errorf("get support request: %w", err)
	}
	request, err := artifactSupportRequestFromDB(row)
	return request, true, err
}

func (r *ArtifactSupportRepository) ListSupportRequests(
	ctx context.Context,
	pair domain.UserPair,
	status *domain.SupportRequestStatus,
) ([]domain.SupportRequest, error) {
	var dbStatus *string
	if status != nil {
		value := string(*status)
		dbStatus = &value
	}
	rows, err := dbgen.New(r.pool).ListSupportRequestsForPair(ctx, dbgen.ListSupportRequestsForPairParams{
		UserID: string(pair.UserID), FamilyID: string(pair.FamilyID), Status: dbStatus,
	})
	if err != nil {
		return nil, fmt.Errorf("list support requests: %w", err)
	}
	requests := make([]domain.SupportRequest, 0, len(rows))
	for _, row := range rows {
		request, err := artifactSupportRequestFromDB(row)
		if err != nil {
			return nil, err
		}
		requests = append(requests, request)
	}
	return requests, nil
}

type postgresArtifactSupportTx struct {
	db      dbgen.DBTX
	queries *dbgen.Queries
}

func (t *postgresArtifactSupportTx) TryCreateIdempotency(
	ctx context.Context,
	record domain.IdempotencyRecord,
) (bool, error) {
	if err := record.Validate(); err != nil {
		return false, err
	}
	rows, err := t.queries.InsertArtifactSupportIdempotencyRecordIfAbsent(ctx, dbgen.InsertArtifactSupportIdempotencyRecordIfAbsentParams{
		ActorID: string(record.Scope.ActorID), Method: record.Scope.Method, Path: record.Scope.Path,
		Key: string(record.Scope.Key), RequestHash: string(record.RequestHash),
		ResourceID: idPointerToString(record.ResourceID), LeaseExpiresAt: requiredTimestamptz(record.LeaseExpiresAt),
		CreatedAt: pgtype.Timestamptz{Time: record.CreatedAt, Valid: true},
	})
	if err != nil {
		return false, fmt.Errorf("try create idempotency record: %w", err)
	}
	return rows == 1, nil
}

func (t *postgresArtifactSupportTx) LockIdempotency(
	ctx context.Context,
	scope domain.IdempotencyScope,
) (domain.IdempotencyRecord, bool, error) {
	return NewIdempotencyRepository(t.db).Get(ctx, scope, true)
}

func (t *postgresArtifactSupportTx) TakeOverIdempotency(
	ctx context.Context,
	scope domain.IdempotencyScope,
	resourceID *domain.ID,
	now time.Time,
) (domain.IdempotencyRecord, bool, error) {
	return NewIdempotencyRepository(t.db).TakeOverExpiredLease(ctx, scope, resourceID, now)
}

func (t *postgresArtifactSupportTx) ReleaseIdempotency(ctx context.Context, scope domain.IdempotencyScope, now time.Time) error {
	return NewIdempotencyRepository(t.db).ReleaseLease(ctx, scope, now)
}

func (t *postgresArtifactSupportTx) CompleteIdempotency(
	ctx context.Context,
	scope domain.IdempotencyScope,
	status int,
	body json.RawMessage,
	now time.Time,
) (domain.IdempotencyRecord, bool, error) {
	responseStatus := int32(status)
	row, err := t.queries.CompleteArtifactSupportIdempotencyRecord(ctx, dbgen.CompleteArtifactSupportIdempotencyRecordParams{
		ResponseStatus: &responseStatus,
		ResponseBody:   body,
		CompletedAt:    pgtype.Timestamptz{Time: now, Valid: true},
		ActorID:        string(scope.ActorID),
		Method:         scope.Method,
		Path:           scope.Path,
		Key:            string(scope.Key),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.IdempotencyRecord{}, false, nil
	}
	if err != nil {
		return domain.IdempotencyRecord{}, false, fmt.Errorf("complete artifact support idempotency record: %w", err)
	}
	record, err := idempotencyRecordFromDB(row)
	return record, true, err
}

func (t *postgresArtifactSupportTx) LockUser(ctx context.Context, id domain.ID) (domain.User, bool, error) {
	row, err := t.queries.LockUserByID(ctx, string(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.User{}, false, nil
	}
	if err != nil {
		return domain.User{}, false, fmt.Errorf("lock user: %w", err)
	}
	return domain.User{ID: domain.ID(row.ID), Role: domain.Role(row.Role), DisplayName: row.DisplayName}, true, nil
}

func (t *postgresArtifactSupportTx) GetUserPair(ctx context.Context, actorID domain.ID) (domain.UserPair, bool, error) {
	return getUserPair(ctx, t.queries, actorID)
}

func (t *postgresArtifactSupportTx) LockAvailableArtifact(ctx context.Context, id domain.ID) (domain.Artifact, bool, error) {
	row, err := t.queries.LockAvailableArtifactByID(ctx, string(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Artifact{}, false, nil
	}
	if err != nil {
		return domain.Artifact{}, false, fmt.Errorf("lock artifact: %w", err)
	}
	artifact, err := artifactSupportArtifactFromDB(row)
	return artifact, true, err
}

func (t *postgresArtifactSupportTx) HasArtifactDeletionTask(ctx context.Context, storageKey string) (bool, error) {
	value, err := t.queries.HasArtifactDeletionTask(ctx, storageKey)
	if err != nil {
		return false, fmt.Errorf("check artifact deletion task: %w", err)
	}
	return value, nil
}

func (t *postgresArtifactSupportTx) ArtifactHasReferences(ctx context.Context, id domain.ID) (bool, error) {
	value, err := t.queries.ArtifactHasReferences(ctx, string(id))
	if err != nil {
		return false, fmt.Errorf("check artifact references: %w", err)
	}
	if value == nil {
		return false, domain.NewError(domain.CodeInternalError, "Artifact参照判定が不正")
	}
	return *value, nil
}

func (t *postgresArtifactSupportTx) CreateArtifact(ctx context.Context, artifact domain.Artifact) (domain.Artifact, error) {
	if err := artifact.Validate(); err != nil {
		return domain.Artifact{}, err
	}
	row, err := t.queries.CreateRequestArtifact(ctx, dbgen.CreateRequestArtifactParams{
		ID: string(artifact.ID), OwnerUserID: string(artifact.OwnerUserID), Purpose: string(artifact.Purpose),
		MimeType: artifact.MimeType, StorageKey: artifact.StorageKey, Sha256: artifact.SHA256,
		ByteSize: artifact.ByteSize, Width: int32(artifact.Width), Height: int32(artifact.Height),
		CapturedAt: pgtype.Timestamptz{Time: artifact.CapturedAt, Valid: true},
		CreatedAt:  pgtype.Timestamptz{Time: artifact.CreatedAt, Valid: true},
		UpdatedAt:  pgtype.Timestamptz{Time: artifact.UpdatedAt, Valid: true},
	})
	if err != nil {
		return domain.Artifact{}, fmt.Errorf("create artifact: %w", err)
	}
	return artifactSupportArtifactFromDB(row)
}

func (t *postgresArtifactSupportTx) HasActiveSupportRequest(ctx context.Context, userID domain.ID) (bool, error) {
	value, err := t.queries.HasActiveSupportRequestForUser(ctx, string(userID))
	if err != nil {
		return false, fmt.Errorf("check active support request: %w", err)
	}
	return value, nil
}

func (t *postgresArtifactSupportTx) HasOpenSupportSession(ctx context.Context, userID domain.ID) (bool, error) {
	value, err := t.queries.HasOpenSupportSessionForUser(ctx, string(userID))
	if err != nil {
		return false, fmt.Errorf("check open support session: %w", err)
	}
	return value, nil
}

func (t *postgresArtifactSupportTx) CreateSupportRequest(
	ctx context.Context,
	request domain.SupportRequest,
) (domain.SupportRequest, error) {
	if err := request.Validate(); err != nil {
		return domain.SupportRequest{}, err
	}
	row, err := t.queries.CreateRegularSupportRequest(ctx, dbgen.CreateRegularSupportRequestParams{
		ID: string(request.ID), UserID: string(request.UserID), FamilyID: string(request.FamilyID),
		InitialScreenshotArtifactID: string(request.InitialScreenshotArtifactID), Comment: request.Comment,
		CreatedAt: pgtype.Timestamptz{Time: request.CreatedAt, Valid: true},
		UpdatedAt: pgtype.Timestamptz{Time: request.UpdatedAt, Valid: true},
	})
	if err != nil {
		var postgresError *pgconn.PgError
		if errors.As(err, &postgresError) && postgresError.Code == "23505" &&
			postgresError.ConstraintName == "support_requests_one_active_per_user_key" {
			return domain.SupportRequest{}, domain.NewError(domain.CodeDuplicateActiveRequest, "進行中の支援依頼がある")
		}
		return domain.SupportRequest{}, fmt.Errorf("create support request: %w", err)
	}
	return artifactSupportRequestFromDB(row)
}

func (t *postgresArtifactSupportTx) LockSupportRequest(ctx context.Context, id domain.ID) (domain.SupportRequest, bool, error) {
	row, err := t.queries.LockArtifactSupportRequestByID(ctx, string(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.SupportRequest{}, false, nil
	}
	if err != nil {
		return domain.SupportRequest{}, false, fmt.Errorf("lock support request: %w", err)
	}
	request, err := artifactSupportRequestFromDB(row)
	return request, true, err
}

func (t *postgresArtifactSupportTx) UpdateSupportRequestAcknowledgement(ctx context.Context, request domain.SupportRequest) (domain.SupportRequest, error) {
	row, err := t.queries.UpdateSupportRequestAcknowledgement(ctx, dbgen.UpdateSupportRequestAcknowledgementParams{
		AcknowledgedAt:      requiredTimestamptz(request.AcknowledgedAt),
		AcknowledgementKind: acknowledgementKindPointerToString(request.AcknowledgementKind),
		EstimatedSupportAt:  optionalTimestamptz(request.EstimatedSupportAt),
		UpdatedAt:           pgTimestamp(request.UpdatedAt),
		ID:                  string(request.ID),
	})
	if err != nil {
		return domain.SupportRequest{}, fmt.Errorf("update support request acknowledgement: %w", err)
	}
	return artifactSupportRequestFromDB(row)
}

func (t *postgresArtifactSupportTx) CancelSupportRequest(ctx context.Context, request domain.SupportRequest) (domain.SupportRequest, error) {
	row, err := t.queries.CancelPendingSupportRequest(ctx, dbgen.CancelPendingSupportRequestParams{
		UpdatedAt: pgTimestamp(request.UpdatedAt), ID: string(request.ID),
	})
	if err != nil {
		return domain.SupportRequest{}, fmt.Errorf("cancel support request: %w", err)
	}
	return artifactSupportRequestFromDB(row)
}

func (t *postgresArtifactSupportTx) ListStaleRequestArtifacts(
	ctx context.Context,
	createdBefore time.Time,
	limit int,
) ([]domain.Artifact, error) {
	rows, err := t.queries.ListStaleUnreferencedRequestArtifactsForUpdate(ctx, dbgen.ListStaleUnreferencedRequestArtifactsForUpdateParams{
		CreatedBefore: pgtype.Timestamptz{Time: createdBefore, Valid: true}, BatchLimit: int32(limit),
	})
	if err != nil {
		return nil, fmt.Errorf("list stale request artifacts: %w", err)
	}
	artifacts := make([]domain.Artifact, 0, len(rows))
	for _, row := range rows {
		artifact, err := artifactSupportArtifactFromDB(row)
		if err != nil {
			return nil, err
		}
		artifacts = append(artifacts, artifact)
	}
	return artifacts, nil
}

func (t *postgresArtifactSupportTx) ListExpiredIdempotency(
	ctx context.Context,
	now time.Time,
	limit int,
) ([]ExpiredIdempotencyRecord, error) {
	rows, err := t.queries.ListExpiredArtifactSupportIdempotencyRecordsForUpdate(ctx, dbgen.ListExpiredArtifactSupportIdempotencyRecordsForUpdateParams{
		Now: pgtype.Timestamptz{Time: now, Valid: true}, BatchLimit: int32(limit),
	})
	if err != nil {
		return nil, fmt.Errorf("list expired idempotency records: %w", err)
	}
	records := make([]ExpiredIdempotencyRecord, 0, len(rows))
	for _, row := range rows {
		key, err := domain.NewIdempotencyKey(row.Key)
		if err != nil {
			return nil, err
		}
		records = append(records, ExpiredIdempotencyRecord{
			Scope:  domain.IdempotencyScope{ActorID: domain.ID(row.ActorID), Method: row.Method, Path: row.Path, Key: key},
			Status: domain.IdempotencyStatus(row.Status), ResourceID: stringPointerToID(row.ResourceID),
		})
	}
	return records, nil
}

func (t *postgresArtifactSupportTx) CreateArtifactDeletionTask(
	ctx context.Context,
	task domain.ArtifactDeletionTask,
) error {
	if !task.Status.Valid() || task.Status != domain.ArtifactDeletionPending || task.Attempt != 0 {
		return domain.NewError(domain.CodeInternalError, "削除タスクが不正")
	}
	_, err := t.queries.CreateArtifactDeletionTask(ctx, dbgen.CreateArtifactDeletionTaskParams{
		ID: string(task.ID), ArtifactID: idPointerToString(task.ArtifactID), StorageKey: task.StorageKey,
		NextAttemptAt: pgtype.Timestamptz{Time: task.NextAttemptAt, Valid: true},
		CreatedAt:     pgtype.Timestamptz{Time: task.CreatedAt, Valid: true},
	})
	if err != nil {
		return fmt.Errorf("create artifact deletion task: %w", err)
	}
	return nil
}

func (t *postgresArtifactSupportTx) DeleteIdempotency(ctx context.Context, scope domain.IdempotencyScope) error {
	_, err := t.queries.DeleteArtifactSupportIdempotencyRecord(ctx, dbgen.DeleteArtifactSupportIdempotencyRecordParams{
		ActorID: string(scope.ActorID), Method: scope.Method, Path: scope.Path, Key: string(scope.Key),
	})
	if err != nil {
		return fmt.Errorf("delete idempotency record: %w", err)
	}
	return nil
}

func (t *postgresArtifactSupportTx) ResetRunningArtifactDeletionTasks(ctx context.Context) (int64, error) {
	rows, err := t.queries.ResetRunningArtifactDeletionTasks(ctx)
	if err != nil {
		return 0, fmt.Errorf("reset artifact deletion tasks: %w", err)
	}
	return rows, nil
}

func (t *postgresArtifactSupportTx) LockNextArtifactDeletionTask(
	ctx context.Context,
	now time.Time,
) (domain.ArtifactDeletionTask, bool, error) {
	row, err := t.queries.LockNextArtifactDeletionTask(ctx, pgtype.Timestamptz{Time: now, Valid: true})
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ArtifactDeletionTask{}, false, nil
	}
	if err != nil {
		return domain.ArtifactDeletionTask{}, false, fmt.Errorf("lock artifact deletion task: %w", err)
	}
	task, err := deletionTaskFromDB(row)
	return task, true, err
}

func (t *postgresArtifactSupportTx) MarkArtifactDeletionTaskRunning(
	ctx context.Context,
	id domain.ID,
) (domain.ArtifactDeletionTask, bool, error) {
	row, err := t.queries.MarkArtifactDeletionTaskRunning(ctx, string(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ArtifactDeletionTask{}, false, nil
	}
	if err != nil {
		return domain.ArtifactDeletionTask{}, false, fmt.Errorf("mark artifact deletion task running: %w", err)
	}
	task, err := deletionTaskFromDB(row)
	return task, true, err
}

func (t *postgresArtifactSupportTx) RetryArtifactDeletionTask(ctx context.Context, id domain.ID, next time.Time) error {
	_, err := t.queries.RetryArtifactDeletionTask(ctx, dbgen.RetryArtifactDeletionTaskParams{
		ID: string(id), NextAttemptAt: pgtype.Timestamptz{Time: next, Valid: true},
	})
	if err != nil {
		return fmt.Errorf("retry artifact deletion task: %w", err)
	}
	return nil
}

func (t *postgresArtifactSupportTx) DeleteArtifactIfUnreferenced(ctx context.Context, id domain.ID) (bool, error) {
	rows, err := t.queries.DeleteArtifactIfUnreferenced(ctx, string(id))
	if err != nil {
		return false, fmt.Errorf("delete artifact metadata: %w", err)
	}
	return rows == 1, nil
}

func (t *postgresArtifactSupportTx) DeleteArtifactDeletionTask(ctx context.Context, id domain.ID) error {
	if _, err := t.queries.DeleteArtifactDeletionTask(ctx, string(id)); err != nil {
		return fmt.Errorf("delete artifact deletion task: %w", err)
	}
	return nil
}

func getUserPair(ctx context.Context, queries *dbgen.Queries, actorID domain.ID) (domain.UserPair, bool, error) {
	row, err := queries.GetUserPairByActorID(ctx, string(actorID))
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.UserPair{}, false, nil
	}
	if err != nil {
		return domain.UserPair{}, false, fmt.Errorf("get user pair: %w", err)
	}
	return domain.UserPair{UserID: domain.ID(row.UserID), FamilyID: domain.ID(row.FamilyID)}, true, nil
}

func artifactSupportArtifactFromDB(row *dbgen.Artifact) (domain.Artifact, error) {
	artifact := domain.Artifact{
		ID: domain.ID(row.ID), OwnerUserID: domain.ID(row.OwnerUserID), Purpose: domain.ArtifactPurpose(row.Purpose),
		MimeType: row.MimeType, StorageKey: row.StorageKey, SHA256: row.Sha256, ByteSize: row.ByteSize,
		Width: int(row.Width), Height: int(row.Height), CapturedAt: row.CapturedAt.Time,
		CreatedAt: row.CreatedAt.Time, UpdatedAt: row.UpdatedAt.Time, Revision: row.Revision,
	}
	if !row.CapturedAt.Valid || !row.CreatedAt.Valid || !row.UpdatedAt.Valid {
		return domain.Artifact{}, domain.NewError(domain.CodeInternalError, "Artifact日時が不正")
	}
	return artifact, artifact.Validate()
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

func artifactSupportRequestFromDB(row *dbgen.SupportRequest) (domain.SupportRequest, error) {
	var contextValue *domain.GuideContext
	if len(row.GuideContext) > 0 && string(row.GuideContext) != "null" {
		var value guideContextJSON
		if err := json.Unmarshal(row.GuideContext, &value); err != nil {
			return domain.SupportRequest{}, fmt.Errorf("decode guide context: %w", err)
		}
		contextValue = &domain.GuideContext{
			GuideRunID: domain.ID(value.GuideRunID), GuideID: domain.ID(value.GuideID),
			GuideVersionNumber: value.GuideVersionNumber, StepNumber: value.StepNumber,
			GuideTitle: value.GuideTitle, StepInstruction: value.StepInstruction,
			StepArtifactID: domain.ID(value.StepArtifactID),
		}
	}
	request := domain.SupportRequest{
		ID: domain.ID(row.ID), UserID: domain.ID(row.UserID), FamilyID: domain.ID(row.FamilyID),
		InitialScreenshotArtifactID: domain.ID(row.InitialScreenshotArtifactID), Comment: row.Comment,
		Status: domain.SupportRequestStatus(row.Status), SupportSessionID: stringPointerToID(row.SupportSessionID),
		GuideContext: contextValue, AcknowledgedAt: optionalTime(row.AcknowledgedAt),
		AcknowledgementKind: stringPointerToAcknowledgementKind(row.AcknowledgementKind),
		EstimatedSupportAt:  optionalTime(row.EstimatedSupportAt),
		CreatedAt:           row.CreatedAt.Time, UpdatedAt: row.UpdatedAt.Time, Revision: row.Revision,
	}
	if !row.CreatedAt.Valid || !row.UpdatedAt.Valid {
		return domain.SupportRequest{}, domain.NewError(domain.CodeInternalError, "SupportRequest日時が不正")
	}
	return request, request.Validate()
}

func optionalTimestamptz(value *time.Time) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}
	return pgTimestamp(*value)
}

func acknowledgementKindPointerToString(value *domain.SupportAcknowledgementKind) *string {
	if value == nil {
		return nil
	}
	result := string(*value)
	return &result
}

func stringPointerToAcknowledgementKind(value *string) *domain.SupportAcknowledgementKind {
	if value == nil {
		return nil
	}
	kind := domain.SupportAcknowledgementKind(*value)
	return &kind
}

func deletionTaskFromDB(row *dbgen.ArtifactDeletionTask) (domain.ArtifactDeletionTask, error) {
	task := domain.ArtifactDeletionTask{
		ID: domain.ID(row.ID), ArtifactID: stringPointerToID(row.ArtifactID), StorageKey: row.StorageKey,
		Status: domain.ArtifactDeletionTaskStatus(row.Status), Attempt: int(row.Attempt),
		NextAttemptAt: row.NextAttemptAt.Time, CreatedAt: row.CreatedAt.Time,
	}
	if !task.Status.Valid() || !row.NextAttemptAt.Valid || !row.CreatedAt.Valid {
		return domain.ArtifactDeletionTask{}, domain.NewError(domain.CodeInternalError, "ArtifactDeletionTaskが不正")
	}
	return task, nil
}
