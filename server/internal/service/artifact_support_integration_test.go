package service

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/repository"
)

func TestArtifactSupportPostgresIntegration(t *testing.T) {
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

	suffix := fmt.Sprintf("%d", time.Now().UnixNano())
	userID := "user_it_" + suffix
	familyID := "family_it_" + suffix
	if _, err := pool.Exec(ctx,
		"INSERT INTO users (id, role, display_name) VALUES ($1, 'USER', 'テスト利用者'), ($2, 'FAMILY', 'テスト家族')",
		userID, familyID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO user_pairs (user_id, family_id) VALUES ($1, $2)", userID, familyID); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = pool.Exec(context.Background(), "DELETE FROM support_requests WHERE user_id = $1", userID)
		_, _ = pool.Exec(context.Background(), "DELETE FROM idempotency_records WHERE actor_id = $1", userID)
		_, _ = pool.Exec(context.Background(), "DELETE FROM artifact_deletion_tasks WHERE storage_key LIKE $1", userID+"/%")
		_, _ = pool.Exec(context.Background(), "DELETE FROM artifacts WHERE owner_user_id = $1", userID)
		_, _ = pool.Exec(context.Background(), "DELETE FROM user_pairs WHERE user_id = $1", userID)
		_, _ = pool.Exec(context.Background(), "DELETE FROM users WHERE id IN ($1, $2)", userID, familyID)
	}()

	repo := repository.NewArtifactSupportRepository(pool)
	storage := newFakeArtifactSupportStorage()
	var sequence atomic.Int64
	now := time.Now().UTC().Truncate(time.Microsecond)
	currentTime := now
	api := NewArtifactSupportService(repo, storage, nil, slog.New(slog.NewTextHandler(io.Discard, nil)), ArtifactSupportServiceOptions{
		Now: func() time.Time { return currentTime },
		NewID: func(prefix string) (domain.ID, error) {
			return domain.ID(fmt.Sprintf("%s_it_%s_%d", prefix, suffix, sequence.Add(1))), nil
		},
	})
	actor := domain.Actor{ID: domain.ID(userID), Role: domain.RoleUser}
	artifact, err := api.CreateArtifact(ctx, actor, "artifact-it-"+suffix, CreateArtifactInput{
		Purpose: domain.ArtifactPurposeRequestScreenshot, CapturedAt: now,
		File: bytes.NewReader(testJPEG(t, 2, 2)),
	})
	if err != nil {
		t.Fatalf("CreateArtifact() error = %v", err)
	}
	if artifact.Artifact.Revision != 1 || artifact.Artifact.OwnerUserID != actor.ID {
		t.Fatalf("artifact = %+v", artifact.Artifact)
	}

	start := make(chan struct{})
	results := make(chan IdempotentSupportRequestResult, 2)
	errorsChannel := make(chan error, 2)
	for _, key := range []string{"request-it-a-" + suffix, "request-it-b-" + suffix} {
		key := key
		go func() {
			<-start
			result, err := api.CreateSupportRequest(ctx, actor, key, CreateSupportRequestInput{
				InitialScreenshotArtifactID: artifact.Artifact.ID, RequestID: "http_" + key,
			})
			results <- result
			errorsChannel <- err
		}()
	}
	close(start)
	statuses := map[int]int{}
	for range 2 {
		result := <-results
		if err := <-errorsChannel; err != nil {
			t.Fatalf("CreateSupportRequest() error = %v", err)
		}
		statuses[result.ResponseStatus]++
	}
	if statuses[201] != 1 || statuses[409] != 1 {
		t.Fatalf("statuses = %v", statuses)
	}
	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM support_requests WHERE user_id = $1", userID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("support request count = %d", count)
	}

	currentTime = now.Add(-25 * time.Hour)
	orphan, err := api.CreateArtifact(ctx, actor, "orphan-it-"+suffix, CreateArtifactInput{
		Purpose: domain.ArtifactPurposeRequestScreenshot, CapturedAt: currentTime,
		File: bytes.NewReader(testJPEG(t, 1, 1)),
	})
	if err != nil {
		t.Fatalf("create stale orphan artifact: %v", err)
	}
	currentTime = now
	cleanup, err := api.ScheduleArtifactCleanup(ctx, 10)
	if err != nil {
		t.Fatalf("ScheduleArtifactCleanup() error = %v", err)
	}
	if cleanup.ScheduledArtifacts != 1 || cleanup.DeletedIdempotencies < 1 {
		t.Fatalf("cleanup = %+v", cleanup)
	}
	if _, available, err := repo.GetAvailableArtifact(ctx, orphan.Artifact.ID); err != nil || available {
		t.Fatalf("deletion-reserved artifact available=%v error=%v", available, err)
	}
	if processed, err := api.ProcessNextArtifactDeletion(ctx); err != nil || !processed {
		t.Fatalf("ProcessNextArtifactDeletion() = %v, %v", processed, err)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM artifacts WHERE id = $1", orphan.Artifact.ID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("orphan artifact count = %d", count)
	}
}
