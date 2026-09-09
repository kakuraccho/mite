package service

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/repository"
)

type workerStore struct {
	mutex sync.Mutex
	tx    *workerTx
}

func (store *workerStore) WithinTx(_ context.Context, _ pgx.TxOptions, work func(repository.GuideTx) error) error {
	store.mutex.Lock()
	defer store.mutex.Unlock()
	return work(store.tx)
}

type workerTx struct {
	repository.GuideTx
	job        domain.GuideGenerationJob
	session    domain.SupportSession
	generation repository.GenerationContext
	materials  []repository.GenerationMaterial
	draft      domain.GuideDraft
	drafts     []domain.GuideDraft
	contextErr error
}

func (tx *workerTx) ClaimJob(_ context.Context, now pgtype.Timestamptz) (domain.GuideGenerationJob, error) {
	if tx.job.Status != domain.GuideGenerationJobQueued {
		return domain.GuideGenerationJob{}, pgx.ErrNoRows
	}
	tx.job.Status = domain.GuideGenerationJobRunning
	tx.job.Attempt++
	tx.job.Revision++
	tx.job.StartedAt = &now.Time
	return tx.job, nil
}
func (tx *workerTx) GetGenerationContext(_ context.Context, id domain.ID) (repository.GenerationContext, error) {
	if tx.contextErr != nil {
		return repository.GenerationContext{}, tx.contextErr
	}
	if id != tx.job.ID {
		return repository.GenerationContext{}, pgx.ErrNoRows
	}
	tx.generation.JobRevision = tx.job.Revision
	return tx.generation, nil
}
func (tx *workerTx) ListGenerationMaterials(_ context.Context, id domain.ID) ([]repository.GenerationMaterial, error) {
	if id != tx.generation.BatchID {
		return nil, pgx.ErrNoRows
	}
	return append([]repository.GenerationMaterial(nil), tx.materials...), nil
}
func (tx *workerTx) GetSession(_ context.Context, id domain.ID, _ bool) (domain.SupportSession, error) {
	if id != tx.session.ID {
		return domain.SupportSession{}, pgx.ErrNoRows
	}
	return tx.session, nil
}
func (tx *workerTx) GetSessionByJob(_ context.Context, id domain.ID) (domain.SupportSession, error) {
	if id != tx.job.ID {
		return domain.SupportSession{}, pgx.ErrNoRows
	}
	return tx.session, nil
}
func (tx *workerTx) GetJob(_ context.Context, id domain.ID, _ bool) (domain.GuideGenerationJob, error) {
	if id != tx.job.ID {
		return domain.GuideGenerationJob{}, pgx.ErrNoRows
	}
	return tx.job, nil
}
func (tx *workerTx) CreateDraft(_ context.Context, value domain.GuideDraft) (domain.GuideDraft, error) {
	tx.draft = value
	tx.drafts = append(tx.drafts, value)
	return value, nil
}
func (tx *workerTx) SucceedJob(_ context.Context, _ domain.ID, revision int64, draftID domain.ID, now pgtype.Timestamptz) (domain.GuideGenerationJob, error) {
	if revision != tx.job.Revision {
		return domain.GuideGenerationJob{}, pgx.ErrNoRows
	}
	tx.job.Status = domain.GuideGenerationJobSucceeded
	tx.job.GuideDraftID = &draftID
	tx.job.Revision++
	tx.job.FinishedAt = &now.Time
	return tx.job, nil
}
func (tx *workerTx) FailJob(_ context.Context, _ domain.ID, revision int64, code domain.GuideGenerationErrorCode, now pgtype.Timestamptz) (domain.GuideGenerationJob, error) {
	if revision != tx.job.Revision {
		return domain.GuideGenerationJob{}, pgx.ErrNoRows
	}
	tx.job.Status = domain.GuideGenerationJobFailed
	tx.job.ErrorCode = &code
	tx.job.Revision++
	tx.job.FinishedAt = &now.Time
	return tx.job, nil
}
func (tx *workerTx) ReviewDraft(_ context.Context, _ domain.ID, draftID domain.ID, _ pgtype.Timestamptz) (domain.SupportSession, error) {
	tx.session.Status = domain.SupportSessionReviewingGuide
	tx.session.GuideDraftID = &draftID
	tx.session.Revision++
	return tx.session, nil
}
func (tx *workerTx) RecoverJobs(_ context.Context, now pgtype.Timestamptz) ([]domain.GuideGenerationJob, error) {
	if tx.job.Status != domain.GuideGenerationJobRunning {
		return []domain.GuideGenerationJob{}, nil
	}
	tx.job.Revision++
	if tx.job.Attempt < 3 {
		tx.job.Status = domain.GuideGenerationJobQueued
		tx.job.StartedAt = nil
	} else {
		code := domain.GuideGenerationWorkerRestarted
		tx.job.Status = domain.GuideGenerationJobFailed
		tx.job.ErrorCode = &code
		tx.job.FinishedAt = &now.Time
	}
	return []domain.GuideGenerationJob{tx.job}, nil
}

type fakeGenerator struct {
	input   domain.GuideGenerationInput
	output  domain.GeneratedGuide
	outputs []domain.GeneratedGuide
	err     error
}

func (generator *fakeGenerator) Generate(_ context.Context, input domain.GuideGenerationInput) ([]domain.GeneratedGuide, error) {
	generator.input = input
	if generator.outputs != nil {
		return generator.outputs, generator.err
	}
	return []domain.GeneratedGuide{generator.output}, generator.err
}

func workerFixture(t *testing.T, materialCount int) (*GuideWorker, *workerTx, *fakeGenerator) {
	t.Helper()
	now := time.Date(2026, 9, 4, 0, 0, 0, 0, time.UTC)
	batchID := domain.ID("batch_1")
	jobID := domain.ID("job_1")
	sessionID := domain.ID("session_1")
	jobPointer := jobID
	tx := &workerTx{job: domain.GuideGenerationJob{ID: jobID, BatchID: batchID, Status: domain.GuideGenerationJobQueued, Attempt: 0, Revision: 1}, session: domain.SupportSession{ID: sessionID, UserID: "user_demo", FamilyID: "family_demo", Status: domain.SupportSessionGeneratingGuide, GuideGenerationJobID: &jobPointer, Revision: 5}, generation: repository.GenerationContext{JobID: jobID, BatchID: batchID, SupportSessionID: sessionID, UserID: "user_demo", FamilyID: "family_demo", InitialScreenshotArtifactID: "initial", InitialStorageKey: "initial.jpg", InitialCapturedAt: pgtype.Timestamptz{Time: now, Valid: true}}}
	storage := &fakeGuideStorage{objects: map[string][]byte{"initial.jpg": jpegFixture(t, 1)}}
	for index := 1; index <= materialCount; index++ {
		key := strconv.Itoa(index) + ".jpg"
		storage.objects[key] = jpegFixture(t, uint8(index))
		tx.materials = append(tx.materials, repository.GenerationMaterial{ArtifactID: domain.ID("art_" + strconv.Itoa(index)), Sequence: index, CapturedAt: pgtype.Timestamptz{Time: now.Add(time.Duration(index) * time.Second), Valid: true}, StorageKey: key})
	}
	generator := &fakeGenerator{output: domain.GeneratedGuide{Title: "設定", Steps: []domain.GeneratedGuideStep{{SourceArtifactID: "initial", Instruction: "設定を押す"}}}}
	worker := NewGuideWorker(&workerStore{tx: tx}, storage, generator, nil, nil)
	worker.now = func() time.Time { return now.Add(time.Minute) }
	worker.newID = func(prefix string) domain.ID { return domain.ID(prefix + "fixed") }
	return worker, tx, generator
}

func TestGuideWorkerSelectsThirtyMaterialsAndSucceeds(t *testing.T) {
	t.Parallel()
	worker, tx, generator := workerFixture(t, 31)
	processed, err := worker.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !processed {
		t.Fatal("job was not processed")
	}
	if len(generator.input.Images) != 31 {
		t.Fatalf("input images=%d, want 31", len(generator.input.Images))
	}
	if generator.input.Images[0].ArtifactID != "initial" || generator.input.Images[1].Sequence != 1 || generator.input.Images[len(generator.input.Images)-1].Sequence != 31 {
		t.Fatalf("selected images=%+v", generator.input.Images)
	}
	if tx.job.Status != domain.GuideGenerationJobSucceeded || tx.job.Attempt != 1 || tx.job.Revision != 3 || tx.session.Status != domain.SupportSessionReviewingGuide || tx.draft.Status != domain.GuideDraftEditing {
		t.Fatalf("job=%+v session=%+v draft=%+v", tx.job, tx.session, tx.draft)
	}
}

func TestGuideWorkerPersistsFailureCode(t *testing.T) {
	t.Parallel()
	worker, tx, generator := workerFixture(t, 1)
	generator.err = &GuideGenerationFailure{Code: domain.GuideGenerationAIRefusal}
	processed, err := worker.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !processed || tx.job.Status != domain.GuideGenerationJobFailed || tx.job.ErrorCode == nil || *tx.job.ErrorCode != domain.GuideGenerationAIRefusal {
		t.Fatalf("job=%+v", tx.job)
	}
}

func TestGuideWorkerPersistsInputFailureAfterClaim(t *testing.T) {
	t.Parallel()
	worker, tx, generator := workerFixture(t, 1)
	tx.contextErr = errors.New("missing generation input")
	processed, err := worker.RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !processed || tx.job.Status != domain.GuideGenerationJobFailed || tx.job.ErrorCode == nil || *tx.job.ErrorCode != domain.GuideGenerationAIInputUnavailable {
		t.Fatalf("job=%+v", tx.job)
	}
	if len(generator.input.Images) != 0 {
		t.Fatalf("generator should not be called: %+v", generator.input)
	}
}

func TestGuideWorkerRecovery(t *testing.T) {
	t.Parallel()
	worker, tx, _ := workerFixture(t, 0)
	started := time.Now()
	tx.job.Status = domain.GuideGenerationJobRunning
	tx.job.Attempt = 2
	tx.job.StartedAt = &started
	tx.job.Revision = 4
	if err := worker.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if tx.job.Status != domain.GuideGenerationJobQueued || tx.job.StartedAt != nil || tx.job.Revision != 5 {
		t.Fatalf("attempt 2 recovery=%+v", tx.job)
	}
	tx.job.Status = domain.GuideGenerationJobRunning
	tx.job.Attempt = 3
	tx.job.StartedAt = &started
	if err := worker.Recover(context.Background()); err != nil {
		t.Fatal(err)
	}
	if tx.job.Status != domain.GuideGenerationJobFailed || tx.job.ErrorCode == nil || *tx.job.ErrorCode != domain.GuideGenerationWorkerRestarted {
		t.Fatalf("attempt 3 recovery=%+v", tx.job)
	}
}

var _ GuideGenerator = (*fakeGenerator)(nil)

func TestGuideWorkerCreatesAllDraftsOrRejectsWholeOutput(t *testing.T) {
	for _, invalid := range []bool{false, true} {
		t.Run(strconv.FormatBool(invalid), func(t *testing.T) {
			worker, tx, generator := workerFixture(t, 1)
			nextID := 0
			worker.newID = func(prefix string) domain.ID { nextID++; return domain.ID(prefix + strconv.Itoa(nextID)) }
			first := generator.output
			second := domain.GeneratedGuide{Title: "別の目的", Steps: []domain.GeneratedGuideStep{{SourceArtifactID: "initial", Instruction: "戻るを押す"}}}
			if invalid {
				second.Steps[0].SourceArtifactID = "not_an_input"
			}
			generator.outputs = []domain.GeneratedGuide{first, second}
			if processed, err := worker.RunOnce(context.Background()); err != nil || !processed {
				t.Fatalf("run: %t, %v", processed, err)
			}
			if invalid {
				if len(tx.drafts) != 0 || tx.job.Status != domain.GuideGenerationJobFailed || *tx.job.ErrorCode != domain.GuideGenerationAIInvalidOutput {
					t.Fatalf("partially accepted invalid output: %+v", tx)
				}
			} else if len(tx.drafts) != 2 || tx.drafts[0].Position != 1 || tx.drafts[1].Position != 2 || tx.drafts[1].SupportSessionID != tx.session.ID || *tx.session.GuideDraftID != tx.drafts[0].ID {
				t.Fatalf("grouped drafts: %+v", tx.drafts)
			}
		})
	}
}
