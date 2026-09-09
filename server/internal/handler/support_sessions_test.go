package handler

import (
	"context"
	"testing"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/generated"
	"github.com/kakuraccho/mite/server/internal/service"
)

func TestGeneratedSupportSessionContainsAllSnapshotFields(t *testing.T) {
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	decision := domain.GuideDecisionCreate
	consent := domain.Consent{Audio: true, ScreenShare: true, PeriodicCapture: true, TextVersion: "v3"}
	value := domain.SupportSession{ID: "session_1", SupportRequestID: "request_1", UserID: "user_1", FamilyID: "family_1", LiveKitRoomName: "mite-session_1", Status: domain.SupportSessionGeneratingGuide, GuideDecision: &decision, Consent: &consent, ConsentedAt: &now, StartedAt: &now, CreatedAt: now, UpdatedAt: now, Revision: 3}
	converted := generatedSupportSession(value)
	if converted.Id != "session_1" || converted.SupportRequestId != "request_1" || converted.GuideDecision == nil || *converted.GuideDecision != generated.CREATE || converted.Consent == nil || converted.Consent.TextVersion != "v3" || converted.Revision != 3 {
		t.Fatalf("converted=%+v", converted)
	}
}

func TestConflictResponseUsesOriginalRequestIDOnIdempotencyReplay(t *testing.T) {
	ctx := context.WithValue(context.Background(), requestIDContextKey, "request-replay")
	err := &service.SupportSessionOperationError{Err: domain.NewError(domain.CodeRevisionConflict, "revisionが更新されている"), RequestID: "request-original"}
	response, ok := callError(ctx, err).(generated.CallSupportRequest409JSONResponse)
	if !ok {
		t.Fatalf("response type=%T", callError(ctx, err))
	}
	if response.Body.Error.RequestId != "request-original" || response.Body.Error.Code != generated.REVISIONCONFLICT {
		t.Fatalf("response=%+v", response)
	}
}

func TestConflictResponseSetsRetryAfter(t *testing.T) {
	ctx := context.WithValue(context.Background(), requestIDContextKey, "request-1")
	response, ok := acceptError(ctx, domain.NewError(domain.CodeIdempotencyRequestInProgress, "processing")).(generated.AcceptSupportSession409JSONResponse)
	if !ok || response.Headers.RetryAfter == nil || *response.Headers.RetryAfter != 1 {
		t.Fatalf("response=%+v", response)
	}
}

func TestLiveKitExternalFailureMapsTo503(t *testing.T) {
	ctx := context.WithValue(context.Background(), requestIDContextKey, "request-1")
	response := liveKitError(ctx, domain.NewError(domain.CodeExternalServiceUnavailable, "unavailable"))
	if _, ok := response.(generated.CreateLiveKitToken503JSONResponse); !ok {
		t.Fatalf("response type=%T", response)
	}
}

func TestSupportSessionHandlerRequiresAuthenticatedActor(t *testing.T) {
	handler := NewSupportSessionHandler(nil)
	response, err := handler.GetSupportSession(context.Background(), generated.GetSupportSessionRequestObject{Id: "session_1"})
	if err != nil {
		t.Fatal(err)
	}
	unauthorized, ok := response.(generated.GetSupportSession401JSONResponse)
	if !ok {
		t.Fatalf("response type=%T", response)
	}
	if unauthorized.Error.Code != generated.UNAUTHENTICATED {
		t.Fatalf("code=%s", unauthorized.Error.Code)
	}
}
