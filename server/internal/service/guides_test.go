package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/repository"
)

type fakeGuideStore struct {
	mutex sync.Mutex
	tx    *fakeGuideTx
}

func (store *fakeGuideStore) WithinTx(_ context.Context, _ pgx.TxOptions, work func(repository.GuideTx) error) error {
	store.mutex.Lock()
	defer store.mutex.Unlock()
	return work(store.tx)
}

type fakeGuideTx struct {
	repository.GuideTx
	idempotency                                map[string]domain.IdempotencyRecord
	session                                    domain.SupportSession
	batch                                      domain.GuideMaterialBatch
	materials                                  []domain.GuideMaterial
	artifacts                                  map[domain.ID]domain.Artifact
	deletions                                  []domain.ArtifactDeletionTask
	job                                        domain.GuideGenerationJob
	draft                                      domain.GuideDraft
	allowed                                    map[domain.ID]struct{}
	guide                                      domain.GuideDetail
	versionSteps                               []domain.GuideStep
	unused                                     []repository.ArtifactReference
	supportRequest                             domain.SupportRequest
	activeSupport                              bool
	deletedJob, deletedMaterials, deletedBatch bool
	run                                        domain.GuideRun
	stepCount                                  int
}

func scopeKey(scope domain.IdempotencyScope) string {
	return string(scope.ActorID) + "|" + scope.Method + "|" + scope.Path + "|" + string(scope.Key)
}
func (tx *fakeGuideTx) GetIdempotency(_ context.Context, scope domain.IdempotencyScope) (domain.IdempotencyRecord, bool, error) {
	value, ok := tx.idempotency[scopeKey(scope)]
	return value, ok, nil
}
func (tx *fakeGuideTx) CreateIdempotency(_ context.Context, value domain.IdempotencyRecord) (domain.IdempotencyRecord, error) {
	tx.idempotency[scopeKey(value.Scope)] = value
	return value, nil
}
func (tx *fakeGuideTx) TakeOverIdempotency(_ context.Context, scope domain.IdempotencyScope, resourceID *domain.ID, _ domain.RequestHash, now pgtype.Timestamptz) (domain.IdempotencyRecord, bool, error) {
	value, ok := tx.idempotency[scopeKey(scope)]
	if !ok {
		return domain.IdempotencyRecord{}, false, nil
	}
	lease := now.Time.Add(domain.IdempotencyLease)
	value.LeaseExpiresAt = &lease
	if value.ResourceID == nil {
		value.ResourceID = resourceID
	}
	tx.idempotency[scopeKey(scope)] = value
	return value, true, nil
}
func (tx *fakeGuideTx) CompleteIdempotency(_ context.Context, scope domain.IdempotencyScope, status int, body json.RawMessage, now pgtype.Timestamptz) error {
	value := tx.idempotency[scopeKey(scope)]
	completed, expires := now.Time, now.Time.Add(domain.IdempotencyRetention)
	value.Status = domain.IdempotencyCompleted
	value.ResponseStatus = &status
	value.ResponseBody = append([]byte(nil), body...)
	value.LeaseExpiresAt = nil
	value.CompletedAt = &completed
	value.ExpiresAt = &expires
	tx.idempotency[scopeKey(scope)] = value
	return nil
}
func (tx *fakeGuideTx) ReleaseIdempotency(_ context.Context, scope domain.IdempotencyScope, now pgtype.Timestamptz) error {
	value := tx.idempotency[scopeKey(scope)]
	released := now.Time
	value.LeaseExpiresAt = &released
	tx.idempotency[scopeKey(scope)] = value
	return nil
}
func (tx *fakeGuideTx) GetSession(_ context.Context, id domain.ID, _ bool) (domain.SupportSession, error) {
	if tx.session.ID != id {
		return domain.SupportSession{}, pgx.ErrNoRows
	}
	return tx.session, nil
}
func (tx *fakeGuideTx) CreateBatch(_ context.Context, value domain.GuideMaterialBatch) (domain.GuideMaterialBatch, error) {
	tx.batch = value
	return value, nil
}
func (tx *fakeGuideTx) AttachBatch(_ context.Context, sessionID, batchID domain.ID, now pgtype.Timestamptz) (domain.SupportSession, error) {
	tx.session.GuideMaterialBatchID = &batchID
	tx.session.Revision++
	tx.session.UpdatedAt = now.Time
	return tx.session, nil
}
func (tx *fakeGuideTx) GetBatch(_ context.Context, id domain.ID, _ bool) (domain.GuideMaterialBatch, error) {
	if tx.batch.ID != id {
		return domain.GuideMaterialBatch{}, pgx.ErrNoRows
	}
	return tx.batch, nil
}
func (tx *fakeGuideTx) ListMaterials(_ context.Context, id domain.ID) ([]domain.GuideMaterial, error) {
	if tx.batch.ID != id {
		return nil, pgx.ErrNoRows
	}
	return append([]domain.GuideMaterial(nil), tx.materials...), nil
}
func (tx *fakeGuideTx) GetMaterialByCaptureID(_ context.Context, batchID domain.ID, captureID string) (repository.MaterialIdentity, error) {
	for _, material := range tx.materials {
		if material.BatchID == batchID && material.ClientCaptureID == captureID {
			return repository.MaterialIdentity{Material: material, SHA256: tx.artifacts[material.ArtifactID].SHA256}, nil
		}
	}
	return repository.MaterialIdentity{}, pgx.ErrNoRows
}
func (tx *fakeGuideTx) GetMaterialBySequence(_ context.Context, batchID domain.ID, sequence int) (repository.MaterialIdentity, error) {
	for _, material := range tx.materials {
		if material.BatchID == batchID && material.Sequence == sequence {
			return repository.MaterialIdentity{Material: material, SHA256: tx.artifacts[material.ArtifactID].SHA256}, nil
		}
	}
	return repository.MaterialIdentity{}, pgx.ErrNoRows
}
func (tx *fakeGuideTx) CreateArtifact(_ context.Context, value domain.Artifact) (domain.Artifact, error) {
	tx.artifacts[value.ID] = value
	return value, nil
}
func (tx *fakeGuideTx) GetArtifact(_ context.Context, id domain.ID) (domain.Artifact, error) {
	value, ok := tx.artifacts[id]
	if !ok {
		return domain.Artifact{}, pgx.ErrNoRows
	}
	return value, nil
}
func (tx *fakeGuideTx) CreateMaterial(_ context.Context, value domain.GuideMaterial) (domain.GuideMaterial, error) {
	tx.materials = append(tx.materials, value)
	return value, nil
}
func (tx *fakeGuideTx) IncrementBatch(_ context.Context, id domain.ID, now pgtype.Timestamptz) (domain.GuideMaterialBatch, error) {
	tx.batch.ReceivedItemCount++
	tx.batch.Revision++
	tx.batch.UpdatedAt = now.Time
	return tx.batch, nil
}
func (tx *fakeGuideTx) CreateDeletionTask(_ context.Context, value domain.ArtifactDeletionTask) error {
	tx.deletions = append(tx.deletions, value)
	return nil
}
func (tx *fakeGuideTx) GetMaterialManifest(_ context.Context, _ domain.ID) (repository.MaterialManifest, error) {
	if len(tx.materials) == 0 {
		return repository.MaterialManifest{}, nil
	}
	min, maxTime := tx.materials[0].CapturedAt, tx.materials[0].CapturedAt
	minSeq, maxSeq := tx.materials[0].Sequence, tx.materials[0].Sequence
	ids := map[string]struct{}{}
	sequences := map[int]struct{}{}
	for _, material := range tx.materials {
		ids[material.ClientCaptureID] = struct{}{}
		sequences[material.Sequence] = struct{}{}
		if material.Sequence < minSeq {
			minSeq = material.Sequence
		}
		if material.Sequence > maxSeq {
			maxSeq = material.Sequence
		}
		if material.CapturedAt.Before(min) {
			min = material.CapturedAt
		}
		if material.CapturedAt.After(maxTime) {
			maxTime = material.CapturedAt
		}
	}
	return repository.MaterialManifest{MaterialCount: len(tx.materials), CaptureIDCount: len(ids), MinSequence: minSeq, MaxSequence: maxSeq, SequenceCount: len(sequences), MinCapturedAt: pgtype.Timestamptz{Time: min, Valid: true}, MaxCapturedAt: pgtype.Timestamptz{Time: maxTime, Valid: true}}, nil
}
func (tx *fakeGuideTx) CompleteBatch(_ context.Context, _ domain.ID, now pgtype.Timestamptz) (domain.GuideMaterialBatch, error) {
	tx.batch.Status = domain.GuideMaterialBatchCompleted
	completed := now.Time
	tx.batch.CompletedAt = &completed
	tx.batch.Revision++
	tx.batch.UpdatedAt = now.Time
	return tx.batch, nil
}
func (tx *fakeGuideTx) CreateJob(_ context.Context, value domain.GuideGenerationJob) (domain.GuideGenerationJob, error) {
	tx.job = value
	return value, nil
}
func (tx *fakeGuideTx) AttachJob(_ context.Context, _ domain.ID, jobID domain.ID, now pgtype.Timestamptz) (domain.SupportSession, error) {
	tx.session.GuideGenerationJobID = &jobID
	tx.session.Revision++
	tx.session.UpdatedAt = now.Time
	return tx.session, nil
}
func (tx *fakeGuideTx) GetJob(_ context.Context, id domain.ID, _ bool) (domain.GuideGenerationJob, error) {
	if tx.job.ID != id {
		return domain.GuideGenerationJob{}, pgx.ErrNoRows
	}
	return tx.job, nil
}
func (tx *fakeGuideTx) GetSessionByJob(_ context.Context, id domain.ID) (domain.SupportSession, error) {
	if tx.job.ID != id {
		return domain.SupportSession{}, pgx.ErrNoRows
	}
	return tx.session, nil
}
func (tx *fakeGuideTx) RetryJob(_ context.Context, _ domain.ID, now pgtype.Timestamptz) (domain.GuideGenerationJob, error) {
	tx.job.Status = domain.GuideGenerationJobQueued
	tx.job.ErrorCode = nil
	tx.job.StartedAt = nil
	tx.job.FinishedAt = nil
	tx.job.UpdatedAt = now.Time
	tx.job.Revision++
	return tx.job, nil
}
func (tx *fakeGuideTx) GetSessionByDraft(_ context.Context, id domain.ID) (domain.SupportSession, error) {
	if tx.draft.ID != id {
		return domain.SupportSession{}, pgx.ErrNoRows
	}
	return tx.session, nil
}
func (tx *fakeGuideTx) GetDraft(_ context.Context, id domain.ID, _ bool) (domain.GuideDraft, error) {
	if tx.draft.ID != id {
		return domain.GuideDraft{}, pgx.ErrNoRows
	}
	return tx.draft, nil
}
func (tx *fakeGuideTx) ListAllowedDraftArtifacts(_ context.Context, _ domain.ID) (map[domain.ID]struct{}, error) {
	result := map[domain.ID]struct{}{}
	for id := range tx.allowed {
		result[id] = struct{}{}
	}
	return result, nil
}
func (tx *fakeGuideTx) UpdateDraft(_ context.Context, _ domain.ID, title string, steps []domain.GuideStep, now pgtype.Timestamptz) (domain.GuideDraft, error) {
	tx.draft.Title = title
	tx.draft.Steps = append([]domain.GuideStep(nil), steps...)
	tx.draft.Revision++
	tx.draft.UpdatedAt = now.Time
	return tx.draft, nil
}
func (tx *fakeGuideTx) CreateGuide(_ context.Context, value domain.Guide) (domain.Guide, error) {
	tx.guide.Guide = value
	return value, nil
}
func (tx *fakeGuideTx) CreateGuideVersion(_ context.Context, value domain.GuideVersion) (domain.GuideVersion, error) {
	tx.guide.CurrentVersion = value
	return value, nil
}
func (tx *fakeGuideTx) CreateGuideVersionStep(_ context.Context, _ domain.ID, step domain.GuideStep) (domain.GuideStep, error) {
	tx.versionSteps = append(tx.versionSteps, step)
	return step, nil
}
func (tx *fakeGuideTx) PromoteArtifact(_ context.Context, id domain.ID, _ pgtype.Timestamptz) error {
	artifact := tx.artifacts[id]
	if artifact.Purpose == domain.ArtifactPurposeGuideMaterial {
		artifact.Purpose = domain.ArtifactPurposeGuideStep
		artifact.Revision++
		tx.artifacts[id] = artifact
	}
	return nil
}
func (tx *fakeGuideTx) ListUnusedArtifacts(_ context.Context, _ domain.ID, _ []domain.ID) ([]repository.ArtifactReference, error) {
	return append([]repository.ArtifactReference(nil), tx.unused...), nil
}
func (tx *fakeGuideTx) SaveDraft(_ context.Context, _ domain.ID, now pgtype.Timestamptz) (domain.GuideDraft, error) {
	tx.draft.Status = domain.GuideDraftSaved
	tx.draft.Revision++
	tx.draft.UpdatedAt = now.Time
	return tx.draft, nil
}
func (tx *fakeGuideTx) FinishGuideSession(_ context.Context, _ domain.ID, guideID domain.ID, now pgtype.Timestamptz) (domain.SupportSession, error) {
	tx.session.Status = domain.SupportSessionEnded
	tx.session.GuideMaterialBatchID = nil
	tx.session.GuideGenerationJobID = nil
	tx.session.GuideID = &guideID
	reason := domain.EndReasonGuideSaved
	tx.session.EndReason = &reason
	tx.session.EndedAt = &now.Time
	tx.session.Revision++
	return tx.session, nil
}
func (tx *fakeGuideTx) DeleteGenerationJob(_ context.Context, _ domain.ID) error {
	tx.deletedJob = true
	return nil
}
func (tx *fakeGuideTx) DeleteMaterials(_ context.Context, _ domain.ID) error {
	tx.deletedMaterials = true
	return nil
}
func (tx *fakeGuideTx) DeleteBatch(_ context.Context, _ domain.ID) error {
	tx.deletedBatch = true
	return nil
}
func (tx *fakeGuideTx) ListGuides(_ context.Context, userID domain.ID) ([]domain.GuideSummary, error) {
	if tx.guide.Guide.UserID != userID {
		return []domain.GuideSummary{}, nil
	}
	return []domain.GuideSummary{{ID: tx.guide.Guide.ID, Title: tx.guide.Guide.Title, CurrentVersionNumber: tx.guide.Guide.CurrentVersionNumber, RepresentativeArtifactID: tx.guide.RepresentativeArtifactID, UpdatedAt: tx.guide.Guide.UpdatedAt}}, nil
}
func (tx *fakeGuideTx) GetGuide(_ context.Context, id domain.ID) (domain.GuideDetail, error) {
	if tx.guide.Guide.ID != id {
		return domain.GuideDetail{}, pgx.ErrNoRows
	}
	return tx.guide, nil
}
func (tx *fakeGuideTx) CreateRun(_ context.Context, value domain.GuideRun) (domain.GuideRun, error) {
	tx.run = value
	return value, nil
}
func (tx *fakeGuideTx) GetRun(_ context.Context, id domain.ID, _ bool) (domain.GuideRun, error) {
	if tx.run.ID != id {
		return domain.GuideRun{}, pgx.ErrNoRows
	}
	return tx.run, nil
}
func (tx *fakeGuideTx) GetPair(_ context.Context, _ domain.ID) (domain.UserPair, error) {
	return domain.UserPair{UserID: "user_demo", FamilyID: "family_demo"}, nil
}
func (tx *fakeGuideTx) LockUser(_ context.Context, _ domain.ID) error { return nil }
func (tx *fakeGuideTx) GetStepCount(_ context.Context, _ domain.ID, _ int) (int, error) {
	return tx.stepCount, nil
}
func (tx *fakeGuideTx) MoveRun(_ context.Context, _ domain.ID, step int, now pgtype.Timestamptz) (domain.GuideRun, error) {
	tx.run.CurrentStepNumber = step
	tx.run.Revision++
	tx.run.UpdatedAt = now.Time
	return tx.run, nil
}
func (tx *fakeGuideTx) CompleteRun(_ context.Context, _ domain.ID, now pgtype.Timestamptz) (domain.GuideRun, error) {
	tx.run.Status = domain.GuideRunCompleted
	tx.run.CompletedAt = &now.Time
	tx.run.UpdatedAt = now.Time
	tx.run.Revision++
	return tx.run, nil
}
func (tx *fakeGuideTx) HasActiveSupportFlow(_ context.Context, _ domain.ID) (bool, error) {
	return tx.activeSupport, nil
}
func (tx *fakeGuideTx) GetGuideContextStep(_ context.Context, _ domain.GuideRun) (repository.GuideContextStep, error) {
	step := tx.guide.CurrentVersion.Steps[tx.run.CurrentStepNumber-1]
	return repository.GuideContextStep{Title: tx.guide.Guide.Title, Instruction: step.Instruction, ArtifactID: step.ArtifactID}, nil
}
func (tx *fakeGuideTx) CreateSupportRequest(_ context.Context, value domain.SupportRequest) (domain.SupportRequest, error) {
	tx.supportRequest = value
	return value, nil
}
func (tx *fakeGuideTx) PauseRun(_ context.Context, _ domain.ID, requestID domain.ID, now pgtype.Timestamptz) (domain.GuideRun, error) {
	tx.run.Status = domain.GuideRunPausedForSupport
	tx.run.SupportRequestID = &requestID
	tx.run.PausedAt = &now.Time
	tx.run.UpdatedAt = now.Time
	tx.run.Revision++
	return tx.run, nil
}

type fakeGuideStorage struct {
	mutex   sync.Mutex
	objects map[string][]byte
	putErr  error
	puts    int
}

func (storage *fakeGuideStorage) Put(_ context.Context, key string, body io.Reader, _ int64, _ string) error {
	if storage.putErr != nil {
		return storage.putErr
	}
	data, _ := io.ReadAll(body)
	storage.mutex.Lock()
	defer storage.mutex.Unlock()
	storage.objects[key] = data
	storage.puts++
	return nil
}
func (storage *fakeGuideStorage) Get(_ context.Context, key string) (repository.StoredObject, error) {
	storage.mutex.Lock()
	defer storage.mutex.Unlock()
	value, ok := storage.objects[key]
	if !ok {
		return repository.StoredObject{}, errors.New("missing")
	}
	return repository.StoredObject{Body: io.NopCloser(bytes.NewReader(value)), ContentType: "image/jpeg", Size: int64(len(value))}, nil
}
func (storage *fakeGuideStorage) Delete(_ context.Context, key string) error {
	storage.mutex.Lock()
	defer storage.mutex.Unlock()
	delete(storage.objects, key)
	return nil
}

func newGuideServiceForTest(tx *fakeGuideTx, storage *fakeGuideStorage) *GuideService {
	service := NewGuideService(&fakeGuideStore{tx: tx}, storage, nil, nil)
	fixed := time.Date(2026, 9, 4, 1, 2, 3, 0, time.UTC)
	service.now = func() time.Time { return fixed }
	var sequence atomic.Int64
	service.newID = func(prefix string) domain.ID { return domain.ID(prefix + strconv.FormatInt(sequence.Add(1), 10)) }
	return service
}

func guideFixture() (*fakeGuideTx, time.Time) {
	now := time.Date(2026, 9, 4, 0, 0, 0, 0, time.UTC)
	decision := domain.GuideDecisionCreate
	batchID := domain.ID("batch_1")
	tx := &fakeGuideTx{idempotency: map[string]domain.IdempotencyRecord{}, artifacts: map[domain.ID]domain.Artifact{}, session: domain.SupportSession{ID: "session_1", UserID: "user_demo", FamilyID: "family_demo", Status: domain.SupportSessionGeneratingGuide, GuideDecision: &decision, Revision: 3}, batch: domain.GuideMaterialBatch{ID: batchID, SupportSessionID: "session_1", Status: domain.GuideMaterialBatchUploading, CaptureIntervalSeconds: 5, ExpectedItemCount: 1, CapturedFrom: now, CapturedTo: now, CreatedAt: now, UpdatedAt: now, Revision: 1}}
	tx.session.GuideMaterialBatchID = &batchID
	return tx, now
}

func userMeta(key string) CommandMeta {
	return CommandMeta{Actor: domain.Actor{ID: "user_demo", Role: domain.RoleUser}, Key: key, RequestID: "req_1"}
}
func familyMeta(key string) CommandMeta {
	return CommandMeta{Actor: domain.Actor{ID: "family_demo", Role: domain.RoleFamily}, Key: key, RequestID: "req_1"}
}

func jpegFixture(t *testing.T, value uint8) []byte {
	t.Helper()
	imageValue := image.NewRGBA(image.Rect(0, 0, 2, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < 2; x++ {
			imageValue.Set(x, y, color.RGBA{R: value, G: value, B: value, A: 255})
		}
	}
	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, imageValue, nil); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestCreateGuideMaterialBatchIdempotencyAndValidation(t *testing.T) {
	t.Parallel()
	tx, now := guideFixture()
	tx.batch = domain.GuideMaterialBatch{}
	tx.session.GuideMaterialBatchID = nil
	service := newGuideServiceForTest(tx, &fakeGuideStorage{objects: map[string][]byte{}})
	command := CreateGuideMaterialBatchCommand{Meta: userMeta("batch-key"), SupportSessionID: "session_1", ExpectedSessionRevision: 3, CaptureIntervalSeconds: 5, CapturedFrom: &now, CapturedTo: &now, ExpectedItemCount: 1}
	first, err := service.CreateGuideMaterialBatch(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if first.Batch.Revision != 1 || first.SupportSession.Revision != 4 {
		t.Fatalf("first = %+v", first)
	}
	tx.session.Revision = 99
	replayed, err := service.CreateGuideMaterialBatch(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if replayed.SupportSession.Revision != 4 || replayed.Batch.ID != first.Batch.ID {
		t.Fatalf("replay = %+v", replayed)
	}
	command.ExpectedItemCount = 2
	_, err = service.CreateGuideMaterialBatch(context.Background(), command)
	if code, ok := domain.ErrorCodeOf(err); !ok || code != domain.CodeIdempotencyKeyReused {
		t.Fatalf("reused error = %v", err)
	}
}

func TestCreateGuideMaterialBatchNoMaterialsAndRole(t *testing.T) {
	t.Parallel()
	tx, _ := guideFixture()
	tx.batch = domain.GuideMaterialBatch{}
	tx.session.GuideMaterialBatchID = nil
	service := newGuideServiceForTest(tx, nil)
	command := CreateGuideMaterialBatchCommand{Meta: userMeta("empty"), SupportSessionID: "session_1", ExpectedSessionRevision: 3, CaptureIntervalSeconds: 5, ExpectedItemCount: 0}
	_, err := service.CreateGuideMaterialBatch(context.Background(), command)
	if code, ok := domain.ErrorCodeOf(err); !ok || code != domain.CodeInsufficientMaterials {
		t.Fatalf("zero materials error = %v", err)
	}
	command.Meta = familyMeta("family")
	_, err = service.CreateGuideMaterialBatch(context.Background(), command)
	if code, ok := domain.ErrorCodeOf(err); !ok || code != domain.CodeForbidden {
		t.Fatalf("family error = %v", err)
	}
}

func TestCreateGuideMaterialNewDuplicateConflictAndStorageFailure(t *testing.T) {
	t.Parallel()
	tx, capturedAt := guideFixture()
	storage := &fakeGuideStorage{objects: map[string][]byte{}}
	service := newGuideServiceForTest(tx, storage)
	jpegOne := jpegFixture(t, 10)
	if _, _, _, err := validateGuideMaterialJPEG(jpegOne[:len(jpegOne)-10]); err == nil {
		t.Fatal("truncated JPEG was accepted")
	}
	command := CreateGuideMaterialCommand{Meta: userMeta("material-1"), BatchID: "batch_1", ClientCaptureID: "capture_1", Sequence: 1, CapturedAt: capturedAt, JPEG: jpegOne}
	created, status, err := service.CreateGuideMaterial(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if status != 201 || created.Batch.ReceivedItemCount != 1 || created.Batch.Revision != 2 || len(tx.materials) != 1 {
		t.Fatalf("created=%+v status=%d materials=%d", created, status, len(tx.materials))
	}
	storedBatch := tx.batch
	tx.batch = domain.GuideMaterialBatch{}
	replayed, status, err := service.CreateGuideMaterial(context.Background(), command)
	tx.batch = storedBatch
	if err != nil || status != 201 || replayed.Material.ID != created.Material.ID || storage.puts != 1 {
		t.Fatalf("material replay after batch cleanup: result=%+v status=%d puts=%d err=%v", replayed, status, storage.puts, err)
	}
	command.Meta = userMeta("material-2")
	duplicate, status, err := service.CreateGuideMaterial(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if status != 200 || duplicate.Material.ID != created.Material.ID || len(tx.materials) != 1 || len(tx.deletions) != 1 {
		t.Fatalf("duplicate=%+v status=%d materials=%d deletions=%d", duplicate, status, len(tx.materials), len(tx.deletions))
	}
	command.Meta = userMeta("material-3")
	command.JPEG = jpegFixture(t, 200)
	_, status, err = service.CreateGuideMaterial(context.Background(), command)
	if code, ok := domain.ErrorCodeOf(err); !ok || code != domain.CodeMaterialConflict || status != 409 {
		t.Fatalf("conflict status=%d error=%v", status, err)
	}
	failingTx, _ := guideFixture()
	failingStorage := &fakeGuideStorage{objects: map[string][]byte{}, putErr: errors.New("down")}
	failingService := newGuideServiceForTest(failingTx, failingStorage)
	_, _, err = failingService.CreateGuideMaterial(context.Background(), CreateGuideMaterialCommand{Meta: userMeta("failed"), BatchID: "batch_1", ClientCaptureID: "capture", Sequence: 1, CapturedAt: capturedAt, JPEG: jpegOne})
	if code, ok := domain.ErrorCodeOf(err); !ok || code != domain.CodeExternalServiceUnavailable {
		t.Fatalf("storage error=%v", err)
	}
	for _, record := range failingTx.idempotency {
		if record.LeaseExpiresAt == nil || !record.LeaseExpiresAt.Equal(failingService.now()) {
			t.Fatalf("known storage failure lease = %v, want released at %v", record.LeaseExpiresAt, failingService.now())
		}
	}

	unknownTx, _ := guideFixture()
	unknownStorage := &fakeGuideStorage{objects: map[string][]byte{}, putErr: &repository.StorageOperationError{
		Operation:      "put",
		OutcomeUnknown: true,
		Cause:          errors.New("connection reset"),
	}}
	unknownService := newGuideServiceForTest(unknownTx, unknownStorage)
	_, _, err = unknownService.CreateGuideMaterial(context.Background(), CreateGuideMaterialCommand{Meta: userMeta("unknown"), BatchID: "batch_1", ClientCaptureID: "capture", Sequence: 1, CapturedAt: capturedAt, JPEG: jpegOne})
	if code, ok := domain.ErrorCodeOf(err); !ok || code != domain.CodeExternalServiceUnavailable {
		t.Fatalf("unknown storage outcome error=%v", err)
	}
	for _, record := range unknownTx.idempotency {
		wantLease := unknownService.now().Add(domain.IdempotencyLease)
		if record.LeaseExpiresAt == nil || !record.LeaseExpiresAt.Equal(wantLease) {
			t.Fatalf("unknown storage outcome lease = %v, want retained until %v", record.LeaseExpiresAt, wantLease)
		}
	}
}

func TestCreateGuideMaterialParallelConflictAndDistinctSequences(t *testing.T) {
	t.Run("distinct sequences are all registered", func(t *testing.T) {
		tx, now := guideFixture()
		tx.batch.ExpectedItemCount = 3
		tx.batch.CapturedTo = now.Add(10 * time.Second)
		storage := &fakeGuideStorage{objects: map[string][]byte{}}
		guideService := newGuideServiceForTest(tx, storage)
		type outcome struct {
			status int
			err    error
		}
		outcomes := make(chan outcome, 3)
		var wait sync.WaitGroup
		for sequence := 1; sequence <= 3; sequence++ {
			sequence := sequence
			wait.Add(1)
			go func() {
				defer wait.Done()
				_, status, err := guideService.CreateGuideMaterial(context.Background(), CreateGuideMaterialCommand{Meta: userMeta("parallel-" + strconv.Itoa(sequence)), BatchID: tx.batch.ID, ClientCaptureID: "capture_" + strconv.Itoa(sequence), Sequence: sequence, CapturedAt: now.Add(time.Duration(sequence-1) * 5 * time.Second), JPEG: jpegFixture(t, uint8(sequence))})
				outcomes <- outcome{status: status, err: err}
			}()
		}
		wait.Wait()
		close(outcomes)
		for result := range outcomes {
			if result.err != nil || result.status != 201 {
				t.Fatalf("parallel material failed: status=%d err=%v", result.status, result.err)
			}
		}
		if len(tx.materials) != 3 || tx.batch.ReceivedItemCount != 3 || tx.batch.Revision != 4 {
			t.Fatalf("unexpected parallel state: materials=%d batch=%+v", len(tx.materials), tx.batch)
		}
	})

	t.Run("same sequence has one winner", func(t *testing.T) {
		tx, now := guideFixture()
		storage := &fakeGuideStorage{objects: map[string][]byte{}}
		guideService := newGuideServiceForTest(tx, storage)
		type outcome struct {
			status int
			code   domain.ErrorCode
		}
		outcomes := make(chan outcome, 2)
		var wait sync.WaitGroup
		for index := 1; index <= 2; index++ {
			index := index
			wait.Add(1)
			go func() {
				defer wait.Done()
				_, status, err := guideService.CreateGuideMaterial(context.Background(), CreateGuideMaterialCommand{Meta: userMeta("conflict-" + strconv.Itoa(index)), BatchID: tx.batch.ID, ClientCaptureID: "capture_conflict_" + strconv.Itoa(index), Sequence: 1, CapturedAt: now, JPEG: jpegFixture(t, uint8(index))})
				code, _ := domain.ErrorCodeOf(err)
				outcomes <- outcome{status: status, code: code}
			}()
		}
		wait.Wait()
		close(outcomes)
		created, conflicts := 0, 0
		for result := range outcomes {
			switch {
			case result.status == 201 && result.code == "":
				created++
			case result.status == 409 && result.code == domain.CodeMaterialConflict:
				conflicts++
			default:
				t.Fatalf("unexpected conflict result: %+v", result)
			}
		}
		if created != 1 || conflicts != 1 || len(tx.materials) != 1 || len(tx.deletions) != 1 {
			t.Fatalf("expected one winner and one cleanup: created=%d conflicts=%d materials=%d deletions=%d", created, conflicts, len(tx.materials), len(tx.deletions))
		}
	})
}

func TestCompleteBatchAndRetryJobBoundaries(t *testing.T) {
	t.Parallel()
	tx, capturedAt := guideFixture()
	artifact := domain.Artifact{ID: "art_1", SHA256: strings.Repeat("a", 64)}
	tx.artifacts[artifact.ID] = artifact
	tx.materials = []domain.GuideMaterial{{ID: "material_1", BatchID: "batch_1", ClientCaptureID: "capture_1", ArtifactID: "art_1", Sequence: 1, CapturedAt: capturedAt}}
	tx.batch.ReceivedItemCount = 1
	service := newGuideServiceForTest(tx, nil)
	completed, err := service.CompleteGuideMaterialBatch(context.Background(), CompleteGuideMaterialBatchCommand{Meta: userMeta("complete"), BatchID: "batch_1", ExpectedBatchRevision: 1, ExpectedItemCount: 1})
	if err != nil {
		t.Fatal(err)
	}
	if completed.Batch.Status != domain.GuideMaterialBatchCompleted || completed.Job.Status != domain.GuideGenerationJobQueued || completed.SupportSession.Revision != 4 {
		t.Fatalf("completed=%+v", completed)
	}
	failedCode := domain.GuideGenerationAIUnavailable
	finished := capturedAt
	tx.job.Status = domain.GuideGenerationJobFailed
	tx.job.Attempt = 2
	tx.job.Revision = 3
	tx.job.ErrorCode = &failedCode
	tx.job.FinishedAt = &finished
	tx.session.Status = domain.SupportSessionGeneratingGuide
	retried, err := service.RetryGuideGenerationJob(context.Background(), RetryGuideGenerationJobCommand{Meta: familyMeta("retry"), JobID: tx.job.ID, ExpectedJobRevision: 3})
	if err != nil {
		t.Fatal(err)
	}
	if retried.Status != domain.GuideGenerationJobQueued || retried.Attempt != 2 || retried.Revision != 4 {
		t.Fatalf("retried=%+v", retried)
	}
	tx2, _ := guideFixture()
	tx2.job = domain.GuideGenerationJob{ID: "job_max", BatchID: "batch_1", Status: domain.GuideGenerationJobFailed, Attempt: 3, Revision: 3}
	jobID := tx2.job.ID
	tx2.session.GuideGenerationJobID = &jobID
	service2 := newGuideServiceForTest(tx2, nil)
	_, err = service2.RetryGuideGenerationJob(context.Background(), RetryGuideGenerationJobCommand{Meta: familyMeta("retry-max"), JobID: jobID, ExpectedJobRevision: 3})
	if code, ok := domain.ErrorCodeOf(err); !ok || code != domain.CodeInvalidState {
		t.Fatalf("max retry error=%v", err)
	}
}

func TestUpdateGuideRunRevisionStateAndBounds(t *testing.T) {
	t.Parallel()
	tx, _ := guideFixture()
	tx.run = domain.GuideRun{ID: "run_1", GuideID: "guide_1", GuideVersionNumber: 1, UserID: "user_demo", Status: domain.GuideRunInProgress, CurrentStepNumber: 1, Revision: 1}
	tx.stepCount = 2
	service := newGuideServiceForTest(tx, nil)
	updated, err := service.UpdateGuideRun(context.Background(), UpdateGuideRunCommand{Actor: userMeta("x").Actor, RunID: "run_1", ExpectedRevision: 1, Action: domain.GuideRunNext})
	if err != nil {
		t.Fatal(err)
	}
	if updated.CurrentStepNumber != 2 || updated.Revision != 2 {
		t.Fatalf("updated=%+v", updated)
	}
	_, err = service.UpdateGuideRun(context.Background(), UpdateGuideRunCommand{Actor: userMeta("x").Actor, RunID: "run_1", ExpectedRevision: 1, Action: domain.GuideRunPrevious})
	if code, ok := domain.ErrorCodeOf(err); !ok || code != domain.CodeRevisionConflict {
		t.Fatalf("revision error=%v", err)
	}
	tx.run.Revision = 2
	tx.run.CurrentStepNumber = 1
	_, err = service.UpdateGuideRun(context.Background(), UpdateGuideRunCommand{Actor: userMeta("x").Actor, RunID: "run_1", ExpectedRevision: 2, Action: domain.GuideRunPrevious})
	if code, ok := domain.ErrorCodeOf(err); !ok || code != domain.CodeValidationError {
		t.Fatalf("bounds error=%v", err)
	}
}

func TestUpdateAndSaveGuideDraftWithCleanup(t *testing.T) {
	t.Parallel()
	tx, now := guideFixture()
	draftID := domain.ID("draft_1")
	jobID := domain.ID("job_1")
	batchID := domain.ID("batch_1")
	tx.session.Status = domain.SupportSessionReviewingGuide
	tx.session.Revision = 6
	tx.session.GuideDraftID = &draftID
	tx.session.GuideGenerationJobID = &jobID
	tx.session.GuideMaterialBatchID = &batchID
	tx.batch.Status = domain.GuideMaterialBatchCompleted
	tx.job = domain.GuideGenerationJob{ID: jobID, BatchID: batchID, Status: domain.GuideGenerationJobSucceeded, Attempt: 1, Revision: 3, GuideDraftID: &draftID}
	tx.draft = domain.GuideDraft{ID: draftID, SupportSessionID: tx.session.ID, Title: "古い", Steps: []domain.GuideStep{{Position: 1, ArtifactID: "art_1", Instruction: "古い説明"}}, Status: domain.GuideDraftEditing, Revision: 1, CreatedAt: now, UpdatedAt: now}
	tx.allowed = map[domain.ID]struct{}{"art_1": {}, "art_2": {}}
	tx.artifacts["art_1"] = domain.Artifact{ID: "art_1", Purpose: domain.ArtifactPurposeGuideMaterial}
	tx.artifacts["art_2"] = domain.Artifact{ID: "art_2", Purpose: domain.ArtifactPurposeGuideMaterial}
	tx.unused = []repository.ArtifactReference{{ID: "art_2", StorageKey: "user_demo/art_2.jpg"}}
	service := newGuideServiceForTest(tx, nil)
	updated, err := service.UpdateGuideDraft(context.Background(), UpdateGuideDraftCommand{Actor: familyMeta("x").Actor, DraftID: draftID, ExpectedRevision: 1, Title: "新しいガイド", Steps: []domain.GuideStep{{Position: 1, ArtifactID: "art_1", Instruction: "設定を押す"}}})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Revision != 2 || updated.Title != "新しいガイド" {
		t.Fatalf("updated=%+v", updated)
	}
	_, err = service.UpdateGuideDraft(context.Background(), UpdateGuideDraftCommand{Actor: familyMeta("x").Actor, DraftID: draftID, ExpectedRevision: 1, Title: "競合", Steps: updated.Steps})
	if code, ok := domain.ErrorCodeOf(err); !ok || code != domain.CodeRevisionConflict {
		t.Fatalf("revision error=%v", err)
	}
	saved, err := service.SaveGuideDraft(context.Background(), SaveGuideDraftCommand{Meta: familyMeta("save"), DraftID: draftID, ExpectedRevision: 2})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Guide.Guide.Title != "新しいガイド" || saved.Guide.CurrentVersion.VersionNumber != 1 || saved.SupportSession.Status != domain.SupportSessionEnded || saved.SupportSession.Revision != 7 {
		t.Fatalf("saved=%+v", saved)
	}
	if tx.artifacts["art_1"].Purpose != domain.ArtifactPurposeGuideStep || len(tx.deletions) != 1 || !tx.deletedJob || !tx.deletedMaterials || !tx.deletedBatch {
		t.Fatalf("cleanup: artifacts=%+v deletions=%+v flags=%t/%t/%t", tx.artifacts, tx.deletions, tx.deletedJob, tx.deletedMaterials, tx.deletedBatch)
	}
	tx.session.Revision = 99
	replayed, err := service.SaveGuideDraft(context.Background(), SaveGuideDraftCommand{Meta: familyMeta("save"), DraftID: draftID, ExpectedRevision: 2})
	if err != nil {
		t.Fatal(err)
	}
	if replayed.SupportSession.Revision != 7 {
		t.Fatalf("replayed=%+v", replayed)
	}
}

func TestGuideRunLifecycleAndSupportRequestContext(t *testing.T) {
	t.Parallel()
	tx, now := guideFixture()
	tx.guide = domain.GuideDetail{Guide: domain.Guide{ID: "guide_1", UserID: "user_demo", Title: "設定ガイド", CurrentVersionNumber: 1, Revision: 1, CreatedAt: now, UpdatedAt: now}, RepresentativeArtifactID: "art_step", CurrentVersion: domain.GuideVersion{GuideID: "guide_1", VersionNumber: 1, Title: "設定ガイド", CreatedBy: "family_demo", CreatedAt: now, Steps: []domain.GuideStep{{Position: 1, ArtifactID: "art_step", Instruction: "設定を押す"}, {Position: 2, ArtifactID: "art_step_2", Instruction: "保存を押す"}}}}
	tx.stepCount = 2
	service := newGuideServiceForTest(tx, nil)
	run, err := service.CreateGuideRun(context.Background(), CreateGuideRunCommand{Meta: userMeta("run-create"), GuideID: "guide_1"})
	if err != nil {
		t.Fatal(err)
	}
	if run.Status != domain.GuideRunInProgress || run.CurrentStepNumber != 1 || run.GuideVersionNumber != 1 {
		t.Fatalf("run=%+v", run)
	}
	run, err = service.UpdateGuideRun(context.Background(), UpdateGuideRunCommand{Actor: userMeta("x").Actor, RunID: run.ID, ExpectedRevision: 1, Action: domain.GuideRunNext})
	if err != nil {
		t.Fatal(err)
	}
	completed, err := service.CompleteGuideRun(context.Background(), CompleteGuideRunCommand{Meta: userMeta("run-complete"), RunID: run.ID, ExpectedRevision: 2})
	if err != nil {
		t.Fatal(err)
	}
	if completed.Status != domain.GuideRunCompleted || completed.Revision != 3 {
		t.Fatalf("completed=%+v", completed)
	}
	_, err = service.CompleteGuideRun(context.Background(), CompleteGuideRunCommand{Meta: userMeta("run-complete-other"), RunID: run.ID, ExpectedRevision: 3})
	if code, ok := domain.ErrorCodeOf(err); !ok || code != domain.CodeInvalidState {
		t.Fatalf("second completion error=%v", err)
	}

	tx.run = domain.GuideRun{ID: "run_support", GuideID: "guide_1", GuideVersionNumber: 1, UserID: "user_demo", Status: domain.GuideRunInProgress, CurrentStepNumber: 1, Revision: 1}
	tx.artifacts["screen_1"] = domain.Artifact{ID: "screen_1", OwnerUserID: "user_demo", Purpose: domain.ArtifactPurposeRequestScreenshot}
	created, err := service.CreateSupportRequestFromGuideRun(context.Background(), CreateSupportRequestFromGuideRunCommand{Meta: userMeta("support"), RunID: "run_support", ExpectedRevision: 1, InitialScreenshotArtifactID: "screen_1", Comment: "分からない"})
	if err != nil {
		t.Fatal(err)
	}
	if created.GuideRun.Status != domain.GuideRunPausedForSupport || created.SupportRequest.GuideContext == nil || created.SupportRequest.GuideContext.GuideTitle != "設定ガイド" || created.SupportRequest.GuideContext.StepInstruction != "設定を押す" {
		t.Fatalf("support result=%+v", created)
	}
	tx2, _ := guideFixture()
	tx2.run = domain.GuideRun{ID: "run_2", GuideID: "guide_1", GuideVersionNumber: 1, UserID: "user_demo", Status: domain.GuideRunInProgress, CurrentStepNumber: 1, Revision: 1}
	tx2.guide = tx.guide
	tx2.artifacts["screen_2"] = domain.Artifact{ID: "screen_2", OwnerUserID: "user_demo", Purpose: domain.ArtifactPurposeRequestScreenshot}
	tx2.activeSupport = true
	service2 := newGuideServiceForTest(tx2, nil)
	_, err = service2.CreateSupportRequestFromGuideRun(context.Background(), CreateSupportRequestFromGuideRunCommand{Meta: userMeta("duplicate"), RunID: "run_2", ExpectedRevision: 1, InitialScreenshotArtifactID: "screen_2"})
	if code, ok := domain.ErrorCodeOf(err); !ok || code != domain.CodeDuplicateActiveRequest {
		t.Fatalf("duplicate active error=%v", err)
	}
	if tx2.run.Status != domain.GuideRunInProgress {
		t.Fatalf("run changed on duplicate: %+v", tx2.run)
	}
}

func TestDraftRejectsUnknownArtifactAndFamilyOnlyReads(t *testing.T) {
	t.Parallel()
	tx, now := guideFixture()
	draftID := domain.ID("draft_1")
	tx.session.Status = domain.SupportSessionReviewingGuide
	tx.session.GuideDraftID = &draftID
	tx.draft = domain.GuideDraft{ID: draftID, SupportSessionID: tx.session.ID, Title: "ガイド", Steps: []domain.GuideStep{{Position: 1, ArtifactID: "art_1", Instruction: "押す"}}, Status: domain.GuideDraftEditing, Revision: 1, CreatedAt: now, UpdatedAt: now}
	tx.allowed = map[domain.ID]struct{}{"art_1": {}}
	service := newGuideServiceForTest(tx, nil)
	_, err := service.UpdateGuideDraft(context.Background(), UpdateGuideDraftCommand{Actor: familyMeta("x").Actor, DraftID: draftID, ExpectedRevision: 1, Title: "ガイド", Steps: []domain.GuideStep{{Position: 1, ArtifactID: "other", Instruction: "押す"}}})
	if code, ok := domain.ErrorCodeOf(err); !ok || code != domain.CodeValidationError {
		t.Fatalf("unknown artifact error=%v", err)
	}
	_, err = service.UpdateGuideDraft(context.Background(), UpdateGuideDraftCommand{Actor: userMeta("x").Actor, DraftID: draftID, ExpectedRevision: 1, Title: "ガイド", Steps: tx.draft.Steps})
	if code, ok := domain.ErrorCodeOf(err); !ok || code != domain.CodeForbidden {
		t.Fatalf("user update error=%v", err)
	}
	if _, err = service.GetGuideDraft(context.Background(), userMeta("x").Actor, draftID); err != nil {
		t.Fatalf("user read failed: %v", err)
	}
}
