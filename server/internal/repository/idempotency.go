package repository

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	dbgen "github.com/kakuraccho/mite/server/db/generated"
	"github.com/kakuraccho/mite/server/internal/domain"
)

type IdempotencyRepository struct {
	queries *dbgen.Queries
}

func NewIdempotencyRepository(db dbgen.DBTX) *IdempotencyRepository {
	return &IdempotencyRepository{queries: dbgen.New(db)}
}

func (r *IdempotencyRepository) Get(
	ctx context.Context,
	scope domain.IdempotencyScope,
	lock bool,
) (domain.IdempotencyRecord, bool, error) {
	params := dbgen.GetIdempotencyRecordParams{
		ActorID: string(scope.ActorID),
		Method:  scope.Method,
		Path:    scope.Path,
		Key:     string(scope.Key),
	}
	var (
		record *dbgen.IdempotencyRecord
		err    error
	)
	if lock {
		record, err = r.queries.LockIdempotencyRecord(ctx, dbgen.LockIdempotencyRecordParams(params))
	} else {
		record, err = r.queries.GetIdempotencyRecord(ctx, params)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.IdempotencyRecord{}, false, nil
	}
	if err != nil {
		return domain.IdempotencyRecord{}, false, fmt.Errorf("get idempotency record: %w", err)
	}
	converted, err := idempotencyRecordFromDB(record)
	return converted, true, err
}

func (r *IdempotencyRepository) Create(
	ctx context.Context,
	record domain.IdempotencyRecord,
) (domain.IdempotencyRecord, error) {
	if err := record.Validate(); err != nil {
		return domain.IdempotencyRecord{}, err
	}
	created, err := r.queries.CreateIdempotencyRecord(ctx, dbgen.CreateIdempotencyRecordParams{
		ActorID:        string(record.Scope.ActorID),
		Method:         record.Scope.Method,
		Path:           record.Scope.Path,
		Key:            string(record.Scope.Key),
		RequestHash:    string(record.RequestHash),
		ResourceID:     idPointerToString(record.ResourceID),
		LeaseExpiresAt: requiredTimestamptz(record.LeaseExpiresAt),
		CreatedAt:      pgtype.Timestamptz{Time: record.CreatedAt, Valid: true},
	})
	if err != nil {
		return domain.IdempotencyRecord{}, fmt.Errorf("create idempotency record: %w", err)
	}
	return idempotencyRecordFromDB(created)
}

func (r *IdempotencyRepository) TakeOverExpiredLease(
	ctx context.Context,
	scope domain.IdempotencyScope,
	resourceID *domain.ID,
	now time.Time,
) (domain.IdempotencyRecord, bool, error) {
	updated, err := r.queries.TakeOverExpiredIdempotencyLease(ctx, dbgen.TakeOverExpiredIdempotencyLeaseParams{
		ActorID:           string(scope.ActorID),
		Method:            scope.Method,
		Path:              scope.Path,
		Key:               string(scope.Key),
		NewLeaseExpiresAt: pgtype.Timestamptz{Time: now.Add(domain.IdempotencyLease), Valid: true},
		ResourceID:        idPointerToString(resourceID),
		Now:               pgtype.Timestamptz{Time: now, Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.IdempotencyRecord{}, false, nil
	}
	if err != nil {
		return domain.IdempotencyRecord{}, false, fmt.Errorf("take over idempotency lease: %w", err)
	}
	converted, err := idempotencyRecordFromDB(updated)
	return converted, true, err
}

func (r *IdempotencyRepository) ReleaseLease(
	ctx context.Context,
	scope domain.IdempotencyScope,
	now time.Time,
) error {
	if err := r.queries.ReleaseIdempotencyLease(ctx, dbgen.ReleaseIdempotencyLeaseParams{
		ActorID:    string(scope.ActorID),
		Method:     scope.Method,
		Path:       scope.Path,
		Key:        string(scope.Key),
		ReleasedAt: pgtype.Timestamptz{Time: now, Valid: true},
	}); err != nil {
		return fmt.Errorf("release idempotency lease: %w", err)
	}
	return nil
}

func (r *IdempotencyRepository) Complete(
	ctx context.Context,
	scope domain.IdempotencyScope,
	responseStatus int,
	responseBody json.RawMessage,
	now time.Time,
) (domain.IdempotencyRecord, bool, error) {
	status := int32(responseStatus)
	updated, err := r.queries.CompleteIdempotencyRecord(ctx, dbgen.CompleteIdempotencyRecordParams{
		ActorID:        string(scope.ActorID),
		Method:         scope.Method,
		Path:           scope.Path,
		Key:            string(scope.Key),
		ResponseStatus: &status,
		ResponseBody:   responseBody,
		CompletedAt:    pgtype.Timestamptz{Time: now, Valid: true},
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.IdempotencyRecord{}, false, nil
	}
	if err != nil {
		return domain.IdempotencyRecord{}, false, fmt.Errorf("complete idempotency record: %w", err)
	}
	converted, err := idempotencyRecordFromDB(updated)
	return converted, true, err
}

func idempotencyRecordFromDB(record *dbgen.IdempotencyRecord) (domain.IdempotencyRecord, error) {
	hash, err := domain.NewRequestHash(record.RequestHash)
	if err != nil {
		return domain.IdempotencyRecord{}, err
	}
	key, err := domain.NewIdempotencyKey(record.Key)
	if err != nil {
		return domain.IdempotencyRecord{}, err
	}
	converted := domain.IdempotencyRecord{
		Scope: domain.IdempotencyScope{
			ActorID: domain.ID(record.ActorID),
			Method:  record.Method,
			Path:    record.Path,
			Key:     key,
		},
		RequestHash:    hash,
		Status:         domain.IdempotencyStatus(record.Status),
		ResourceID:     stringPointerToID(record.ResourceID),
		ResponseStatus: int32PointerToInt(record.ResponseStatus),
		ResponseBody:   append(json.RawMessage(nil), record.ResponseBody...),
		LeaseExpiresAt: optionalTime(record.LeaseExpiresAt),
		CreatedAt:      record.CreatedAt.Time,
		CompletedAt:    optionalTime(record.CompletedAt),
		ExpiresAt:      optionalTime(record.ExpiresAt),
	}
	return converted, converted.Validate()
}

func requiredTimestamptz(value *time.Time) pgtype.Timestamptz {
	if value == nil {
		return pgtype.Timestamptz{}
	}
	return pgtype.Timestamptz{Time: *value, Valid: true}
}

func optionalTime(value pgtype.Timestamptz) *time.Time {
	if !value.Valid {
		return nil
	}
	result := value.Time
	return &result
}

func idPointerToString(value *domain.ID) *string {
	if value == nil {
		return nil
	}
	result := string(*value)
	return &result
}

func stringPointerToID(value *string) *domain.ID {
	if value == nil {
		return nil
	}
	result := domain.ID(*value)
	return &result
}

func int32PointerToInt(value *int32) *int {
	if value == nil {
		return nil
	}
	result := int(*value)
	return &result
}
