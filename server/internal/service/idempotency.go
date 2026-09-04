package service

import (
	"encoding/json"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
)

type IdempotencyDecision int

const (
	IdempotencyStart IdempotencyDecision = iota
	IdempotencyTakeOver
	IdempotencyReplay
)

type IdempotencyEvaluation struct {
	Decision IdempotencyDecision
	Record   domain.IdempotencyRecord
}

func EvaluateIdempotency(
	record *domain.IdempotencyRecord,
	requestHash domain.RequestHash,
	now time.Time,
) (IdempotencyEvaluation, error) {
	if _, err := domain.NewRequestHash(string(requestHash)); err != nil {
		return IdempotencyEvaluation{}, err
	}
	if record == nil {
		return IdempotencyEvaluation{Decision: IdempotencyStart}, nil
	}
	if err := record.Validate(); err != nil {
		return IdempotencyEvaluation{}, err
	}
	if record.RequestHash != requestHash {
		return IdempotencyEvaluation{}, domain.NewError(
			domain.CodeIdempotencyKeyReused,
			"同じIdempotency-Keyが異なるリクエストに使用されている",
		)
	}
	if record.Status == domain.IdempotencyCompleted {
		return IdempotencyEvaluation{Decision: IdempotencyReplay, Record: *record}, nil
	}
	if record.LeaseExpiresAt != nil && record.LeaseExpiresAt.After(now) {
		return IdempotencyEvaluation{}, domain.NewError(
			domain.CodeIdempotencyRequestInProgress,
			"同じリクエストを処理中",
		)
	}
	return IdempotencyEvaluation{Decision: IdempotencyTakeOver, Record: *record}, nil
}

func NewInProgressIdempotencyRecord(
	scope domain.IdempotencyScope,
	requestHash domain.RequestHash,
	resourceID *domain.ID,
	now time.Time,
) (domain.IdempotencyRecord, error) {
	leaseExpiresAt := now.Add(domain.IdempotencyLease)
	record := domain.IdempotencyRecord{
		Scope:          scope,
		RequestHash:    requestHash,
		Status:         domain.IdempotencyInProgress,
		ResourceID:     resourceID,
		LeaseExpiresAt: &leaseExpiresAt,
		CreatedAt:      now,
	}
	return record, record.Validate()
}

func CompleteIdempotencyRecord(
	record domain.IdempotencyRecord,
	responseStatus int,
	responseBody json.RawMessage,
	now time.Time,
) (domain.IdempotencyRecord, error) {
	if responseStatus < 100 || responseStatus > 599 || !json.Valid(responseBody) {
		return domain.IdempotencyRecord{}, domain.NewError(
			domain.CodeInternalError,
			"Idempotency応答が不正",
		)
	}
	expiresAt := now.Add(domain.IdempotencyRetention)
	record.Status = domain.IdempotencyCompleted
	record.ResponseStatus = &responseStatus
	record.ResponseBody = append(json.RawMessage(nil), responseBody...)
	record.LeaseExpiresAt = nil
	record.CompletedAt = &now
	record.ExpiresAt = &expiresAt
	return record, record.Validate()
}
