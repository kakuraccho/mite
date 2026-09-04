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
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/repository"
)

func TestCreateArtifactValidatesPersistsAndReplays(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	store := newFakeArtifactSupportStore()
	storage := newFakeArtifactSupportStorage()
	service := newTestArtifactSupportService(store, storage, nil, func() time.Time { return now })
	data := testJPEG(t, 3, 2)
	input := CreateArtifactInput{
		Purpose:    domain.ArtifactPurposeRequestScreenshot,
		CapturedAt: now.Add(-time.Minute),
		File:       bytes.NewReader(data),
	}

	first, err := service.CreateArtifact(context.Background(), testUserActor(), "artifact-key", input)
	if err != nil {
		t.Fatalf("CreateArtifact() error = %v", err)
	}
	if first.ResponseStatus != 201 || first.Replayed {
		t.Fatalf("first result = status %d replayed %v", first.ResponseStatus, first.Replayed)
	}
	if first.Artifact.ID != "art_1" || first.Artifact.Width != 3 || first.Artifact.Height != 2 {
		t.Fatalf("artifact = %+v", first.Artifact)
	}
	if first.Artifact.StorageKey != "user_demo/art_1.jpg" {
		t.Fatalf("storage key = %q", first.Artifact.StorageKey)
	}
	if strings.Contains(string(first.ResponseBody), "storageKey") ||
		!strings.Contains(string(first.ResponseBody), `"contentUrl":"/v1/artifacts/art_1/content"`) {
		t.Fatalf("response body = %s", first.ResponseBody)
	}
	if storage.putCalls != 1 || storage.putKeys[0] != first.Artifact.StorageKey {
		t.Fatalf("put calls = %d keys = %v", storage.putCalls, storage.putKeys)
	}

	input.File = bytes.NewReader(data)
	second, err := service.CreateArtifact(context.Background(), testUserActor(), "artifact-key", input)
	if err != nil {
		t.Fatalf("replay CreateArtifact() error = %v", err)
	}
	if !second.Replayed || second.Artifact.ID != first.Artifact.ID {
		t.Fatalf("replay result = %+v", second)
	}
	if !bytes.Equal(second.ResponseBody, first.ResponseBody) {
		t.Fatal("replay response body differs from first response")
	}
	if storage.putCalls != 1 || len(store.artifacts) != 1 {
		t.Fatalf("replay mutated storage/db: puts=%d artifacts=%d", storage.putCalls, len(store.artifacts))
	}
}

func TestCreateArtifactIdempotencyConflicts(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	data := testJPEG(t, 1, 1)

	t.Run("same key with different normalized body", func(t *testing.T) {
		store := newFakeArtifactSupportStore()
		storage := newFakeArtifactSupportStorage()
		service := newTestArtifactSupportService(store, storage, nil, func() time.Time { return now })
		input := CreateArtifactInput{Purpose: domain.ArtifactPurposeRequestScreenshot, CapturedAt: now, File: bytes.NewReader(data)}
		if _, err := service.CreateArtifact(context.Background(), testUserActor(), "same", input); err != nil {
			t.Fatal(err)
		}
		input.CapturedAt = now.Add(time.Second)
		input.File = bytes.NewReader(data)
		_, err := service.CreateArtifact(context.Background(), testUserActor(), "same", input)
		assertDomainCode(t, err, domain.CodeIdempotencyKeyReused)
		if storage.putCalls != 1 {
			t.Fatalf("put calls = %d", storage.putCalls)
		}
	})

	t.Run("unexpired lease", func(t *testing.T) {
		store := newFakeArtifactSupportStore()
		storage := newFakeArtifactSupportStorage()
		service := newTestArtifactSupportService(store, storage, nil, func() time.Time { return now })
		fileHash := shaForTest(t, data)
		requestHash, err := domain.HashCanonicalMultipart([]domain.MultipartHashPart{
			{Name: "purpose", Value: "REQUEST_SCREENSHOT"},
			{Name: "capturedAt", Value: now.Format(time.RFC3339Nano)},
		}, fileHash)
		if err != nil {
			t.Fatal(err)
		}
		key, _ := domain.NewIdempotencyKey("busy")
		resourceID := domain.ID("art_existing")
		record, err := NewInProgressIdempotencyRecord(domain.IdempotencyScope{
			ActorID: "user_demo", Method: "POST", Path: createArtifactPath, Key: key,
		}, requestHash, &resourceID, now)
		if err != nil {
			t.Fatal(err)
		}
		store.idempotency[scopeMapKey(record.Scope)] = record
		_, err = service.CreateArtifact(context.Background(), testUserActor(), "busy", CreateArtifactInput{
			Purpose: domain.ArtifactPurposeRequestScreenshot, CapturedAt: now, File: bytes.NewReader(data),
		})
		assertDomainCode(t, err, domain.CodeIdempotencyRequestInProgress)
		if storage.putCalls != 0 {
			t.Fatalf("put calls = %d", storage.putCalls)
		}
	})
}

func TestCreateArtifactStorageFailureAndDatabaseRecovery(t *testing.T) {
	t.Parallel()
	baseTime := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	data := testJPEG(t, 2, 2)

	t.Run("known storage failure releases lease", func(t *testing.T) {
		store := newFakeArtifactSupportStore()
		storage := newFakeArtifactSupportStorage()
		storage.putErr = &repository.StorageOperationError{Operation: "put", StatusCode: 500}
		service := newTestArtifactSupportService(store, storage, nil, func() time.Time { return baseTime })
		_, err := service.CreateArtifact(context.Background(), testUserActor(), "known", CreateArtifactInput{
			Purpose: domain.ArtifactPurposeRequestScreenshot, CapturedAt: baseTime, File: bytes.NewReader(data),
		})
		assertDomainCode(t, err, domain.CodeExternalServiceUnavailable)
		record := onlyIdempotencyRecord(t, store)
		if record.LeaseExpiresAt == nil || record.LeaseExpiresAt.After(baseTime) {
			t.Fatalf("lease was not released: %v", record.LeaseExpiresAt)
		}
		if len(store.artifacts) != 0 {
			t.Fatalf("artifacts = %d", len(store.artifacts))
		}
	})

	t.Run("unknown storage result keeps lease", func(t *testing.T) {
		store := newFakeArtifactSupportStore()
		storage := newFakeArtifactSupportStorage()
		storage.putErr = &repository.StorageOperationError{Operation: "put", OutcomeUnknown: true, Cause: errors.New("timeout")}
		service := newTestArtifactSupportService(store, storage, nil, func() time.Time { return baseTime })
		_, err := service.CreateArtifact(context.Background(), testUserActor(), "unknown", CreateArtifactInput{
			Purpose: domain.ArtifactPurposeRequestScreenshot, CapturedAt: baseTime, File: bytes.NewReader(data),
		})
		assertDomainCode(t, err, domain.CodeExternalServiceUnavailable)
		record := onlyIdempotencyRecord(t, store)
		if record.LeaseExpiresAt == nil || !record.LeaseExpiresAt.Equal(baseTime.Add(domain.IdempotencyLease)) {
			t.Fatalf("lease changed: %v", record.LeaseExpiresAt)
		}
	})

	t.Run("storage success and database failure resumes same object", func(t *testing.T) {
		currentTime := baseTime
		store := newFakeArtifactSupportStore()
		store.createArtifactErr = errors.New("database unavailable")
		storage := newFakeArtifactSupportStorage()
		service := newTestArtifactSupportService(store, storage, nil, func() time.Time { return currentTime })
		input := CreateArtifactInput{Purpose: domain.ArtifactPurposeRequestScreenshot, CapturedAt: baseTime, File: bytes.NewReader(data)}
		_, err := service.CreateArtifact(context.Background(), testUserActor(), "recover", input)
		assertDomainCode(t, err, domain.CodeInternalError)
		if storage.putCalls != 1 {
			t.Fatalf("put calls = %d", storage.putCalls)
		}
		firstKey := storage.putKeys[0]
		firstResource := *onlyIdempotencyRecord(t, store).ResourceID

		store.createArtifactErr = nil
		currentTime = baseTime.Add(domain.IdempotencyLease)
		input.File = bytes.NewReader(data)
		result, err := service.CreateArtifact(context.Background(), testUserActor(), "recover", input)
		if err != nil {
			t.Fatalf("resumed CreateArtifact() error = %v", err)
		}
		if result.Artifact.ID != firstResource || storage.putKeys[1] != firstKey {
			t.Fatalf("resume changed target: id=%s keys=%v", result.Artifact.ID, storage.putKeys)
		}
		if len(store.artifacts) != 1 || onlyIdempotencyRecord(t, store).Status != domain.IdempotencyCompleted {
			t.Fatal("resumed upload was not finalized")
		}
	})
}

func TestCreateArtifactRejectsInvalidFiles(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	tests := []struct {
		name string
		data []byte
		code domain.ErrorCode
	}{
		{name: "empty", data: nil, code: domain.CodeValidationError},
		{name: "not jpeg", data: []byte("not a jpeg"), code: domain.CodeValidationError},
		{name: "too large", data: make([]byte, domain.MaxArtifactBytes+1), code: domain.CodeFileTooLarge},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := newFakeArtifactSupportStore()
			storage := newFakeArtifactSupportStorage()
			service := newTestArtifactSupportService(store, storage, nil, func() time.Time { return now })
			_, err := service.CreateArtifact(context.Background(), testUserActor(), "file", CreateArtifactInput{
				Purpose: domain.ArtifactPurposeRequestScreenshot, CapturedAt: now, File: bytes.NewReader(test.data),
			})
			assertDomainCode(t, err, test.code)
			if len(store.idempotency) != 0 || storage.putCalls != 0 {
				t.Fatal("invalid file reached idempotency or storage")
			}
		})
	}
}

func TestCreateSupportRequestPersistsReplaysAndPublishesAfterCommit(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	store := newFakeArtifactSupportStore()
	store.artifacts["art_input"] = validTestArtifact("art_input", "user_demo", now)
	publisher := &fakeArtifactSupportEventPublisher{store: store}
	service := newTestArtifactSupportService(store, newFakeArtifactSupportStorage(), publisher, func() time.Time { return now })
	input := CreateSupportRequestInput{InitialScreenshotArtifactID: "art_input", Comment: "元の画面に戻れない", RequestID: "req_http_1"}

	first, err := service.CreateSupportRequest(context.Background(), testUserActor(), "request-key", input)
	if err != nil {
		t.Fatalf("CreateSupportRequest() error = %v", err)
	}
	if first.ResponseStatus != 201 || first.SupportRequest == nil || first.SupportRequest.Revision != 1 {
		t.Fatalf("first result = %+v", first)
	}
	if first.SupportRequest.GuideContext != nil || first.SupportRequest.SupportSessionID != nil {
		t.Fatalf("regular request has related data: %+v", first.SupportRequest)
	}
	if len(publisher.events) != 1 || publisher.publishedInsideTransaction {
		t.Fatalf("events=%d publishedInsideTransaction=%v", len(publisher.events), publisher.publishedInsideTransaction)
	}
	if publisher.events[0].Audience != store.pair || publisher.events[0].Revision != 1 {
		t.Fatalf("event = %+v", publisher.events[0])
	}

	second, err := service.CreateSupportRequest(context.Background(), testUserActor(), "request-key", input)
	if err != nil {
		t.Fatalf("replay error = %v", err)
	}
	if !second.Replayed || second.SupportRequest == nil || second.SupportRequest.ID != first.SupportRequest.ID {
		t.Fatalf("replay = %+v", second)
	}
	if !bytes.Equal(first.ResponseBody, second.ResponseBody) || len(store.requests) != 1 || len(publisher.events) != 1 {
		t.Fatal("replay changed response, DB, or event count")
	}
}

func TestCreateSupportRequestPersistsBusinessFailures(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	tests := []struct {
		name       string
		configure  func(*fakeArtifactSupportStore)
		wantStatus int
		wantCode   string
	}{
		{name: "duplicate request", configure: func(store *fakeArtifactSupportStore) {
			store.activeRequest = true
		}, wantStatus: 409, wantCode: "DUPLICATE_ACTIVE_REQUEST"},
		{name: "open session", configure: func(store *fakeArtifactSupportStore) {
			store.openSession = true
		}, wantStatus: 409, wantCode: "DUPLICATE_ACTIVE_REQUEST"},
		{name: "missing artifact", configure: func(*fakeArtifactSupportStore) {}, wantStatus: 404, wantCode: "NOT_FOUND"},
		{name: "wrong artifact purpose", configure: func(store *fakeArtifactSupportStore) {
			artifact := validTestArtifact("art_missing", "user_demo", now)
			artifact.Purpose = domain.ArtifactPurposeGuideMaterial
			store.artifacts[artifact.ID] = artifact
		}, wantStatus: 400, wantCode: "VALIDATION_ERROR"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			store := newFakeArtifactSupportStore()
			test.configure(store)
			service := newTestArtifactSupportService(store, newFakeArtifactSupportStorage(), nil, func() time.Time { return now })
			input := CreateSupportRequestInput{InitialScreenshotArtifactID: "art_missing", RequestID: "req_business"}
			first, err := service.CreateSupportRequest(context.Background(), testUserActor(), "business", input)
			if err != nil {
				t.Fatalf("first error = %v", err)
			}
			if first.ResponseStatus != test.wantStatus || !strings.Contains(string(first.ResponseBody), test.wantCode) {
				t.Fatalf("first response = %d %s", first.ResponseStatus, first.ResponseBody)
			}
			if onlyIdempotencyRecord(t, store).Status != domain.IdempotencyCompleted {
				t.Fatal("business failure was not persisted")
			}
			second, err := service.CreateSupportRequest(context.Background(), testUserActor(), "business", input)
			if err != nil {
				t.Fatalf("replay error = %v", err)
			}
			if !second.Replayed || !bytes.Equal(first.ResponseBody, second.ResponseBody) {
				t.Fatalf("business replay = %+v", second)
			}
		})
	}
}

func TestCreateSupportRequestAuthorizationAndConflicts(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)

	t.Run("family cannot create", func(t *testing.T) {
		store := newFakeArtifactSupportStore()
		service := newTestArtifactSupportService(store, newFakeArtifactSupportStorage(), nil, func() time.Time { return now })
		_, err := service.CreateSupportRequest(context.Background(), domain.Actor{ID: "family_demo", Role: domain.RoleFamily}, "key", CreateSupportRequestInput{
			InitialScreenshotArtifactID: "art_input", RequestID: "req",
		})
		assertDomainCode(t, err, domain.CodeForbidden)
		if len(store.idempotency) != 0 {
			t.Fatal("authorization failure created idempotency record")
		}
	})

	t.Run("comment over 500 Unicode code points", func(t *testing.T) {
		store := newFakeArtifactSupportStore()
		service := newTestArtifactSupportService(store, newFakeArtifactSupportStorage(), nil, func() time.Time { return now })
		_, err := service.CreateSupportRequest(context.Background(), testUserActor(), "key", CreateSupportRequestInput{
			InitialScreenshotArtifactID: "art_input", Comment: strings.Repeat("あ", 501), RequestID: "req",
		})
		assertDomainCode(t, err, domain.CodeValidationError)
		if len(store.idempotency) != 0 {
			t.Fatal("invalid comment created idempotency record")
		}
	})

	t.Run("other owner cannot be inferred through response", func(t *testing.T) {
		store := newFakeArtifactSupportStore()
		store.artifacts["art_other"] = validTestArtifact("art_other", "another_user", now)
		service := newTestArtifactSupportService(store, newFakeArtifactSupportStorage(), nil, func() time.Time { return now })
		_, err := service.CreateSupportRequest(context.Background(), testUserActor(), "key", CreateSupportRequestInput{
			InitialScreenshotArtifactID: "art_other", RequestID: "req",
		})
		assertDomainCode(t, err, domain.CodeForbidden)
		if len(store.idempotency) != 0 {
			t.Fatal("target authorization failure was persisted")
		}
	})

	t.Run("same key different comment", func(t *testing.T) {
		store := newFakeArtifactSupportStore()
		store.artifacts["art_input"] = validTestArtifact("art_input", "user_demo", now)
		service := newTestArtifactSupportService(store, newFakeArtifactSupportStorage(), nil, func() time.Time { return now })
		input := CreateSupportRequestInput{InitialScreenshotArtifactID: "art_input", Comment: "a", RequestID: "req"}
		if _, err := service.CreateSupportRequest(context.Background(), testUserActor(), "key", input); err != nil {
			t.Fatal(err)
		}
		input.Comment = "b"
		_, err := service.CreateSupportRequest(context.Background(), testUserActor(), "key", input)
		assertDomainCode(t, err, domain.CodeIdempotencyKeyReused)
	})

	t.Run("deletion-reserved artifact is not usable", func(t *testing.T) {
		store := newFakeArtifactSupportStore()
		artifact := validTestArtifact("art_deleting", "user_demo", now)
		store.artifacts[artifact.ID] = artifact
		store.tasks["delete_1"] = domain.ArtifactDeletionTask{
			ID: "delete_1", ArtifactID: &artifact.ID, StorageKey: artifact.StorageKey,
			Status: domain.ArtifactDeletionPending, NextAttemptAt: now, CreatedAt: now,
		}
		service := newTestArtifactSupportService(store, newFakeArtifactSupportStorage(), nil, func() time.Time { return now })
		result, err := service.CreateSupportRequest(context.Background(), testUserActor(), "deleting", CreateSupportRequestInput{
			InitialScreenshotArtifactID: artifact.ID, RequestID: "req_deleting",
		})
		if err != nil {
			t.Fatal(err)
		}
		if result.ResponseStatus != 404 || !strings.Contains(string(result.ResponseBody), "NOT_FOUND") {
			t.Fatalf("response = %d %s", result.ResponseStatus, result.ResponseBody)
		}
	})
}

func TestConcurrentSupportRequestsCreateOnlyOneActiveRequest(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	store := newFakeArtifactSupportStore()
	store.artifacts["art_input"] = validTestArtifact("art_input", "user_demo", now)
	service := newTestArtifactSupportService(store, newFakeArtifactSupportStorage(), nil, func() time.Time { return now })

	start := make(chan struct{})
	results := make(chan IdempotentSupportRequestResult, 2)
	errorsChannel := make(chan error, 2)
	for _, key := range []string{"concurrent-a", "concurrent-b"} {
		key := key
		go func() {
			<-start
			result, err := service.CreateSupportRequest(context.Background(), testUserActor(), key, CreateSupportRequestInput{
				InitialScreenshotArtifactID: "art_input", RequestID: "req_" + key,
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
			t.Fatalf("concurrent CreateSupportRequest() error = %v", err)
		}
		statuses[result.ResponseStatus]++
	}
	if statuses[201] != 1 || statuses[409] != 1 || len(store.requests) != 1 {
		t.Fatalf("statuses=%v requests=%d", statuses, len(store.requests))
	}
}

func TestArtifactAndSupportRequestReadsAuthorizeAndLimit(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	store := newFakeArtifactSupportStore()
	storage := newFakeArtifactSupportStorage()
	artifact := validTestArtifact("art_1", "user_demo", now)
	store.artifacts[artifact.ID] = artifact
	storage.objects[artifact.StorageKey] = []byte("jpeg bytes")
	service := newTestArtifactSupportService(store, storage, nil, func() time.Time { return now })

	content, err := service.GetArtifactContent(context.Background(), domain.Actor{ID: "family_demo", Role: domain.RoleFamily}, artifact.ID)
	if err != nil {
		t.Fatalf("GetArtifactContent() error = %v", err)
	}
	defer content.Body.Close()
	data, _ := io.ReadAll(content.Body)
	if string(data) != "jpeg bytes" || content.Size != artifact.ByteSize {
		t.Fatalf("content = %q size=%d", data, content.Size)
	}

	store.pair = domain.UserPair{UserID: "other_user", FamilyID: "family_demo"}
	_, err = service.GetArtifactContent(context.Background(), domain.Actor{ID: "family_demo", Role: domain.RoleFamily}, artifact.ID)
	assertDomainCode(t, err, domain.CodeForbidden)
	store.pair = testPair()

	for index := 0; index < 25; index++ {
		id := domain.ID("request_" + string(rune('a'+index)))
		store.requests[id] = validTestSupportRequest(id, store.pair, artifact.ID, now.Add(time.Duration(index)*time.Second))
	}
	items, err := service.ListSupportRequests(context.Background(), testUserActor(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 20 {
		t.Fatalf("list length = %d", len(items))
	}
	invalidStatus := domain.SupportRequestStatus("UNKNOWN")
	_, err = service.ListSupportRequests(context.Background(), testUserActor(), &invalidStatus)
	assertDomainCode(t, err, domain.CodeValidationError)

	request := items[0]
	got, err := service.GetSupportRequest(context.Background(), domain.Actor{ID: "family_demo", Role: domain.RoleFamily}, request.ID)
	if err != nil || got.ID != request.ID {
		t.Fatalf("GetSupportRequest() = %+v, %v", got, err)
	}
	other := request
	other.ID = "request_other"
	other.UserID = "another_user"
	other.FamilyID = "another_family"
	store.requests[other.ID] = other
	_, err = service.GetSupportRequest(context.Background(), testUserActor(), other.ID)
	assertDomainCode(t, err, domain.CodeForbidden)
}

func TestArtifactCleanupSchedulesRecoversDeletesAndRetries(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	store := newFakeArtifactSupportStore()
	stale := validTestArtifact("art_stale", "user_demo", now.Add(-25*time.Hour))
	store.artifacts[stale.ID] = stale
	store.staleArtifacts = []domain.Artifact{stale}
	key, _ := domain.NewIdempotencyKey("stale-upload")
	resource := domain.ID("art_orphan")
	lease := now.Add(-25 * time.Hour)
	store.expiredIdempotency = []repository.ExpiredIdempotencyRecord{
		{Scope: domain.IdempotencyScope{ActorID: "user_demo", Method: "POST", Path: createArtifactPath, Key: key}, Status: domain.IdempotencyInProgress, ResourceID: &resource},
	}
	store.idempotency[scopeMapKey(store.expiredIdempotency[0].Scope)] = domain.IdempotencyRecord{
		Scope: store.expiredIdempotency[0].Scope, RequestHash: domain.RequestHash(strings.Repeat("a", 64)),
		Status: domain.IdempotencyInProgress, ResourceID: &resource, LeaseExpiresAt: &lease, CreatedAt: lease,
	}
	storage := newFakeArtifactSupportStorage()
	service := newTestArtifactSupportService(store, storage, nil, func() time.Time { return now })

	cleanup, err := service.ScheduleArtifactCleanup(context.Background(), 10)
	if err != nil {
		t.Fatalf("ScheduleArtifactCleanup() error = %v", err)
	}
	if cleanup.ScheduledArtifacts != 2 || cleanup.DeletedIdempotencies != 1 || len(store.tasks) != 2 {
		t.Fatalf("cleanup = %+v tasks=%d", cleanup, len(store.tasks))
	}
	if len(store.idempotency) != 0 {
		t.Fatal("stale idempotency record was not removed")
	}

	processed, err := service.ProcessNextArtifactDeletion(context.Background())
	if err != nil || !processed {
		t.Fatalf("ProcessNextArtifactDeletion() = %v, %v", processed, err)
	}
	if storage.deleteCalls != 1 {
		t.Fatalf("delete calls = %d", storage.deleteCalls)
	}

	for id, task := range store.tasks {
		task.Status = domain.ArtifactDeletionRunning
		store.tasks[id] = task
	}
	recovered, err := service.RecoverArtifactDeletionTasks(context.Background())
	if err != nil || recovered == 0 {
		t.Fatalf("RecoverArtifactDeletionTasks() = %d, %v", recovered, err)
	}

	storage.deleteErr = errors.New("storage unavailable")
	processed, err = service.ProcessNextArtifactDeletion(context.Background())
	if !processed {
		t.Fatal("expected a deletion attempt")
	}
	assertDomainCode(t, err, domain.CodeExternalServiceUnavailable)
	if len(store.tasks) != 1 {
		t.Fatalf("retry task count = %d", len(store.tasks))
	}
	for _, task := range store.tasks {
		if task.Status != domain.ArtifactDeletionPending || task.Attempt != 1 || !task.NextAttemptAt.After(now) {
			t.Fatalf("retried task = %+v", task)
		}
	}
}

func TestArtifactCleanupRechecksReferencesAfterLock(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	store := newFakeArtifactSupportStore()
	artifact := validTestArtifact("art_referenced", "user_demo", now.Add(-25*time.Hour))
	store.artifacts[artifact.ID] = artifact
	store.staleArtifacts = []domain.Artifact{artifact}
	request := validTestSupportRequest("request_reference", store.pair, artifact.ID, now)
	store.requests[request.ID] = request
	service := newTestArtifactSupportService(store, newFakeArtifactSupportStorage(), nil, func() time.Time { return now })
	result, err := service.ScheduleArtifactCleanup(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if result.ScheduledArtifacts != 0 || len(store.tasks) != 0 {
		t.Fatalf("cleanup scheduled referenced artifact: %+v", result)
	}
}

type fakeArtifactSupportStore struct {
	mu                 sync.Mutex
	pair               domain.UserPair
	artifacts          map[domain.ID]domain.Artifact
	requests           map[domain.ID]domain.SupportRequest
	idempotency        map[string]domain.IdempotencyRecord
	tasks              map[domain.ID]domain.ArtifactDeletionTask
	activeRequest      bool
	openSession        bool
	createArtifactErr  error
	createRequestErr   error
	staleArtifacts     []domain.Artifact
	expiredIdempotency []repository.ExpiredIdempotencyRecord
	inTransaction      bool
}

func newFakeArtifactSupportStore() *fakeArtifactSupportStore {
	return &fakeArtifactSupportStore{
		pair: testPair(), artifacts: map[domain.ID]domain.Artifact{}, requests: map[domain.ID]domain.SupportRequest{},
		idempotency: map[string]domain.IdempotencyRecord{}, tasks: map[domain.ID]domain.ArtifactDeletionTask{},
	}
}

func (s *fakeArtifactSupportStore) WithinTransaction(_ context.Context, work func(repository.ArtifactSupportTx) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	idempotencySnapshot := cloneIdempotencyRecords(s.idempotency)
	artifactSnapshot := cloneArtifacts(s.artifacts)
	requestSnapshot := cloneSupportRequests(s.requests)
	taskSnapshot := cloneDeletionTasks(s.tasks)
	activeRequestSnapshot := s.activeRequest
	openSessionSnapshot := s.openSession
	s.inTransaction = true
	err := work((*fakeArtifactSupportTx)(s))
	s.inTransaction = false
	if err != nil {
		s.idempotency = idempotencySnapshot
		s.artifacts = artifactSnapshot
		s.requests = requestSnapshot
		s.tasks = taskSnapshot
		s.activeRequest = activeRequestSnapshot
		s.openSession = openSessionSnapshot
	}
	return err
}

func (s *fakeArtifactSupportStore) GetUserPair(context.Context, domain.ID) (domain.UserPair, bool, error) {
	return s.pair, s.pair.UserID != "", nil
}

func (s *fakeArtifactSupportStore) GetAvailableArtifact(_ context.Context, id domain.ID) (domain.Artifact, bool, error) {
	artifact, ok := s.artifacts[id]
	if ok {
		for _, task := range s.tasks {
			if task.StorageKey == artifact.StorageKey {
				return domain.Artifact{}, false, nil
			}
		}
	}
	return artifact, ok, nil
}

func (s *fakeArtifactSupportStore) GetSupportRequest(_ context.Context, id domain.ID) (domain.SupportRequest, bool, error) {
	request, ok := s.requests[id]
	return request, ok, nil
}

func (s *fakeArtifactSupportStore) ListSupportRequests(_ context.Context, _ domain.UserPair, status *domain.SupportRequestStatus) ([]domain.SupportRequest, error) {
	items := make([]domain.SupportRequest, 0, len(s.requests))
	for _, request := range s.requests {
		if status == nil || request.Status == *status {
			items = append(items, request)
		}
	}
	return items, nil
}

type fakeArtifactSupportTx fakeArtifactSupportStore

func (t *fakeArtifactSupportTx) TryCreateIdempotency(_ context.Context, record domain.IdempotencyRecord) (bool, error) {
	key := scopeMapKey(record.Scope)
	if _, ok := t.idempotency[key]; ok {
		return false, nil
	}
	t.idempotency[key] = record
	return true, nil
}

func (t *fakeArtifactSupportTx) LockIdempotency(_ context.Context, scope domain.IdempotencyScope) (domain.IdempotencyRecord, bool, error) {
	record, ok := t.idempotency[scopeMapKey(scope)]
	return record, ok, nil
}

func (t *fakeArtifactSupportTx) TakeOverIdempotency(_ context.Context, scope domain.IdempotencyScope, resourceID *domain.ID, now time.Time) (domain.IdempotencyRecord, bool, error) {
	key := scopeMapKey(scope)
	record, ok := t.idempotency[key]
	if !ok || record.Status != domain.IdempotencyInProgress || record.LeaseExpiresAt.After(now) {
		return domain.IdempotencyRecord{}, false, nil
	}
	if record.ResourceID == nil {
		record.ResourceID = resourceID
	}
	lease := now.Add(domain.IdempotencyLease)
	record.LeaseExpiresAt = &lease
	t.idempotency[key] = record
	return record, true, nil
}

func (t *fakeArtifactSupportTx) ReleaseIdempotency(_ context.Context, scope domain.IdempotencyScope, now time.Time) error {
	record := t.idempotency[scopeMapKey(scope)]
	record.LeaseExpiresAt = &now
	t.idempotency[scopeMapKey(scope)] = record
	return nil
}

func (t *fakeArtifactSupportTx) CompleteIdempotency(_ context.Context, scope domain.IdempotencyScope, status int, body json.RawMessage, now time.Time) (domain.IdempotencyRecord, bool, error) {
	record, ok := t.idempotency[scopeMapKey(scope)]
	if !ok || record.Status != domain.IdempotencyInProgress {
		return domain.IdempotencyRecord{}, false, nil
	}
	completed, err := CompleteIdempotencyRecord(record, status, body, now)
	if err != nil {
		return domain.IdempotencyRecord{}, false, err
	}
	t.idempotency[scopeMapKey(scope)] = completed
	return completed, true, nil
}

func (t *fakeArtifactSupportTx) LockUser(_ context.Context, id domain.ID) (domain.User, bool, error) {
	return domain.User{ID: id, Role: domain.RoleUser, DisplayName: "利用者"}, true, nil
}

func (t *fakeArtifactSupportTx) GetUserPair(context.Context, domain.ID) (domain.UserPair, bool, error) {
	return t.pair, t.pair.UserID != "", nil
}

func (t *fakeArtifactSupportTx) LockAvailableArtifact(_ context.Context, id domain.ID) (domain.Artifact, bool, error) {
	artifact, ok := t.artifacts[id]
	return artifact, ok, nil
}

func (t *fakeArtifactSupportTx) HasArtifactDeletionTask(_ context.Context, storageKey string) (bool, error) {
	for _, task := range t.tasks {
		if task.StorageKey == storageKey {
			return true, nil
		}
	}
	return false, nil
}

func (t *fakeArtifactSupportTx) ArtifactHasReferences(_ context.Context, id domain.ID) (bool, error) {
	for _, request := range t.requests {
		if request.InitialScreenshotArtifactID == id {
			return true, nil
		}
	}
	return false, nil
}

func (t *fakeArtifactSupportTx) CreateArtifact(_ context.Context, artifact domain.Artifact) (domain.Artifact, error) {
	if t.createArtifactErr != nil {
		return domain.Artifact{}, t.createArtifactErr
	}
	t.artifacts[artifact.ID] = artifact
	return artifact, nil
}

func (t *fakeArtifactSupportTx) HasActiveSupportRequest(context.Context, domain.ID) (bool, error) {
	return t.activeRequest, nil
}

func (t *fakeArtifactSupportTx) HasOpenSupportSession(context.Context, domain.ID) (bool, error) {
	return t.openSession, nil
}

func (t *fakeArtifactSupportTx) CreateSupportRequest(_ context.Context, request domain.SupportRequest) (domain.SupportRequest, error) {
	if t.createRequestErr != nil {
		return domain.SupportRequest{}, t.createRequestErr
	}
	t.requests[request.ID] = request
	t.activeRequest = true
	return request, nil
}

func (t *fakeArtifactSupportTx) ListStaleRequestArtifacts(context.Context, time.Time, int) ([]domain.Artifact, error) {
	return append([]domain.Artifact(nil), t.staleArtifacts...), nil
}

func (t *fakeArtifactSupportTx) ListExpiredIdempotency(context.Context, time.Time, int) ([]repository.ExpiredIdempotencyRecord, error) {
	return append([]repository.ExpiredIdempotencyRecord(nil), t.expiredIdempotency...), nil
}

func (t *fakeArtifactSupportTx) CreateArtifactDeletionTask(_ context.Context, task domain.ArtifactDeletionTask) error {
	for _, existing := range t.tasks {
		if existing.StorageKey == task.StorageKey {
			return nil
		}
	}
	t.tasks[task.ID] = task
	return nil
}

func (t *fakeArtifactSupportTx) DeleteIdempotency(_ context.Context, scope domain.IdempotencyScope) error {
	delete(t.idempotency, scopeMapKey(scope))
	return nil
}

func (t *fakeArtifactSupportTx) ResetRunningArtifactDeletionTasks(context.Context) (int64, error) {
	var count int64
	for id, task := range t.tasks {
		if task.Status == domain.ArtifactDeletionRunning {
			task.Status = domain.ArtifactDeletionPending
			t.tasks[id] = task
			count++
		}
	}
	return count, nil
}

func (t *fakeArtifactSupportTx) LockNextArtifactDeletionTask(_ context.Context, now time.Time) (domain.ArtifactDeletionTask, bool, error) {
	for _, task := range t.tasks {
		if task.Status == domain.ArtifactDeletionPending && !task.NextAttemptAt.After(now) {
			return task, true, nil
		}
	}
	return domain.ArtifactDeletionTask{}, false, nil
}

func (t *fakeArtifactSupportTx) MarkArtifactDeletionTaskRunning(_ context.Context, id domain.ID) (domain.ArtifactDeletionTask, bool, error) {
	task, ok := t.tasks[id]
	if !ok || task.Status != domain.ArtifactDeletionPending {
		return domain.ArtifactDeletionTask{}, false, nil
	}
	task.Status = domain.ArtifactDeletionRunning
	task.Attempt++
	t.tasks[id] = task
	return task, true, nil
}

func (t *fakeArtifactSupportTx) RetryArtifactDeletionTask(_ context.Context, id domain.ID, next time.Time) error {
	task := t.tasks[id]
	task.Status = domain.ArtifactDeletionPending
	task.NextAttemptAt = next
	t.tasks[id] = task
	return nil
}

func (t *fakeArtifactSupportTx) DeleteArtifactIfUnreferenced(_ context.Context, id domain.ID) (bool, error) {
	_, found := t.artifacts[id]
	delete(t.artifacts, id)
	return found, nil
}

func (t *fakeArtifactSupportTx) DeleteArtifactDeletionTask(_ context.Context, id domain.ID) error {
	delete(t.tasks, id)
	return nil
}

type fakeArtifactSupportStorage struct {
	objects     map[string][]byte
	putCalls    int
	putKeys     []string
	putErr      error
	getErr      error
	deleteCalls int
	deleteErr   error
}

func newFakeArtifactSupportStorage() *fakeArtifactSupportStorage {
	return &fakeArtifactSupportStorage{objects: map[string][]byte{}}
}

func (s *fakeArtifactSupportStorage) Put(_ context.Context, key string, body io.Reader, _ int64, _ string) error {
	s.putCalls++
	s.putKeys = append(s.putKeys, key)
	data, _ := io.ReadAll(body)
	if s.putErr == nil {
		s.objects[key] = data
	}
	return s.putErr
}

func (s *fakeArtifactSupportStorage) Get(_ context.Context, key string) (repository.StoredObject, error) {
	if s.getErr != nil {
		return repository.StoredObject{}, s.getErr
	}
	data, ok := s.objects[key]
	if !ok {
		return repository.StoredObject{}, errors.New("not found")
	}
	return repository.StoredObject{Body: io.NopCloser(bytes.NewReader(data)), ContentType: "image/jpeg", Size: int64(len(data))}, nil
}

func (s *fakeArtifactSupportStorage) Delete(_ context.Context, key string) error {
	s.deleteCalls++
	if s.deleteErr == nil {
		delete(s.objects, key)
	}
	return s.deleteErr
}

type fakeArtifactSupportEventPublisher struct {
	store                      *fakeArtifactSupportStore
	events                     []domain.Event
	publishedInsideTransaction bool
}

func (p *fakeArtifactSupportEventPublisher) Publish(_ context.Context, event domain.Event) error {
	if p.store.inTransaction {
		p.publishedInsideTransaction = true
	}
	p.events = append(p.events, event)
	return nil
}

func newTestArtifactSupportService(
	store *fakeArtifactSupportStore,
	storage repository.ObjectStorage,
	publisher EventPublisher,
	now func() time.Time,
) *ArtifactSupportService {
	counters := map[string]int{}
	var countersMu sync.Mutex
	return NewArtifactSupportService(store, storage, publisher, slog.New(slog.NewTextHandler(io.Discard, nil)), ArtifactSupportServiceOptions{
		Now: now,
		NewID: func(prefix string) (domain.ID, error) {
			countersMu.Lock()
			defer countersMu.Unlock()
			counters[prefix]++
			return domain.ID(prefix + "_" + string(rune('0'+counters[prefix]))), nil
		},
	})
}

func testJPEG(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, img, &jpeg.Options{Quality: 80}); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func shaForTest(t *testing.T, data []byte) domain.RequestHash {
	t.Helper()
	_, hash, _, _, err := validateArtifactJPEG(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	return hash
}

func validTestArtifact(id, owner domain.ID, now time.Time) domain.Artifact {
	return domain.Artifact{
		ID: id, OwnerUserID: owner, Purpose: domain.ArtifactPurposeRequestScreenshot,
		MimeType: "image/jpeg", StorageKey: domain.ArtifactStorageKey(owner, id), SHA256: strings.Repeat("a", 64),
		ByteSize: 10, Width: 1, Height: 1, CapturedAt: now, CreatedAt: now, UpdatedAt: now, Revision: 1,
	}
}

func validTestSupportRequest(id domain.ID, pair domain.UserPair, artifactID domain.ID, now time.Time) domain.SupportRequest {
	return domain.SupportRequest{
		ID: id, UserID: pair.UserID, FamilyID: pair.FamilyID, InitialScreenshotArtifactID: artifactID,
		Status: domain.SupportRequestPending, CreatedAt: now, UpdatedAt: now, Revision: 1,
	}
}

func testPair() domain.UserPair {
	return domain.UserPair{UserID: "user_demo", FamilyID: "family_demo"}
}

func testUserActor() domain.Actor {
	return domain.Actor{ID: "user_demo", Role: domain.RoleUser}
}

func onlyIdempotencyRecord(t *testing.T, store *fakeArtifactSupportStore) domain.IdempotencyRecord {
	t.Helper()
	if len(store.idempotency) != 1 {
		t.Fatalf("idempotency records = %d", len(store.idempotency))
	}
	for _, record := range store.idempotency {
		return record
	}
	panic("unreachable")
}

func assertDomainCode(t *testing.T, err error, want domain.ErrorCode) {
	t.Helper()
	code, ok := domain.ErrorCodeOf(err)
	if !ok || code != want {
		t.Fatalf("error = %v, code = %q, want %q", err, code, want)
	}
}

func scopeMapKey(scope domain.IdempotencyScope) string {
	return string(scope.ActorID) + "|" + scope.Method + "|" + scope.Path + "|" + string(scope.Key)
}

func cloneIdempotencyRecords(source map[string]domain.IdempotencyRecord) map[string]domain.IdempotencyRecord {
	result := make(map[string]domain.IdempotencyRecord, len(source))
	for key, value := range source {
		copyValue := value
		copyValue.ResponseBody = append(json.RawMessage(nil), value.ResponseBody...)
		result[key] = copyValue
	}
	return result
}

func cloneArtifacts(source map[domain.ID]domain.Artifact) map[domain.ID]domain.Artifact {
	result := make(map[domain.ID]domain.Artifact, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func cloneSupportRequests(source map[domain.ID]domain.SupportRequest) map[domain.ID]domain.SupportRequest {
	result := make(map[domain.ID]domain.SupportRequest, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func cloneDeletionTasks(source map[domain.ID]domain.ArtifactDeletionTask) map[domain.ID]domain.ArtifactDeletionTask {
	result := make(map[domain.ID]domain.ArtifactDeletionTask, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}
