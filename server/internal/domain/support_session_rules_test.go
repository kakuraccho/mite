package domain

import (
	"testing"
	"time"
)

func TestNewRingingSupportSession(t *testing.T) {
	now := time.Date(2026, 9, 4, 1, 2, 3, 0, time.UTC)
	request := SupportRequest{ID: "request_1", UserID: "user_1", FamilyID: "family_1", Status: SupportRequestPending}
	session, err := NewRingingSupportSession("session_1", request, now)
	if err != nil {
		t.Fatal(err)
	}
	if session.LiveKitRoomName != "mite-session_1" || session.Status != SupportSessionRinging || session.Revision != 1 {
		t.Fatalf("unexpected session: %+v", session)
	}
}

func TestValidateExpectedRevisionRunsBeforeState(t *testing.T) {
	err := ValidateExpectedRevision(2, 1)
	if code, _ := ErrorCodeOf(err); code != CodeRevisionConflict {
		t.Fatalf("code = %s", code)
	}
}

func TestValidateAcceptSupportSession(t *testing.T) {
	id := ID("session_1")
	request := SupportRequest{Status: SupportRequestPending, SupportSessionID: &id}
	session := SupportSession{ID: id, Status: SupportSessionRinging}
	accepted := Consent{Audio: true, ScreenShare: true, PeriodicCapture: true, TextVersion: "v1"}
	if err := ValidateAcceptSupportSession(session, request, accepted); err != nil {
		t.Fatal(err)
	}
	accepted.Audio = false
	if code, _ := ErrorCodeOf(ValidateAcceptSupportSession(session, request, accepted)); code != CodeValidationError {
		t.Fatalf("code = %s", code)
	}
}

func TestValidateResolveSupportSession(t *testing.T) {
	id := ID("session_1")
	request := SupportRequest{Status: SupportRequestInSupport, SupportSessionID: &id}
	session := SupportSession{ID: id, Status: SupportSessionActive}
	if err := ValidateResolveSupportSession(session, request, GuideDecisionCreate); err != nil {
		t.Fatal(err)
	}
	session.Status = SupportSessionEnded
	if code, _ := ErrorCodeOf(ValidateResolveSupportSession(session, request, GuideDecisionCreate)); code != CodeInvalidState {
		t.Fatalf("code = %s", code)
	}
}

func TestValidateEndWithoutGuide(t *testing.T) {
	failed := GuideGenerationJobFailed
	tests := []struct {
		name    string
		session SupportSession
		actor   Actor
		reason  SupportSessionEndReason
		job     *GuideGenerationJobStatus
		want    ErrorCode
	}{
		{"user no materials", SupportSession{Status: SupportSessionGeneratingGuide}, Actor{Role: RoleUser}, EndReasonNoMaterials, nil, ""},
		{"family failed job", SupportSession{Status: SupportSessionGeneratingGuide, GuideGenerationJobID: idPtr("job_1")}, Actor{Role: RoleFamily}, EndReasonGuideCancelled, &failed, ""},
		{"family running job", SupportSession{Status: SupportSessionGeneratingGuide, GuideGenerationJobID: idPtr("job_1")}, Actor{Role: RoleFamily}, EndReasonGuideCancelled, statusPtr(GuideGenerationJobRunning), CodeInvalidState},
		{"wrong reason", SupportSession{Status: SupportSessionReviewingGuide}, Actor{Role: RoleUser}, EndReasonGuideCancelled, nil, CodeForbidden},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateEndWithoutGuide(tt.session, tt.actor, tt.reason, tt.job)
			code, _ := ErrorCodeOf(err)
			if code != tt.want {
				t.Fatalf("code = %s want %s (err=%v)", code, tt.want, err)
			}
		})
	}
}

func idPtr(value ID) *ID                                                 { return &value }
func statusPtr(value GuideGenerationJobStatus) *GuideGenerationJobStatus { return &value }
