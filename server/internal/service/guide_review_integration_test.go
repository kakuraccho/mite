package service

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/repository"
)

func TestCancelMultipleGuidesPostgresIntegration(t *testing.T) {
	databaseURL := os.Getenv("MITE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("MITE_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if err := cleanupGuideIntegrationFixture(ctx, pool); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := cleanupGuideIntegrationFixture(ctx, pool); err != nil {
			t.Error(err)
		}
	}()
	now := time.Now().UTC().Truncate(time.Second)
	if err := createGuideIntegrationFixture(ctx, pool, now); err != nil {
		t.Fatal(err)
	}
	storage := &fakeGuideStorage{objects: map[string][]byte{guideIntegrationUser + "/" + guideIntegrationInitial + ".jpg": jpegFixture(t, 20)}}
	store := repository.NewGuideRepository(pool)
	guides := NewGuideService(store, storage, nil, nil)
	user := domain.Actor{ID: guideIntegrationUser, Role: domain.RoleUser}
	family := domain.Actor{ID: guideIntegrationFamily, Role: domain.RoleFamily}
	meta := func(key string) CommandMeta {
		return CommandMeta{Actor: user, Key: key, RequestID: "cancel-integration"}
	}
	captured := now.Add(-30 * time.Second)
	batch, err := guides.CreateGuideMaterialBatch(ctx, CreateGuideMaterialBatchCommand{Meta: meta("cancel-batch"), SupportSessionID: guideIntegrationSession, ExpectedSessionRevision: 3, CaptureIntervalSeconds: 10, ExpectedItemCount: 1, CapturedFrom: &captured, CapturedTo: &captured})
	if err != nil {
		t.Fatal(err)
	}
	material, _, err := guides.CreateGuideMaterial(ctx, CreateGuideMaterialCommand{Meta: meta("cancel-material"), BatchID: batch.Batch.ID, ClientCaptureID: "cancel-capture", Sequence: 1, CapturedAt: captured, JPEG: jpegFixture(t, 40)})
	if err != nil {
		t.Fatal(err)
	}
	_, err = guides.CompleteGuideMaterialBatch(ctx, CompleteGuideMaterialBatchCommand{Meta: meta("cancel-complete-batch"), BatchID: batch.Batch.ID, ExpectedBatchRevision: material.Batch.Revision, ExpectedItemCount: 1})
	if err != nil {
		t.Fatal(err)
	}
	generator := &fakeGenerator{outputs: []domain.GeneratedGuide{
		{Title: "最初のガイド", Steps: []domain.GeneratedGuideStep{{SourceArtifactID: guideIntegrationInitial, Instruction: "画面を確認する"}}},
		{Title: "次のガイド", Steps: []domain.GeneratedGuideStep{{SourceArtifactID: material.Material.ArtifactID, Instruction: "次へを押す"}}},
	}}
	worker := NewGuideWorker(store, storage, generator, nil, nil)
	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("generation: %t, %v", processed, err)
	}
	drafts, err := guides.ListSessionGuideDrafts(ctx, family, guideIntegrationSession)
	if err != nil || len(drafts) != 2 {
		t.Fatalf("drafts: %+v, %v", drafts, err)
	}
	sessions := NewSupportSessionService(repository.NewPostgresSupportSessionStore(pool), nil, nil, nil)
	session, err := sessions.Get(ctx, family, guideIntegrationSession)
	if err != nil {
		t.Fatal(err)
	}
	ended, err := sessions.EndWithoutGuide(ctx, family, string(session.ID), session.Revision, domain.EndReasonGuideCancelled, "cancel-review", "cancel-request")
	if err != nil || ended.Status != domain.SupportSessionEnded {
		t.Fatalf("cancel: %+v, %v", ended, err)
	}
	remaining, err := guides.ListSessionGuideDrafts(ctx, user, session.ID)
	if err != nil || len(remaining) != 0 {
		t.Fatalf("drafts survived cancellation: %+v, %v", remaining, err)
	}
	for _, check := range []struct {
		query string
		id    domain.ID
	}{
		{"SELECT count(*) FROM guide_drafts WHERE support_session_id=$1", session.ID},
		{"SELECT count(*) FROM guide_material_batches WHERE support_session_id=$1", session.ID},
		{"SELECT count(*) FROM guide_generation_jobs WHERE batch_id=$1", batch.Batch.ID},
		{"SELECT count(*) FROM guide_materials WHERE batch_id=$1", batch.Batch.ID},
		{"SELECT count(*) FROM guides WHERE user_id=$1", user.ID},
	} {
		var count int
		if err := pool.QueryRow(ctx, check.query, check.id).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s: %d remaining rows, %v", check.query, count, err)
		}
	}
	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM artifact_deletion_tasks WHERE artifact_id=$1", material.Material.ArtifactID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("cleanup reservation: %d, %v", count, err)
	}
}
