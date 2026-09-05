package service

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
)

func TestEvaluateIdempotency(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 3, 10, 0, 0, 0, time.UTC)
	hash := mustRequestHash(t, strings.Repeat("a", 64))
	scope := domain.IdempotencyScope{ActorID: "user_demo", Method: "POST", Path: "/v1/support-requests", Key: "idem-1"}
	record, err := NewInProgressIdempotencyRecord(scope, hash, nil, now)
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name     string
		record   *domain.IdempotencyRecord
		hash     domain.RequestHash
		now      time.Time
		decision IdempotencyDecision
		code     domain.ErrorCode
	}{
		{name: "new", hash: hash, now: now, decision: IdempotencyStart},
		{name: "in progress", record: &record, hash: hash, now: now, code: domain.CodeIdempotencyRequestInProgress},
		{name: "take over", record: &record, hash: hash, now: now.Add(domain.IdempotencyLease), decision: IdempotencyTakeOver},
		{name: "reused", record: &record, hash: mustRequestHash(t, strings.Repeat("b", 64)), now: now, code: domain.CodeIdempotencyKeyReused},
	}
	completed, err := CompleteIdempotencyRecord(record, 201, json.RawMessage(`{"data":{"id":"req_1"}}`), now)
	if err != nil {
		t.Fatal(err)
	}
	tests = append(tests, struct {
		name     string
		record   *domain.IdempotencyRecord
		hash     domain.RequestHash
		now      time.Time
		decision IdempotencyDecision
		code     domain.ErrorCode
	}{name: "replay", record: &completed, hash: hash, now: now, decision: IdempotencyReplay})

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			result, err := EvaluateIdempotency(test.record, test.hash, test.now)
			if test.code != "" {
				if code, ok := domain.ErrorCodeOf(err); !ok || code != test.code {
					t.Fatalf("EvaluateIdempotency() code = %s, %v; want %s", code, ok, test.code)
				}
				return
			}
			if err != nil {
				t.Fatalf("EvaluateIdempotency() error = %v", err)
			}
			if result.Decision != test.decision {
				t.Fatalf("decision = %v, want %v", result.Decision, test.decision)
			}
		})
	}
}

func mustRequestHash(t *testing.T, value string) domain.RequestHash {
	t.Helper()
	hash, err := domain.NewRequestHash(value)
	if err != nil {
		t.Fatal(err)
	}
	return hash
}
