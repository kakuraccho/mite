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

func TestMockGuideReviewPostgresIntegration(t *testing.T) {
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
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if err := cleanupGuideIntegrationFixture(cleanupCtx, pool); err != nil {
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
		return CommandMeta{Actor: user, Key: key, RequestID: "mock-integration"}
	}
	captured := now.Add(-30 * time.Second)
	batch, err := guides.CreateGuideMaterialBatch(ctx, CreateGuideMaterialBatchCommand{Meta: meta("mock-batch"), SupportSessionID: guideIntegrationSession, ExpectedSessionRevision: 3, CaptureIntervalSeconds: 10, ExpectedItemCount: 1, CapturedFrom: &captured, CapturedTo: &captured})
	if err != nil {
		t.Fatal(err)
	}
	material, _, err := guides.CreateGuideMaterial(ctx, CreateGuideMaterialCommand{Meta: meta("mock-material"), BatchID: batch.Batch.ID, ClientCaptureID: "mock-capture", Sequence: 1, CapturedAt: captured, JPEG: jpegFixture(t, 40)})
	if err != nil {
		t.Fatal(err)
	}
	completedBatch, err := guides.CompleteGuideMaterialBatch(ctx, CompleteGuideMaterialBatchCommand{Meta: meta("mock-complete-batch"), BatchID: batch.Batch.ID, ExpectedBatchRevision: material.Batch.Revision, ExpectedItemCount: 1})
	if err != nil {
		t.Fatal(err)
	}
	worker := NewGuideWorker(store, storage, NewMockGuideGenerator(), nil, nil)
	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("mock worker: processed=%t, %v", processed, err)
	}
	job, err := guides.GetGuideGenerationJob(ctx, family, completedBatch.Job.ID)
	if err != nil || job.Status != domain.GuideGenerationJobSucceeded {
		t.Fatalf("mock generation did not succeed: %+v, %v", job, err)
	}
	drafts, err := guides.ListSessionGuideDrafts(ctx, family, guideIntegrationSession)
	if err != nil || len(drafts) != 2 || len(drafts[0].Steps) != 2 || len(drafts[1].Steps) != 3 {
		t.Fatalf("mock drafts: %+v, %v", drafts, err)
	}
	drafts[1].Steps[0].Instruction = "編集した説明を確認する"
	drafts[1], err = guides.UpdateGuideDraft(ctx, UpdateGuideDraftCommand{Actor: family, DraftID: drafts[1].ID, ExpectedRevision: drafts[1].Revision, Title: "編集済みの動作確認用ガイド", Steps: drafts[1].Steps})
	if err != nil {
		t.Fatal(err)
	}
	sessions := NewSupportSessionService(repository.NewPostgresSupportSessionStore(pool), nil, nil, nil)
	session, err := sessions.Get(ctx, family, guideIntegrationSession)
	if err != nil || session.Status != domain.SupportSessionReviewingGuide {
		t.Fatalf("session is not reviewing: %+v, %v", session, err)
	}
	command := CompleteGuideReviewCommand{
		Meta:                    CommandMeta{Actor: family, Key: "mock-complete-review", RequestID: "mock-integration"},
		SupportSessionID:        session.ID,
		ExpectedSessionRevision: session.Revision,
		Drafts:                  []GuideDraftRevision{{ID: drafts[0].ID, ExpectedRevision: drafts[0].Revision}, {ID: drafts[1].ID, ExpectedRevision: drafts[1].Revision}},
	}
	saved, err := guides.CompleteGuideReview(ctx, command)
	if err != nil || len(saved.Guides) != 2 || saved.SupportSession.Status != domain.SupportSessionEnded {
		t.Fatalf("complete mock review: %+v, %v", saved, err)
	}
	if replayed, err := guides.CompleteGuideReview(ctx, command); err != nil || len(replayed.Guides) != 2 || replayed.Guides[1].Guide.ID != saved.Guides[1].Guide.ID {
		t.Fatalf("replay mock review: %+v, %v", replayed, err)
	}
	listed, err := guides.ListGuides(ctx, user)
	if err != nil || len(listed) != 2 {
		t.Fatalf("user guide list: %+v, %v", listed, err)
	}
	for index, savedGuide := range saved.Guides {
		guide, err := guides.GetGuide(ctx, user, savedGuide.Guide.ID)
		if err != nil || guide.Guide.Title != drafts[index].Title || len(guide.CurrentVersion.Steps) != len(drafts[index].Steps) || guide.CurrentVersion.Steps[0].Instruction != drafts[index].Steps[0].Instruction {
			t.Fatalf("user guide does not retain review edits: %+v, %v", guide, err)
		}
	}
}
