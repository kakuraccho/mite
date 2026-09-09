package service

import (
	"bytes"
	"context"
	"testing"

	"github.com/kakuraccho/mite/server/internal/domain"
)

func savedSessionStore() *fakeSessionStore {
	store := activeStore()
	session := store.sessions["session_1"]
	guide, draft, decision := domain.ID("guide_1"), domain.ID("draft_1"), domain.GuideDecisionCreate
	session.Status, session.Revision = domain.SupportSessionGuideSaved, 7
	session.GuideID, session.GuideDraftID, session.GuideDecision = &guide, &draft, &decision
	store.sessions[session.ID] = session
	request := store.requests[session.SupportRequestID]
	request.Status, request.Revision = domain.SupportRequestResolved, 4
	store.requests[request.ID] = request
	return store
}

func TestEndSavedCallPreservesGuideAndReplays(t *testing.T) {
	store := savedSessionStore()
	publisher := &supportSessionFakeEventPublisher{}
	svc := newTestSessionService(store, publisher, &fakeTokenIssuer{})
	actor := domain.Actor{ID: "family_1", Role: domain.RoleFamily}
	before := store.sessions["session_1"]
	ended, err := svc.End(context.Background(), actor, "session_1", 7, "end", "request-first")
	if err != nil {
		t.Fatal(err)
	}
	if ended.Status != domain.SupportSessionEnded || ended.Revision != 8 || ended.EndedAt == nil || ended.EndReason == nil || *ended.EndReason != domain.EndReasonGuideSaved {
		t.Fatalf("ended=%+v", ended)
	}
	if !ended.StartedAt.Equal(*before.StartedAt) || *ended.GuideID != *before.GuideID || *ended.GuideDraftID != *before.GuideDraftID || store.requests["request_1"].Revision != 4 {
		t.Fatal("ending a call changed the guide, start time, or request")
	}
	if len(store.queuedArtifacts) != 0 || len(store.deletedDrafts) != 0 || len(publisher.events) != 1 {
		t.Fatal("ending a saved call must only publish a session update")
	}
	replayed, err := svc.End(context.Background(), actor, "session_1", 7, "end", "request-retry")
	if err != nil {
		t.Fatal(err)
	}
	firstBody, _ := marshalSessionResponse(ended)
	replayBody, _ := marshalSessionResponse(replayed)
	if !bytes.Equal(firstBody, replayBody) || len(publisher.events) != 1 || store.sessions["session_1"].Revision != 8 {
		t.Fatal("retry changed the response, revision, or events")
	}
	if _, err := svc.End(context.Background(), actor, "session_1", 8, "end", "changed"); testErrorCode(err) != domain.CodeIdempotencyKeyReused {
		t.Fatalf("changed payload: %v", err)
	}
	if _, err := svc.End(context.Background(), actor, "session_1", 8, "other", "ended"); testErrorCode(err) != domain.CodeInvalidState {
		t.Fatalf("second end: %v", err)
	}
}

func TestEndSavedCallAuthorizationRevisionAndRollback(t *testing.T) {
	for _, tt := range []struct {
		name       string
		actor      domain.Actor
		revision   int64
		failCommit bool
		want       domain.ErrorCode
	}{
		{"user", domain.Actor{ID: "user_1", Role: domain.RoleUser}, 7, false, domain.CodeForbidden},
		{"other pair", domain.Actor{ID: "family_other", Role: domain.RoleFamily}, 7, false, domain.CodeForbidden},
		{"stale revision", domain.Actor{ID: "family_1", Role: domain.RoleFamily}, 6, false, domain.CodeRevisionConflict},
		{"commit failed", domain.Actor{ID: "family_1", Role: domain.RoleFamily}, 7, true, ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			store := savedSessionStore()
			store.failComplete = tt.failCommit
			publisher := &supportSessionFakeEventPublisher{}
			svc := newTestSessionService(store, publisher, &fakeTokenIssuer{})
			_, err := svc.End(context.Background(), tt.actor, "session_1", tt.revision, "end", "request")
			if err == nil || testErrorCode(err) != tt.want {
				t.Fatalf("error=%v", err)
			}
			if store.sessions["session_1"].Status != domain.SupportSessionGuideSaved || len(publisher.events) != 0 {
				t.Fatal("failed end changed state")
			}
			if tt.failCommit {
				store.failComplete = false
				if _, err := svc.End(context.Background(), tt.actor, "session_1", 7, "end", "retry"); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestLiveKitReconnectThroughoutGuideCreation(t *testing.T) {
	for _, state := range []domain.SupportSessionStatus{domain.SupportSessionRinging, domain.SupportSessionActive, domain.SupportSessionGeneratingGuide, domain.SupportSessionReviewingGuide, domain.SupportSessionGuideSaved, domain.SupportSessionEnded} {
		for _, actor := range []domain.Actor{{ID: "user_1", Role: domain.RoleUser}, {ID: "family_1", Role: domain.RoleFamily}, {ID: "family_other", Role: domain.RoleFamily}} {
			t.Run(string(state)+"/"+string(actor.ID), func(t *testing.T) {
				store := savedSessionStore()
				session := store.sessions["session_1"]
				session.Status = state
				store.sessions[session.ID] = session
				issuer := &fakeTokenIssuer{}
				svc := newTestSessionService(store, &supportSessionFakeEventPublisher{}, issuer)
				_, err := svc.CreateLiveKitToken(context.Background(), actor, "session_1")
				wantAllowed := actor.ID != "family_other" && state != domain.SupportSessionRinging && state != domain.SupportSessionEnded
				if (err == nil) != wantAllowed {
					t.Fatalf("error=%v allowed=%v", err, wantAllowed)
				}
				if !wantAllowed && issuer.request.RoomName != "" {
					t.Fatal("unauthorized token issued")
				}
				if store.sessions[session.ID].Revision != session.Revision {
					t.Fatal("token changed business state")
				}
			})
		}
	}
}
