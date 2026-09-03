package repository

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kakuraccho/mite/server/internal/domain"
)

func TestIdempotencyRepositoryCompletePostgres(t *testing.T) {
	databaseURL := os.Getenv("MITE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("MITE_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	now := time.Now().UTC().Truncate(time.Microsecond)
	lease := now.Add(domain.IdempotencyLease)
	repository := NewIdempotencyRepository(tx)
	scope := domain.IdempotencyScope{
		ActorID: "user_demo",
		Method:  "POST",
		Path:    "/v1/integration/shared-idempotency",
		Key:     domain.IdempotencyKey("shared-complete"),
	}
	_, err = repository.Create(ctx, domain.IdempotencyRecord{
		Scope:          scope,
		RequestHash:    domain.RequestHash(strings.Repeat("a", 64)),
		Status:         domain.IdempotencyInProgress,
		LeaseExpiresAt: &lease,
		CreatedAt:      now,
	})
	if err != nil {
		t.Fatal(err)
	}

	completedAt := now.Add(time.Second)
	completed, updated, err := repository.Complete(ctx, scope, 201, json.RawMessage(`{"data":{"id":"resource_1"}}`), completedAt)
	if err != nil {
		t.Fatalf("Complete() error = %v", err)
	}
	if !updated || completed.Status != domain.IdempotencyCompleted {
		t.Fatalf("Complete() = (%+v, %t)", completed, updated)
	}
	if completed.CompletedAt == nil || !completed.CompletedAt.Equal(completedAt) {
		t.Fatalf("completedAt = %v, want %v", completed.CompletedAt, completedAt)
	}
	if completed.ExpiresAt == nil || !completed.ExpiresAt.Equal(completedAt.Add(domain.IdempotencyRetention)) {
		t.Fatalf("expiresAt = %v", completed.ExpiresAt)
	}
}
