package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/livekit"
	"github.com/kakuraccho/mite/server/internal/repository"
)

var sessionTestNow = time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)

func TestSupportSessionServiceCallAndReplay(t *testing.T) {
	store := newFakeSessionStore()
	store.requests["request_1"] = pendingRequest()
	publisher := &supportSessionFakeEventPublisher{}
	service := newTestSessionService(store, publisher, &fakeTokenIssuer{})
	actor := domain.Actor{ID: "family_1", Role: domain.RoleFamily}

	first, err := service.Call(context.Background(), actor, "request_1", 1, "key-1", "request-first")
	if err != nil {
		t.Fatal(err)
	}
	if first.SupportRequest.Revision != 2 || first.SupportSession.Revision != 1 || first.SupportSession.Status != domain.SupportSessionRinging || first.SupportSession.LiveKitRoomName != "mite-session_1" {
		t.Fatalf("result = %+v", first)
	}
	if len(publisher.events) != 2 || publisher.events[0].Type != domain.EventSupportRequestUpdated || publisher.events[1].Type != domain.EventSupportSessionCreated {
		t.Fatalf("events = %+v", publisher.events)
	}

	replay, err := service.Call(context.Background(), actor, "request_1", 1, "key-1", "request-replay")
	if err != nil {
		t.Fatal(err)
	}
	if replay.SupportSession.ID != first.SupportSession.ID || replay.SupportRequest.Revision != 2 {
		t.Fatalf("replay = %+v", replay)
	}
	if len(store.sessions) != 1 || len(publisher.events) != 2 {
		t.Fatalf("sessions=%d events=%d", len(store.sessions), len(publisher.events))
	}

	_, err = service.Call(context.Background(), actor, "request_1", 2, "key-1", "request-other")
	if code, _ := domain.ErrorCodeOf(err); code != domain.CodeIdempotencyKeyReused {
		t.Fatalf("code=%s err=%v", code, err)
	}
}

func TestSupportSessionServiceCallRevisionConflictIsReplayed(t *testing.T) {
	store := newFakeSessionStore()
	request := pendingRequest()
	request.Revision = 2
	store.requests[request.ID] = request
	service := newTestSessionService(store, &supportSessionFakeEventPublisher{}, &fakeTokenIssuer{})
	actor := domain.Actor{ID: "family_1", Role: domain.RoleFamily}
	_, firstErr := service.Call(context.Background(), actor, "request_1", 1, "key-conflict", "request-original")
	if code, _ := domain.ErrorCodeOf(firstErr); code != domain.CodeRevisionConflict {
		t.Fatalf("code=%s", code)
	}
	_, replayErr := service.Call(context.Background(), actor, "request_1", 1, "key-conflict", "request-new")
	var operationErr *SupportSessionOperationError
	if !errors.As(replayErr, &operationErr) || operationErr.RequestID != "request-original" {
		t.Fatalf("replay error=%#v", replayErr)
	}
}

func TestSupportSessionServiceRejectsWrongPairAndRole(t *testing.T) {
	store := ringingStore()
	service := newTestSessionService(store, &supportSessionFakeEventPublisher{}, &fakeTokenIssuer{})
	if _, err := service.Get(context.Background(), domain.Actor{ID: "user_other", Role: domain.RoleUser}, "session_1"); testErrorCode(err) != domain.CodeForbidden {
		t.Fatalf("Get code=%s err=%v", testErrorCode(err), err)
	}
	consent := domain.Consent{Audio: true, ScreenShare: true, PeriodicCapture: true, TextVersion: "v3"}
	if _, err := service.Accept(context.Background(), domain.Actor{ID: "family_1", Role: domain.RoleFamily}, "session_1", 1, consent, "key", "request"); testErrorCode(err) != domain.CodeForbidden {
		t.Fatalf("Accept code=%s err=%v", testErrorCode(err), err)
	}
}

func TestSupportSessionServiceAccept(t *testing.T) {
	store := ringingStore()
	publisher := &supportSessionFakeEventPublisher{}
	service := newTestSessionService(store, publisher, &fakeTokenIssuer{})
	consent := domain.Consent{Audio: true, ScreenShare: true, PeriodicCapture: true, TextVersion: "v3"}
	result, err := service.Accept(context.Background(), domain.Actor{ID: "user_1", Role: domain.RoleUser}, "session_1", 1, consent, "accept-key", "request-1")
	if err != nil {
		t.Fatal(err)
	}
	if result.SupportRequest.Status != domain.SupportRequestInSupport || result.SupportRequest.Revision != 3 || result.SupportSession.Status != domain.SupportSessionActive || result.SupportSession.Revision != 2 || result.SupportSession.Consent == nil || result.SupportSession.StartedAt == nil {
		t.Fatalf("result=%+v", result)
	}
	if len(publisher.events) != 2 {
		t.Fatalf("events=%d", len(publisher.events))
	}
}

func TestSupportSessionServiceAcceptRequiresFullConsent(t *testing.T) {
	store := ringingStore()
	service := newTestSessionService(store, &supportSessionFakeEventPublisher{}, &fakeTokenIssuer{})
	consent := domain.Consent{Audio: true, ScreenShare: false, PeriodicCapture: true, TextVersion: "v3"}
	_, err := service.Accept(context.Background(), domain.Actor{ID: "user_1", Role: domain.RoleUser}, "session_1", 1, consent, "accept-key", "request-1")
	if code, _ := domain.ErrorCodeOf(err); code != domain.CodeValidationError {
		t.Fatalf("code=%s err=%v", code, err)
	}
	if store.sessions["session_1"].Status != domain.SupportSessionRinging {
		t.Fatal("state changed")
	}
}

func TestSupportSessionServiceResolve(t *testing.T) {
	for _, decision := range []domain.GuideDecision{domain.GuideDecisionCreate, domain.GuideDecisionSkip} {
		t.Run(string(decision), func(t *testing.T) {
			store := activeStore()
			service := newTestSessionService(store, &supportSessionFakeEventPublisher{}, &fakeTokenIssuer{})
			result, err := service.Resolve(context.Background(), domain.Actor{ID: "family_1", Role: domain.RoleFamily}, "session_1", 2, decision, "resolve-key", "request-1")
			if err != nil {
				t.Fatal(err)
			}
			if result.SupportRequest.Status != domain.SupportRequestResolved || result.SupportRequest.Revision != 4 || result.SupportSession.Revision != 3 {
				t.Fatalf("result=%+v", result)
			}
			if decision == domain.GuideDecisionCreate && result.SupportSession.Status != domain.SupportSessionGeneratingGuide {
				t.Fatalf("status=%s", result.SupportSession.Status)
			}
			if decision == domain.GuideDecisionSkip && (result.SupportSession.Status != domain.SupportSessionEnded || result.SupportSession.EndReason == nil || *result.SupportSession.EndReason != domain.EndReasonGuideSkipped) {
				t.Fatalf("session=%+v", result.SupportSession)
			}
		})
	}
}

func TestSupportSessionServiceSerializesCompetingRevisionUpdates(t *testing.T) {
	store := activeStore()
	service := newTestSessionService(store, &supportSessionFakeEventPublisher{}, &fakeTokenIssuer{})
	actor := domain.Actor{ID: "family_1", Role: domain.RoleFamily}
	var wait sync.WaitGroup
	errorsByCall := make([]error, 2)
	for index, decision := range []domain.GuideDecision{domain.GuideDecisionCreate, domain.GuideDecisionSkip} {
		wait.Add(1)
		go func(index int, decision domain.GuideDecision) {
			defer wait.Done()
			_, errorsByCall[index] = service.Resolve(context.Background(), actor, "session_1", 2, decision, fmt.Sprintf("key-%d", index), fmt.Sprintf("request-%d", index))
		}(index, decision)
	}
	wait.Wait()
	succeeded, conflicted := 0, 0
	for _, err := range errorsByCall {
		if err == nil {
			succeeded++
			continue
		}
		if code, _ := domain.ErrorCodeOf(err); code == domain.CodeRevisionConflict {
			conflicted++
			continue
		}
		t.Fatalf("unexpected error: %v", err)
	}
	if succeeded != 1 || conflicted != 1 {
		t.Fatalf("succeeded=%d conflicted=%d errors=%v", succeeded, conflicted, errorsByCall)
	}
}

func TestSupportSessionServiceEndWithoutGuideCleansIntermediateData(t *testing.T) {
	store := activeStore()
	session := store.sessions["session_1"]
	session.Status = domain.SupportSessionGeneratingGuide
	decision := domain.GuideDecisionCreate
	batchID := domain.ID("batch_1")
	jobID := domain.ID("job_1")
	draftID := domain.ID("draft_1")
	session.GuideDecision = &decision
	session.GuideMaterialBatchID = &batchID
	session.GuideGenerationJobID = &jobID
	session.GuideDraftID = &draftID
	session.Revision = 6
	store.sessions[session.ID] = session
	store.jobStatuses[jobID] = domain.GuideGenerationJobFailed
	store.artifacts[batchID] = []repository.CleanupArtifact{{ID: "artifact_1", StorageKey: "user_1/artifact_1.jpg"}}
	service := newTestSessionService(store, &supportSessionFakeEventPublisher{}, &fakeTokenIssuer{})
	result, err := service.EndWithoutGuide(context.Background(), domain.Actor{ID: "family_1", Role: domain.RoleFamily}, "session_1", 6, domain.EndReasonGuideCancelled, "end-key", "request-1")
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != domain.SupportSessionEnded || result.Revision != 7 || result.EndReason == nil || *result.EndReason != domain.EndReasonGuideCancelled || result.GuideMaterialBatchID != nil || result.GuideGenerationJobID != nil || result.GuideDraftID != nil {
		t.Fatalf("session=%+v", result)
	}
	if len(store.queuedArtifacts) != 1 || !store.deletedJobs[jobID] || !store.deletedBatches[batchID] || !store.deletedDrafts[draftID] {
		t.Fatalf("cleanup not completed: %+v", store)
	}
}

func TestSupportSessionServiceEndWithoutGuideRejectsRunningJob(t *testing.T) {
	store := activeStore()
	session := store.sessions["session_1"]
	decision := domain.GuideDecisionCreate
	jobID := domain.ID("job_1")
	session.Status = domain.SupportSessionGeneratingGuide
	session.GuideDecision = &decision
	session.GuideGenerationJobID = &jobID
	session.Revision = 4
	store.sessions[session.ID] = session
	store.jobStatuses[jobID] = domain.GuideGenerationJobRunning
	service := newTestSessionService(store, &supportSessionFakeEventPublisher{}, &fakeTokenIssuer{})
	_, err := service.EndWithoutGuide(context.Background(), domain.Actor{ID: "family_1", Role: domain.RoleFamily}, "session_1", 4, domain.EndReasonGuideCancelled, "end-key", "request-1")
	if code, _ := domain.ErrorCodeOf(err); code != domain.CodeInvalidState {
		t.Fatalf("code=%s err=%v", code, err)
	}
}

func TestSupportSessionServiceUserEndsWhenNoMaterials(t *testing.T) {
	store := activeStore()
	session := store.sessions["session_1"]
	decision := domain.GuideDecisionCreate
	session.Status = domain.SupportSessionGeneratingGuide
	session.GuideDecision = &decision
	session.Revision = 3
	store.sessions[session.ID] = session
	service := newTestSessionService(store, &supportSessionFakeEventPublisher{}, &fakeTokenIssuer{})
	result, err := service.EndWithoutGuide(context.Background(), domain.Actor{ID: "user_1", Role: domain.RoleUser}, "session_1", 3, domain.EndReasonNoMaterials, "no-materials-key", "request-1")
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != domain.SupportSessionEnded || result.EndReason == nil || *result.EndReason != domain.EndReasonNoMaterials {
		t.Fatalf("result=%+v", result)
	}
}

func TestSupportSessionServiceLiveKitTokenRoles(t *testing.T) {
	for _, tt := range []struct {
		actor    domain.Actor
		identity string
	}{{domain.Actor{ID: "user_1", Role: domain.RoleUser}, "user:user_1"}, {domain.Actor{ID: "family_1", Role: domain.RoleFamily}, "family:family_1"}} {
		store := activeStore()
		issuer := &fakeTokenIssuer{}
		service := newTestSessionService(store, &supportSessionFakeEventPublisher{}, issuer)
		connection, err := service.CreateLiveKitToken(context.Background(), tt.actor, "session_1")
		if err != nil {
			t.Fatal(err)
		}
		if connection.ParticipantIdentity != tt.identity || issuer.request.RoomName != "mite-session_1" || issuer.request.Role != tt.actor.Role || connection.ExpiresAt.Sub(sessionTestNow) != 30*time.Minute {
			t.Fatalf("connection=%+v issuer=%+v", connection, issuer.request)
		}
	}
}

func TestSupportSessionServiceLiveKitTokenRequiresActiveSession(t *testing.T) {
	store := ringingStore()
	service := newTestSessionService(store, &supportSessionFakeEventPublisher{}, &fakeTokenIssuer{})
	_, err := service.CreateLiveKitToken(context.Background(), domain.Actor{ID: "user_1", Role: domain.RoleUser}, "session_1")
	if code, _ := domain.ErrorCodeOf(err); code != domain.CodeInvalidState {
		t.Fatalf("code=%s err=%v", code, err)
	}
}

func TestSupportSessionServiceMapsLiveKitIssuerFailure(t *testing.T) {
	store := activeStore()
	service := newTestSessionService(store, &supportSessionFakeEventPublisher{}, &fakeTokenIssuer{err: errors.New("provider unavailable")})
	_, err := service.CreateLiveKitToken(context.Background(), domain.Actor{ID: "user_1", Role: domain.RoleUser}, "session_1")
	if code, _ := domain.ErrorCodeOf(err); code != domain.CodeExternalServiceUnavailable {
		t.Fatalf("code=%s err=%v", code, err)
	}
}

func TestSupportSessionServiceDoesNotPublishOnRollback(t *testing.T) {
	store := ringingStore()
	store.failComplete = true
	publisher := &supportSessionFakeEventPublisher{}
	service := newTestSessionService(store, publisher, &fakeTokenIssuer{})
	consent := domain.Consent{Audio: true, ScreenShare: true, PeriodicCapture: true, TextVersion: "v3"}
	_, err := service.Accept(context.Background(), domain.Actor{ID: "user_1", Role: domain.RoleUser}, "session_1", 1, consent, "accept-key", "request-1")
	if err == nil {
		t.Fatal("expected error")
	}
	if len(publisher.events) != 0 || store.sessions["session_1"].Status != domain.SupportSessionRinging {
		t.Fatalf("events=%d session=%+v", len(publisher.events), store.sessions["session_1"])
	}
}

func testErrorCode(err error) domain.ErrorCode { code, _ := domain.ErrorCodeOf(err); return code }

type supportSessionFakeEventPublisher struct {
	events []domain.Event
	err    error
}

func (p *supportSessionFakeEventPublisher) Publish(_ context.Context, event domain.Event) error {
	p.events = append(p.events, event)
	return p.err
}

type fakeTokenIssuer struct {
	request livekit.TokenRequest
	err     error
}

func (i *fakeTokenIssuer) Issue(_ context.Context, request livekit.TokenRequest) (livekit.Token, error) {
	i.request = request
	if i.err != nil {
		return livekit.Token{}, i.err
	}
	return livekit.Token{ServerURL: "wss://test.livekit.cloud", Value: "signed-token", ExpiresAt: request.ExpiresAt}, nil
}

func newTestSessionService(store *fakeSessionStore, publisher EventPublisher, issuer livekit.TokenIssuer) *SupportSessionService {
	service := NewSupportSessionService(store, publisher, issuer, nil)
	service.now = func() time.Time { return sessionTestNow }
	counters := map[string]int{}
	var countersMu sync.Mutex
	service.newID = func(prefix string) (domain.ID, error) {
		countersMu.Lock()
		defer countersMu.Unlock()
		counters[prefix]++
		return domain.ID(fmt.Sprintf("%s_%d", prefix, counters[prefix])), nil
	}
	return service
}

func pendingRequest() domain.SupportRequest {
	return domain.SupportRequest{ID: "request_1", UserID: "user_1", FamilyID: "family_1", InitialScreenshotArtifactID: "artifact_1", Comment: "help", Status: domain.SupportRequestPending, CreatedAt: sessionTestNow.Add(-time.Hour), UpdatedAt: sessionTestNow.Add(-time.Hour), Revision: 1}
}
func ringingStore() *fakeSessionStore {
	store := newFakeSessionStore()
	request := pendingRequest()
	sessionID := domain.ID("session_1")
	request.SupportSessionID = &sessionID
	request.Revision = 2
	store.requests[request.ID] = request
	store.sessions[sessionID] = domain.SupportSession{ID: sessionID, SupportRequestID: request.ID, UserID: request.UserID, FamilyID: request.FamilyID, LiveKitRoomName: "mite-session_1", Status: domain.SupportSessionRinging, CreatedAt: sessionTestNow.Add(-time.Minute), UpdatedAt: sessionTestNow.Add(-time.Minute), Revision: 1}
	return store
}
func activeStore() *fakeSessionStore {
	store := ringingStore()
	request := store.requests["request_1"]
	request.Status = domain.SupportRequestInSupport
	request.Revision = 3
	store.requests[request.ID] = request
	session := store.sessions["session_1"]
	consent := domain.Consent{Audio: true, ScreenShare: true, PeriodicCapture: true, TextVersion: "v3"}
	started := sessionTestNow.Add(-time.Minute)
	session.Status = domain.SupportSessionActive
	session.Consent = &consent
	session.ConsentedAt = &started
	session.StartedAt = &started
	session.Revision = 2
	store.sessions[session.ID] = session
	return store
}

type fakeSessionStore struct {
	txMu            sync.Mutex
	requests        map[domain.ID]domain.SupportRequest
	sessions        map[domain.ID]domain.SupportSession
	idempotency     map[string]domain.IdempotencyRecord
	jobStatuses     map[domain.ID]domain.GuideGenerationJobStatus
	artifacts       map[domain.ID][]repository.CleanupArtifact
	queuedArtifacts []repository.CleanupArtifact
	deletedJobs     map[domain.ID]bool
	deletedBatches  map[domain.ID]bool
	deletedDrafts   map[domain.ID]bool
	failComplete    bool
}

func newFakeSessionStore() *fakeSessionStore {
	return &fakeSessionStore{requests: map[domain.ID]domain.SupportRequest{}, sessions: map[domain.ID]domain.SupportSession{}, idempotency: map[string]domain.IdempotencyRecord{}, jobStatuses: map[domain.ID]domain.GuideGenerationJobStatus{}, artifacts: map[domain.ID][]repository.CleanupArtifact{}, deletedJobs: map[domain.ID]bool{}, deletedBatches: map[domain.ID]bool{}, deletedDrafts: map[domain.ID]bool{}}
}
func (s *fakeSessionStore) GetRequest(_ context.Context, id domain.ID) (domain.SupportRequest, error) {
	s.txMu.Lock()
	defer s.txMu.Unlock()
	value, ok := s.requests[id]
	if !ok {
		return domain.SupportRequest{}, domain.NewError(domain.CodeNotFound, "not found")
	}
	return value, nil
}
func (s *fakeSessionStore) GetSession(_ context.Context, id domain.ID) (domain.SupportSession, error) {
	s.txMu.Lock()
	defer s.txMu.Unlock()
	value, ok := s.sessions[id]
	if !ok {
		return domain.SupportSession{}, domain.NewError(domain.CodeNotFound, "not found")
	}
	return value, nil
}
func (s *fakeSessionStore) WithinTransaction(ctx context.Context, work func(repository.SupportSessionTransaction) error) error {
	s.txMu.Lock()
	defer s.txMu.Unlock()
	backup := s.clone()
	if err := work((*fakeSessionTransaction)(s)); err != nil {
		s.requests = backup.requests
		s.sessions = backup.sessions
		s.idempotency = backup.idempotency
		s.jobStatuses = backup.jobStatuses
		s.artifacts = backup.artifacts
		s.queuedArtifacts = backup.queuedArtifacts
		s.deletedJobs = backup.deletedJobs
		s.deletedBatches = backup.deletedBatches
		s.deletedDrafts = backup.deletedDrafts
		s.failComplete = backup.failComplete
		return err
	}
	return nil
}
func (s *fakeSessionStore) clone() *fakeSessionStore {
	clone := newFakeSessionStore()
	for k, v := range s.requests {
		clone.requests[k] = v
	}
	for k, v := range s.sessions {
		clone.sessions[k] = v
	}
	for k, v := range s.idempotency {
		clone.idempotency[k] = v
	}
	for k, v := range s.jobStatuses {
		clone.jobStatuses[k] = v
	}
	for k, v := range s.artifacts {
		clone.artifacts[k] = append([]repository.CleanupArtifact(nil), v...)
	}
	clone.queuedArtifacts = append([]repository.CleanupArtifact(nil), s.queuedArtifacts...)
	for k, v := range s.deletedJobs {
		clone.deletedJobs[k] = v
	}
	for k, v := range s.deletedBatches {
		clone.deletedBatches[k] = v
	}
	for k, v := range s.deletedDrafts {
		clone.deletedDrafts[k] = v
	}
	clone.failComplete = s.failComplete
	return clone
}

type fakeSessionTransaction fakeSessionStore

func (t *fakeSessionTransaction) store() *fakeSessionStore { return (*fakeSessionStore)(t) }
func (t *fakeSessionTransaction) LockRequest(_ context.Context, id domain.ID) (domain.SupportRequest, error) {
	value, ok := t.requests[id]
	if !ok {
		return domain.SupportRequest{}, domain.NewError(domain.CodeNotFound, "not found")
	}
	return value, nil
}
func (t *fakeSessionTransaction) LockSession(_ context.Context, id domain.ID) (domain.SupportSession, error) {
	value, ok := t.sessions[id]
	if !ok {
		return domain.SupportSession{}, domain.NewError(domain.CodeNotFound, "not found")
	}
	return value, nil
}
func (t *fakeSessionTransaction) CreateSession(_ context.Context, value domain.SupportSession) (domain.SupportSession, error) {
	t.sessions[value.ID] = value
	return value, nil
}
func (t *fakeSessionTransaction) AttachSession(_ context.Context, requestID, sessionID domain.ID, now time.Time) (domain.SupportRequest, error) {
	value := t.requests[requestID]
	value.SupportSessionID = &sessionID
	value.UpdatedAt = now
	value.Revision++
	t.requests[requestID] = value
	return value, nil
}
func (t *fakeSessionTransaction) ActivateRequest(_ context.Context, id domain.ID, now time.Time) (domain.SupportRequest, error) {
	value := t.requests[id]
	value.Status = domain.SupportRequestInSupport
	value.UpdatedAt = now
	value.Revision++
	t.requests[id] = value
	return value, nil
}
func (t *fakeSessionTransaction) ActivateSession(_ context.Context, id domain.ID, consent domain.Consent, now time.Time) (domain.SupportSession, error) {
	value := t.sessions[id]
	value.Status = domain.SupportSessionActive
	value.Consent = &consent
	value.ConsentedAt = &now
	value.StartedAt = &now
	value.UpdatedAt = now
	value.Revision++
	t.sessions[id] = value
	return value, nil
}
func (t *fakeSessionTransaction) ResolveRequest(_ context.Context, id domain.ID, now time.Time) (domain.SupportRequest, error) {
	value := t.requests[id]
	value.Status = domain.SupportRequestResolved
	value.UpdatedAt = now
	value.Revision++
	t.requests[id] = value
	return value, nil
}
func (t *fakeSessionTransaction) ResolveSession(_ context.Context, id domain.ID, decision domain.GuideDecision, now time.Time) (domain.SupportSession, error) {
	value := t.sessions[id]
	value.GuideDecision = &decision
	if decision == domain.GuideDecisionCreate {
		value.Status = domain.SupportSessionGeneratingGuide
	} else {
		reason := domain.EndReasonGuideSkipped
		value.Status = domain.SupportSessionEnded
		value.EndReason = &reason
		value.EndedAt = &now
	}
	value.UpdatedAt = now
	value.Revision++
	t.sessions[id] = value
	return value, nil
}
func (t *fakeSessionTransaction) GenerationJobStatus(_ context.Context, id domain.ID) (domain.GuideGenerationJobStatus, error) {
	value, ok := t.jobStatuses[id]
	if !ok {
		return "", domain.NewError(domain.CodeNotFound, "not found")
	}
	return value, nil
}
func (t *fakeSessionTransaction) CleanupArtifacts(_ context.Context, id domain.ID) ([]repository.CleanupArtifact, error) {
	return append([]repository.CleanupArtifact(nil), t.artifacts[id]...), nil
}
func (t *fakeSessionTransaction) QueueArtifactDeletion(_ context.Context, _ domain.ID, artifact repository.CleanupArtifact, _ time.Time) error {
	t.queuedArtifacts = append(t.queuedArtifacts, artifact)
	return nil
}
func (t *fakeSessionTransaction) EndWithoutGuide(_ context.Context, id domain.ID, reason domain.SupportSessionEndReason, now time.Time) (domain.SupportSession, error) {
	value := t.sessions[id]
	value.Status = domain.SupportSessionEnded
	value.GuideMaterialBatchID = nil
	value.GuideGenerationJobID = nil
	value.GuideDraftID = nil
	value.GuideID = nil
	value.EndReason = &reason
	value.EndedAt = &now
	value.UpdatedAt = now
	value.Revision++
	t.sessions[id] = value
	return value, nil
}
func (t *fakeSessionTransaction) DeleteGenerationJob(_ context.Context, id domain.ID) error {
	t.deletedJobs[id] = true
	return nil
}
func (t *fakeSessionTransaction) DeleteGuideMaterials(context.Context, domain.ID) error { return nil }
func (t *fakeSessionTransaction) DeleteGuideMaterialBatch(_ context.Context, id domain.ID) error {
	t.deletedBatches[id] = true
	return nil
}
func (t *fakeSessionTransaction) DeleteGuideDraft(_ context.Context, id domain.ID) error {
	t.deletedDrafts[id] = true
	return nil
}
func idemMapKey(scope domain.IdempotencyScope) string {
	return string(scope.ActorID) + "|" + scope.Method + "|" + scope.Path + "|" + string(scope.Key)
}
func (t *fakeSessionTransaction) BeginIdempotency(_ context.Context, scope domain.IdempotencyScope, hash domain.RequestHash, now time.Time) (bool, error) {
	key := idemMapKey(scope)
	if _, ok := t.idempotency[key]; ok {
		return false, nil
	}
	record, err := NewInProgressIdempotencyRecord(scope, hash, nil, now)
	if err != nil {
		return false, err
	}
	t.idempotency[key] = record
	return true, nil
}
func (t *fakeSessionTransaction) LockIdempotency(_ context.Context, scope domain.IdempotencyScope) (domain.IdempotencyRecord, bool, error) {
	value, ok := t.idempotency[idemMapKey(scope)]
	return value, ok, nil
}
func (t *fakeSessionTransaction) TakeOverIdempotency(_ context.Context, scope domain.IdempotencyScope, now time.Time) (domain.IdempotencyRecord, bool, error) {
	key := idemMapKey(scope)
	value, ok := t.idempotency[key]
	if !ok || value.LeaseExpiresAt == nil || value.LeaseExpiresAt.After(now) {
		return domain.IdempotencyRecord{}, false, nil
	}
	lease := now.Add(domain.IdempotencyLease)
	value.LeaseExpiresAt = &lease
	t.idempotency[key] = value
	return value, true, nil
}
func (t *fakeSessionTransaction) CompleteIdempotency(_ context.Context, scope domain.IdempotencyScope, status int, body json.RawMessage, now time.Time) error {
	if t.failComplete {
		return errors.New("complete failed")
	}
	key := idemMapKey(scope)
	value, ok := t.idempotency[key]
	if !ok {
		return errors.New("missing idempotency")
	}
	completed, err := CompleteIdempotencyRecord(value, status, body, now)
	if err != nil {
		return err
	}
	t.idempotency[key] = completed
	return nil
}

func (t *fakeSessionTransaction) EndSavedGuide(_ context.Context, id domain.ID, now time.Time) (domain.SupportSession, error) {
	value := t.sessions[id]
	value.Status = domain.SupportSessionEnded
	reason := domain.EndReasonGuideSaved
	value.EndReason = &reason
	value.EndedAt = &now
	value.UpdatedAt = now
	value.Revision++
	t.sessions[id] = value
	return value, nil
}
