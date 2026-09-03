package repository

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kakuraccho/mite/server/internal/domain"
)

func TestGuideIdempotencyIntegration(t *testing.T) {
	databaseURL := os.Getenv("MITE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("MITE_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect test database: %v", err)
	}
	defer pool.Close()

	scope := domain.IdempotencyScope{
		ActorID: "user_demo",
		Method:  "POST",
		Path:    "/integration/guide-idempotency",
		Key:     "guide-integration-key",
	}
	defer func() {
		_, cleanupErr := pool.Exec(context.Background(), `DELETE FROM idempotency_records WHERE actor_id=$1 AND method=$2 AND path=$3 AND key=$4`, scope.ActorID, scope.Method, scope.Path, scope.Key)
		if cleanupErr != nil {
			t.Errorf("cleanup idempotency record: %v", cleanupErr)
		}
	}()
	if _, err := pool.Exec(ctx, `DELETE FROM idempotency_records WHERE actor_id=$1 AND method=$2 AND path=$3 AND key=$4`, scope.ActorID, scope.Method, scope.Path, scope.Key); err != nil {
		t.Fatalf("prepare idempotency record: %v", err)
	}
	hash, _ := domain.NewRequestHash("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	now := time.Now().UTC().Truncate(time.Microsecond)
	repository := NewGuideRepository(pool)

	firstReady := make(chan struct{})
	allowCommit := make(chan struct{})
	firstDone := make(chan error, 1)
	go func() {
		firstDone <- repository.WithinTx(ctx, pgx.TxOptions{}, func(tx GuideTx) error {
			if _, found, getErr := tx.GetIdempotency(ctx, scope); getErr != nil || found {
				if getErr != nil {
					return getErr
				}
				return errors.New("expected no existing record")
			}
			lease := now.Add(domain.IdempotencyLease)
			_, createErr := tx.CreateIdempotency(ctx, domain.IdempotencyRecord{Scope: scope, RequestHash: hash, Status: domain.IdempotencyInProgress, LeaseExpiresAt: &lease, CreatedAt: now})
			if createErr != nil {
				return createErr
			}
			if completeErr := tx.CompleteIdempotency(ctx, scope, 201, json.RawMessage(`{"data":{"ok":true}}`), timestamp(now)); completeErr != nil {
				return completeErr
			}
			close(firstReady)
			<-allowCommit
			return nil
		})
	}()
	<-firstReady

	secondDone := make(chan error, 1)
	go func() {
		secondDone <- repository.WithinTx(ctx, pgx.TxOptions{}, func(tx GuideTx) error {
			_, _, getErr := tx.GetIdempotency(ctx, scope)
			return getErr
		})
	}()
	secondErr := <-secondDone
	if code, ok := domain.ErrorCodeOf(secondErr); !ok || code != domain.CodeIdempotencyRequestInProgress {
		t.Fatalf("concurrent transaction error = %v, want IDEMPOTENCY_REQUEST_IN_PROGRESS", secondErr)
	}
	close(allowCommit)
	if err := <-firstDone; err != nil {
		t.Fatalf("complete first transaction: %v", err)
	}
	if err := repository.WithinTx(ctx, pgx.TxOptions{}, func(tx GuideTx) error {
		record, found, getErr := tx.GetIdempotency(ctx, scope)
		if getErr != nil {
			return getErr
		}
		if !found || record.Status != domain.IdempotencyCompleted || record.ResponseStatus == nil || *record.ResponseStatus != 201 {
			return errors.New("unexpected completed idempotency record")
		}
		return record.Validate()
	}); err != nil {
		t.Fatalf("read completed transaction: %v", err)
	}
}
