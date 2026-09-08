package service

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/repository"
)

const (
	guideIntegrationUser    = "user_guide_integration"
	guideIntegrationFamily  = "family_guide_integration"
	guideIntegrationRequest = "request_guide_integration"
	guideIntegrationSession = "session_guide_integration"
	guideIntegrationInitial = "artifact_guide_integration_initial"
	guideIntegrationHelp    = "artifact_guide_integration_help"
)

func TestGuideFlowPostgresIntegration(t *testing.T) {
	databaseURL := os.Getenv("MITE_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("MITE_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect test database: %v", err)
	}
	defer pool.Close()
	if err := cleanupGuideIntegrationFixture(ctx, pool); err != nil {
		t.Fatalf("pre-clean integration fixture: %v", err)
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		if cleanupErr := cleanupGuideIntegrationFixture(cleanupCtx, pool); cleanupErr != nil {
			t.Errorf("clean integration fixture: %v", cleanupErr)
		}
	}()

	now := time.Date(2026, 9, 4, 2, 0, 0, 0, time.UTC)
	if err := createGuideIntegrationFixture(ctx, pool, now); err != nil {
		t.Fatalf("create integration fixture: %v", err)
	}
	initialJPEG := jpegFixture(t, 20)
	helpJPEG := jpegFixture(t, 30)
	storage := &fakeGuideStorage{objects: map[string][]byte{
		guideIntegrationUser + "/" + guideIntegrationInitial + ".jpg": initialJPEG,
		guideIntegrationUser + "/" + guideIntegrationHelp + ".jpg":    helpJPEG,
	}}
	store := repository.NewGuideRepository(pool)
	guideService := NewGuideService(store, storage, nil, nil)
	clock := now
	guideService.now = func() time.Time { return clock }
	var ids atomic.Int64
	guideService.newID = func(prefix string) domain.ID {
		return domain.ID(prefix + "guide_integration_" + string(rune('a'+ids.Add(1))))
	}
	user := domain.Actor{ID: guideIntegrationUser, Role: domain.RoleUser}
	family := domain.Actor{ID: guideIntegrationFamily, Role: domain.RoleFamily}
	userCommandMeta := func(key string) CommandMeta {
		return CommandMeta{Actor: user, Key: key, RequestID: "req_guide_integration"}
	}
	familyCommandMeta := func(key string) CommandMeta {
		return CommandMeta{Actor: family, Key: key, RequestID: "req_guide_integration"}
	}

	capturedAt := now.Add(time.Second)
	batchCommand := CreateGuideMaterialBatchCommand{Meta: userCommandMeta("batch-create"), SupportSessionID: guideIntegrationSession, ExpectedSessionRevision: 3, CaptureIntervalSeconds: 10, CapturedFrom: &capturedAt, CapturedTo: &capturedAt, ExpectedItemCount: 1}
	batchCreated, err := guideService.CreateGuideMaterialBatch(ctx, batchCommand)
	if err != nil {
		t.Fatalf("create batch: %v", err)
	}
	if replayed, err := guideService.CreateGuideMaterialBatch(ctx, batchCommand); err != nil || replayed.Batch.ID != batchCreated.Batch.ID {
		t.Fatalf("replay batch: result=%+v err=%v", replayed, err)
	}
	batchView, err := guideService.GetGuideMaterialBatch(ctx, family, batchCreated.Batch.ID)
	if err != nil || len(batchView.Materials) != 0 {
		t.Fatalf("get empty batch: view=%+v err=%v", batchView, err)
	}
	materialCommands := []CreateGuideMaterialCommand{
		{Meta: userCommandMeta("material-create-a"), BatchID: batchCreated.Batch.ID, ClientCaptureID: "capture_guide_integration_a", Sequence: 1, CapturedAt: capturedAt, JPEG: jpegFixture(t, 40)},
		{Meta: userCommandMeta("material-create-b"), BatchID: batchCreated.Batch.ID, ClientCaptureID: "capture_guide_integration_b", Sequence: 1, CapturedAt: capturedAt, JPEG: jpegFixture(t, 50)},
	}
	storage.putErr = errors.New("temporary storage failure")
	if _, _, err := guideService.CreateGuideMaterial(ctx, materialCommands[0]); errorCodeOf(err) != domain.CodeExternalServiceUnavailable {
		t.Fatalf("expected retryable storage error, got %v", err)
	}
	storage.putErr = nil
	type materialOutcome struct {
		command CreateGuideMaterialCommand
		result  GuideMaterialCreated
		status  int
		err     error
	}
	materialOutcomes := make(chan materialOutcome, len(materialCommands))
	for _, command := range materialCommands {
		command := command
		go func() {
			result, status, createErr := guideService.CreateGuideMaterial(ctx, command)
			materialOutcomes <- materialOutcome{command: command, result: result, status: status, err: createErr}
		}()
	}
	var materialCommand CreateGuideMaterialCommand
	var materialCreated GuideMaterialCreated
	createdCount, conflictCount := 0, 0
	for range materialCommands {
		outcome := <-materialOutcomes
		switch {
		case outcome.err == nil && outcome.status == 201:
			createdCount++
			materialCommand, materialCreated = outcome.command, outcome.result
		case outcome.status == 409 && errorCodeOf(outcome.err) == domain.CodeMaterialConflict:
			conflictCount++
		default:
			t.Fatalf("unexpected parallel material outcome: %+v", outcome)
		}
	}
	if createdCount != 1 || conflictCount != 1 {
		t.Fatalf("parallel material counts: created=%d conflict=%d", createdCount, conflictCount)
	}
	batchView, err = guideService.GetGuideMaterialBatch(ctx, user, batchCreated.Batch.ID)
	if err != nil || len(batchView.Materials) != 1 || batchView.Batch.ReceivedItemCount != 1 {
		t.Fatalf("get populated batch: view=%+v err=%v", batchView, err)
	}
	completeBatchCommand := CompleteGuideMaterialBatchCommand{Meta: userCommandMeta("batch-complete"), BatchID: batchCreated.Batch.ID, ExpectedBatchRevision: materialCreated.Batch.Revision, ExpectedItemCount: 1}
	completed, err := guideService.CompleteGuideMaterialBatch(ctx, completeBatchCommand)
	if err != nil {
		t.Fatalf("complete batch: %v", err)
	}
	if _, err := guideService.GetGuideGenerationJob(ctx, family, completed.Job.ID); err != nil {
		t.Fatalf("get queued job: %v", err)
	}

	generator := &fakeGenerator{err: &GuideGenerationFailure{Code: domain.GuideGenerationAIRefusal}}
	worker := NewGuideWorker(store, storage, generator, nil, nil)
	clock = now.Add(2 * time.Second)
	worker.now = func() time.Time { return clock }
	worker.newID = func(prefix string) domain.ID { return domain.ID(prefix + "guide_integration") }
	if err := store.WithinTx(ctx, pgx.TxOptions{}, func(tx repository.GuideTx) error {
		_, claimErr := tx.ClaimJob(ctx, timestamp(clock))
		return claimErr
	}); err != nil {
		t.Fatalf("claim job before recovery: %v", err)
	}
	if err := worker.Recover(ctx); err != nil {
		t.Fatalf("recover running job: %v", err)
	}
	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("run failed attempt: processed=%v err=%v", processed, err)
	}
	failed, err := guideService.GetGuideGenerationJob(ctx, family, completed.Job.ID)
	if err != nil || failed.Status != domain.GuideGenerationJobFailed || failed.Attempt != 2 {
		t.Fatalf("get failed job: job=%+v err=%v", failed, err)
	}
	retryCommand := RetryGuideGenerationJobCommand{Meta: familyCommandMeta("job-retry"), JobID: failed.ID, ExpectedJobRevision: failed.Revision}
	retried, err := guideService.RetryGuideGenerationJob(ctx, retryCommand)
	if err != nil || retried.Status != domain.GuideGenerationJobQueued {
		t.Fatalf("retry job: job=%+v err=%v", retried, err)
	}
	generator.err = nil
	clock = now.Add(3 * time.Second)
	generator.output = domain.GeneratedGuide{Title: "設定を確認する", Steps: []domain.GeneratedGuideStep{{SourceArtifactID: guideIntegrationInitial, Instruction: "設定画面を確認する"}}}
	if processed, err := worker.RunOnce(ctx); err != nil || !processed {
		t.Fatalf("run successful attempt: processed=%v err=%v", processed, err)
	}
	succeeded, err := guideService.GetGuideGenerationJob(ctx, user, completed.Job.ID)
	if err != nil || succeeded.Status != domain.GuideGenerationJobSucceeded || succeeded.GuideDraftID == nil || succeeded.Attempt != 3 {
		t.Fatalf("get succeeded job: job=%+v err=%v", succeeded, err)
	}

	draft, err := guideService.GetGuideDraft(ctx, user, *succeeded.GuideDraftID)
	if err != nil {
		t.Fatalf("get draft: %v", err)
	}

	// A family can add a same-session capture that the generator did not select.
	if len(draft.Steps) != 1 {
		t.Fatalf("expected one AI step: %+v", draft.Steps)
	}
	candidate := domain.GuideStep{Position: 2, ArtifactID: materialCreated.Material.ArtifactID, Instruction: "保存ボタンを押す"}
	assertRejected := func(actor domain.Actor, steps []domain.GuideStep, expected domain.ErrorCode) {
		t.Helper()
		_, err := guideService.UpdateGuideDraft(ctx, UpdateGuideDraftCommand{Actor: actor, DraftID: draft.ID, ExpectedRevision: draft.Revision, Title: draft.Title, Steps: steps})
		if errorCodeOf(err) != expected {
			t.Fatalf("expected %s: %v", expected, err)
		}
		unchanged, err := guideService.GetGuideDraft(ctx, user, draft.ID)
		if err != nil || unchanged.Revision != draft.Revision || len(unchanged.Steps) != 1 {
			t.Fatalf("rejected edit changed draft: %+v %v", unchanged, err)
		}
	}
	assertRejected(user, append(append([]domain.GuideStep{}, draft.Steps...), candidate), domain.CodeForbidden)
	assertRejected(domain.Actor{ID: "family_outsider", Role: domain.RoleFamily}, draft.Steps, domain.CodeForbidden)
	foreign := candidate
	foreign.ArtifactID = guideIntegrationHelp // Same owner, but not a source for this session.
	assertRejected(family, append(append([]domain.GuideStep{}, draft.Steps...), foreign), domain.CodeValidationError)
	tooMany := make([]domain.GuideStep, 9)
	for i := range tooMany {
		tooMany[i] = domain.GuideStep{Position: i + 1, ArtifactID: guideIntegrationInitial, Instruction: "説明"}
	}
	assertRejected(family, tooMany, domain.CodeValidationError)
	t.Run("reject material with a different owner", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `UPDATE artifacts SET owner_user_id=$1 WHERE id=$2`, guideIntegrationFamily, candidate.ArtifactID); err != nil {
			t.Fatal(err)
		}
		defer func() {
			_, _ = pool.Exec(ctx, `UPDATE artifacts SET owner_user_id=$1 WHERE id=$2`, guideIntegrationUser, candidate.ArtifactID)
		}()
		assertRejected(family, append(append([]domain.GuideStep{}, draft.Steps...), candidate), domain.CodeValidationError)
	})
	t.Run("reject a source queued for deletion", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `INSERT INTO artifact_deletion_tasks (id,artifact_id,storage_key,status,attempt,next_attempt_at,created_at) SELECT 'deletion_guide_integration_rejected',id,storage_key,'PENDING',0,$2,$2 FROM artifacts WHERE id=$1`, candidate.ArtifactID, now); err != nil {
			t.Fatal(err)
		}
		defer func() {
			_, _ = pool.Exec(ctx, `DELETE FROM artifact_deletion_tasks WHERE id='deletion_guide_integration_rejected'`)
		}()
		assertRejected(family, append(append([]domain.GuideStep{}, draft.Steps...), candidate), domain.CodeValidationError)
	})
	draft.Steps = append(draft.Steps, candidate)
	draft.Title = "保存手順"
	draft, err = guideService.UpdateGuideDraft(ctx, UpdateGuideDraftCommand{Actor: family, DraftID: draft.ID, ExpectedRevision: draft.Revision, Title: draft.Title, Steps: draft.Steps})
	if err != nil {
		t.Fatalf("update draft: %v", err)
	}
	saveCommand := SaveGuideDraftCommand{Meta: familyCommandMeta("draft-save"), DraftID: draft.ID, ExpectedRevision: draft.Revision}
	saved, err := guideService.SaveGuideDraft(ctx, saveCommand)
	if err != nil {
		t.Fatalf("save draft: %v", err)
	}
	if replayed, err := guideService.SaveGuideDraft(ctx, saveCommand); err != nil || replayed.Guide.Guide.ID != saved.Guide.Guide.ID {
		t.Fatalf("replay saved draft: result=%+v err=%v", replayed, err)
	}
	if replayed, status, err := guideService.CreateGuideMaterial(ctx, materialCommand); err != nil || status != 201 || replayed.Material.ID != materialCreated.Material.ID || storage.puts != 2 {
		t.Fatalf("replay material after cleanup: result=%+v status=%d puts=%d err=%v", replayed, status, storage.puts, err)
	}
	if replayed, err := guideService.CompleteGuideMaterialBatch(ctx, completeBatchCommand); err != nil || replayed.Job.ID != completed.Job.ID {
		t.Fatalf("replay batch completion after cleanup: result=%+v err=%v", replayed, err)
	}
	if replayed, err := guideService.RetryGuideGenerationJob(ctx, retryCommand); err != nil || replayed.Status != domain.GuideGenerationJobQueued {
		t.Fatalf("replay retry after cleanup: result=%+v err=%v", replayed, err)
	}
	guides, err := guideService.ListGuides(ctx, user)
	if err != nil || len(guides) != 1 || guides[0].ID != saved.Guide.Guide.ID {
		t.Fatalf("list guides: guides=%+v err=%v", guides, err)
	}
	guide, err := guideService.GetGuide(ctx, user, saved.Guide.Guide.ID)
	if err != nil || len(guide.CurrentVersion.Steps) != 2 {
		t.Fatalf("get guide: guide=%+v err=%v", guide, err)
	}

	run, err := guideService.CreateGuideRun(ctx, CreateGuideRunCommand{Meta: userCommandMeta("run-create"), GuideID: guide.Guide.ID})
	if err != nil {
		t.Fatalf("create run: %v", err)
	}
	run, err = guideService.UpdateGuideRun(ctx, UpdateGuideRunCommand{Actor: user, RunID: run.ID, ExpectedRevision: run.Revision, Action: domain.GuideRunNext})
	if err != nil || run.CurrentStepNumber != 2 {
		t.Fatalf("update run: run=%+v err=%v", run, err)
	}
	completeRunCommand := CompleteGuideRunCommand{Meta: userCommandMeta("run-complete"), RunID: run.ID, ExpectedRevision: run.Revision}
	run, err = guideService.CompleteGuideRun(ctx, completeRunCommand)
	if err != nil || run.Status != domain.GuideRunCompleted {
		t.Fatalf("complete run: run=%+v err=%v", run, err)
	}
	if got, err := guideService.GetGuideRun(ctx, user, run.ID); err != nil || got.Status != domain.GuideRunCompleted {
		t.Fatalf("get completed run: run=%+v err=%v", got, err)
	}
	if replayed, err := guideService.CompleteGuideRun(ctx, completeRunCommand); err != nil || replayed.Status != domain.GuideRunCompleted {
		t.Fatalf("replay completed run: result=%+v err=%v", replayed, err)
	}

	helpRun, err := guideService.CreateGuideRun(ctx, CreateGuideRunCommand{Meta: userCommandMeta("help-run-create"), GuideID: guide.Guide.ID})
	if err != nil {
		t.Fatalf("create help run: %v", err)
	}
	if saved.SupportSession.Status != domain.SupportSessionGuideSaved || saved.SupportSession.EndedAt != nil || saved.SupportSession.EndReason != nil {
		t.Fatalf("save ended call: %+v", saved.SupportSession)
	}
	sessions := NewSupportSessionService(repository.NewPostgresSupportSessionStore(pool), nil, &fakeTokenIssuer{}, nil)
	if _, err := sessions.CreateLiveKitToken(ctx, family, string(saved.SupportSession.ID)); err != nil {
		t.Fatalf("saved call reconnect: %v", err)
	}
	ended, err := sessions.End(ctx, family, string(saved.SupportSession.ID), saved.SupportSession.Revision, "guide-integration-end", "guide-integration-end")
	if err != nil || ended.Status != domain.SupportSessionEnded {
		t.Fatalf("manual end: %+v %v", ended, err)
	}
	helpCommand := CreateSupportRequestFromGuideRunCommand{Meta: userCommandMeta("help-request"), RunID: helpRun.ID, ExpectedRevision: helpRun.Revision, InitialScreenshotArtifactID: guideIntegrationHelp, Comment: "保存ボタンが見つからない"}
	help, err := guideService.CreateSupportRequestFromGuideRun(ctx, helpCommand)
	if err != nil || help.GuideRun.Status != domain.GuideRunPausedForSupport || help.SupportRequest.GuideContext == nil || help.SupportRequest.GuideContext.GuideRunID != helpRun.ID {
		t.Fatalf("create support request from run: result=%+v err=%v", help, err)
	}
	if replayed, err := guideService.CreateSupportRequestFromGuideRun(ctx, helpCommand); err != nil || replayed.SupportRequest.ID != help.SupportRequest.ID {
		t.Fatalf("replay support request from run: result=%+v err=%v", replayed, err)
	}
}

func errorCodeOf(err error) domain.ErrorCode {
	code, _ := domain.ErrorCodeOf(err)
	return code
}

func createGuideIntegrationFixture(ctx context.Context, pool *pgxpool.Pool, now time.Time) error {
	transaction, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO users (id, role, display_name) VALUES ($1, 'USER', 'Guide integration user'), ($2, 'FAMILY', 'Guide integration family')`, []any{guideIntegrationUser, guideIntegrationFamily}},
		{`INSERT INTO user_pairs (user_id, family_id) VALUES ($1, $2)`, []any{guideIntegrationUser, guideIntegrationFamily}},
		{`INSERT INTO artifacts (id, owner_user_id, purpose, mime_type, storage_key, sha256, byte_size, width, height, captured_at, created_at, updated_at, revision) VALUES ($1,$3,'REQUEST_SCREENSHOT','image/jpeg',$3||'/'||$1||'.jpg',$4,10,2,2,$5,$5,$5,1), ($2,$3,'REQUEST_SCREENSHOT','image/jpeg',$3||'/'||$2||'.jpg',$4,10,2,2,$5,$5,$5,1)`, []any{guideIntegrationInitial, guideIntegrationHelp, guideIntegrationUser, strings.Repeat("a", 64), now.Add(-time.Minute)}},
		{`INSERT INTO support_requests (id,user_id,family_id,initial_screenshot_artifact_id,comment,status,support_session_id,guide_context,created_at,updated_at,revision) VALUES ($1,$2,$3,$4,'設定を保存したい','RESOLVED',NULL,NULL,$5,$5,3)`, []any{guideIntegrationRequest, guideIntegrationUser, guideIntegrationFamily, guideIntegrationInitial, now.Add(-time.Minute)}},
		{`INSERT INTO support_sessions (id,support_request_id,user_id,family_id,livekit_room_name,status,guide_decision,guide_material_batch_id,guide_generation_job_id,guide_draft_id,guide_id,consent,consented_at,started_at,ended_at,end_reason,created_at,updated_at,revision) VALUES ($1,$2,$3,$4,'mite-'||$1,'GENERATING_GUIDE','CREATE',NULL,NULL,NULL,NULL,'{"audio":true,"screenShare":true,"periodicCapture":true,"textVersion":"v2"}'::jsonb,$5,$5,NULL,NULL,$5,$5,3)`, []any{guideIntegrationSession, guideIntegrationRequest, guideIntegrationUser, guideIntegrationFamily, now.Add(-time.Minute)}},
		{`UPDATE support_requests SET support_session_id=$1 WHERE id=$2`, []any{guideIntegrationSession, guideIntegrationRequest}},
	} {
		if _, err := transaction.Exec(ctx, statement.query, statement.args...); err != nil {
			return err
		}
	}
	return transaction.Commit(ctx)
}

func cleanupGuideIntegrationFixture(ctx context.Context, pool *pgxpool.Pool) error {
	transaction, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	statements := []string{
		`DELETE FROM guide_runs WHERE user_id='user_guide_integration'`,
		`UPDATE support_requests SET support_session_id=NULL WHERE user_id='user_guide_integration'`,
		`UPDATE support_sessions SET status='GENERATING_GUIDE', guide_decision='CREATE', guide_material_batch_id=NULL, guide_generation_job_id=NULL, guide_draft_id=NULL, guide_id=NULL, ended_at=NULL, end_reason=NULL WHERE user_id='user_guide_integration'`,
		`DELETE FROM guide_generation_jobs WHERE batch_id IN (SELECT id FROM guide_material_batches WHERE support_session_id IN (SELECT id FROM support_sessions WHERE user_id='user_guide_integration'))`,
		`DELETE FROM guide_materials WHERE batch_id IN (SELECT id FROM guide_material_batches WHERE support_session_id IN (SELECT id FROM support_sessions WHERE user_id='user_guide_integration'))`,
		`DELETE FROM guide_material_batches WHERE support_session_id IN (SELECT id FROM support_sessions WHERE user_id='user_guide_integration')`,
		`DELETE FROM guide_drafts WHERE support_session_id IN (SELECT id FROM support_sessions WHERE user_id='user_guide_integration')`,
		`DELETE FROM support_sessions WHERE user_id='user_guide_integration'`,
		`DELETE FROM support_requests WHERE user_id='user_guide_integration'`,
		`DELETE FROM guide_version_steps WHERE guide_id IN (SELECT id FROM guides WHERE user_id='user_guide_integration')`,
		`DELETE FROM guide_versions WHERE guide_id IN (SELECT id FROM guides WHERE user_id='user_guide_integration')`,
		`DELETE FROM guides WHERE user_id='user_guide_integration'`,
		`DELETE FROM artifact_deletion_tasks WHERE artifact_id IN (SELECT id FROM artifacts WHERE owner_user_id='user_guide_integration') OR storage_key LIKE 'user_guide_integration/%'`,
		`DELETE FROM artifacts WHERE owner_user_id='user_guide_integration'`,
		`DELETE FROM idempotency_records WHERE actor_id IN ('user_guide_integration','family_guide_integration')`,
		`DELETE FROM user_pairs WHERE user_id='user_guide_integration' OR family_id='family_guide_integration'`,
		`DELETE FROM users WHERE id IN ('user_guide_integration','family_guide_integration')`,
	}
	for _, statement := range statements {
		if _, err := transaction.Exec(ctx, statement); err != nil {
			return err
		}
	}
	return transaction.Commit(ctx)
}
