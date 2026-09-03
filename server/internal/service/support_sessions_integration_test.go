package service

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/repository"
)

func TestSupportSessionPostgresIdempotencyCompletion(t *testing.T) {
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
	if err := pool.Ping(ctx); err != nil {
		t.Fatal(err)
	}

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	userID := "user_session_it_" + suffix
	familyID := "family_session_it_" + suffix
	artifactID := "artifact_session_it_" + suffix
	requestID := "request_session_it_" + suffix
	idempotencyKey := "call-session-it-" + suffix
	now := time.Now().UTC().Truncate(time.Microsecond)
	defer func() {
		_, _ = pool.Exec(context.Background(), "UPDATE support_requests SET support_session_id = NULL WHERE id = $1", requestID)
		_, _ = pool.Exec(context.Background(), "DELETE FROM support_sessions WHERE support_request_id = $1", requestID)
		_, _ = pool.Exec(context.Background(), "DELETE FROM support_requests WHERE id = $1", requestID)
		_, _ = pool.Exec(context.Background(), "DELETE FROM idempotency_records WHERE actor_id = $1", familyID)
		_, _ = pool.Exec(context.Background(), "DELETE FROM artifacts WHERE id = $1", artifactID)
		_, _ = pool.Exec(context.Background(), "DELETE FROM user_pairs WHERE user_id = $1 AND family_id = $2", userID, familyID)
		_, _ = pool.Exec(context.Background(), "DELETE FROM users WHERE id IN ($1, $2)", userID, familyID)
	}()

	if _, err := pool.Exec(ctx,
		"INSERT INTO users (id, role, display_name) VALUES ($1, 'USER', 'テスト利用者'), ($2, 'FAMILY', 'テスト家族')",
		userID, familyID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO user_pairs (user_id, family_id) VALUES ($1, $2)", userID, familyID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO artifacts (
			id, owner_user_id, purpose, mime_type, storage_key, sha256,
			byte_size, width, height, captured_at, created_at, updated_at
		) VALUES ($1, $2, 'REQUEST_SCREENSHOT', 'image/jpeg', $3, $4, 1, 1, 1, $5, $5, $5)`,
		artifactID, userID, userID+"/"+artifactID+".jpg", strings.Repeat("a", 64), now,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO support_requests (
			id, user_id, family_id, initial_screenshot_artifact_id, comment,
			status, created_at, updated_at
		) VALUES ($1, $2, $3, $4, '', 'PENDING', $5, $5)`,
		requestID, userID, familyID, artifactID, now,
	); err != nil {
		t.Fatal(err)
	}

	store := repository.NewPostgresSupportSessionStore(pool)
	sessionService := NewSupportSessionService(store, nil, nil, nil)
	sessionService.now = func() time.Time { return now }
	var sequence atomic.Int64
	sessionService.newID = func(prefix string) (domain.ID, error) {
		return domain.ID(fmt.Sprintf("%s_session_it_%s_%d", prefix, suffix, sequence.Add(1))), nil
	}
	actor := domain.Actor{ID: domain.ID(familyID), Role: domain.RoleFamily}
	created, err := sessionService.Call(ctx, actor, requestID, 1, idempotencyKey, "http-session-it-first")
	if err != nil {
		t.Fatalf("Call() error = %v", err)
	}
	if created.SupportRequest.Revision != 2 || created.SupportSession.Revision != 1 {
		t.Fatalf("created = %+v", created)
	}

	var status string
	var responseStatus int
	var responseBody []byte
	var completedAt time.Time
	var expiresAt time.Time
	err = pool.QueryRow(ctx, `
		SELECT status, response_status, response_body, completed_at, expires_at
		FROM idempotency_records
		WHERE actor_id = $1 AND method = 'POST' AND path = $2 AND key = $3`,
		familyID, "/v1/support-requests/"+requestID+"/call", idempotencyKey,
	).Scan(&status, &responseStatus, &responseBody, &completedAt, &expiresAt)
	if err != nil {
		t.Fatal(err)
	}
	if status != "COMPLETED" || responseStatus != 201 || !json.Valid(responseBody) {
		t.Fatalf("idempotency status=%s responseStatus=%d body=%s", status, responseStatus, responseBody)
	}
	if !expiresAt.Equal(completedAt.Add(24 * time.Hour)) {
		t.Fatalf("completedAt=%s expiresAt=%s", completedAt, expiresAt)
	}

	replayed, err := sessionService.Call(ctx, actor, requestID, 1, idempotencyKey, "http-session-it-replay")
	if err != nil {
		t.Fatalf("Call() replay error = %v", err)
	}
	if replayed.SupportSession.ID != created.SupportSession.ID || replayed.SupportRequest.Revision != created.SupportRequest.Revision {
		t.Fatalf("replayed=%+v created=%+v", replayed, created)
	}
}
