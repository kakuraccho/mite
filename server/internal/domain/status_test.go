package domain

import "testing"

func TestSupportRequestTransitions(t *testing.T) {
	t.Parallel()
	tests := []struct {
		from SupportRequestStatus
		to   SupportRequestStatus
		want bool
	}{
		{SupportRequestPending, SupportRequestInSupport, true},
		{SupportRequestInSupport, SupportRequestResolved, true},
		{SupportRequestPending, SupportRequestResolved, false},
		{SupportRequestResolved, SupportRequestPending, false},
		{SupportRequestPending, SupportRequestPending, false},
	}
	for _, test := range tests {
		if got := test.from.CanTransitionTo(test.to); got != test.want {
			t.Errorf("%s.CanTransitionTo(%s) = %v, want %v", test.from, test.to, got, test.want)
		}
	}
}

func TestSupportSessionTransitions(t *testing.T) {
	t.Parallel()
	allowed := map[[2]SupportSessionStatus]bool{
		{SupportSessionRinging, SupportSessionActive}:                 true,
		{SupportSessionActive, SupportSessionGeneratingGuide}:         true,
		{SupportSessionActive, SupportSessionEnded}:                   true,
		{SupportSessionGeneratingGuide, SupportSessionReviewingGuide}: true,
		{SupportSessionGeneratingGuide, SupportSessionEnded}:          true,
		{SupportSessionReviewingGuide, SupportSessionEnded}:           true,
		{SupportSessionGuideSaved, SupportSessionEnded}:               true,
	}
	statuses := []SupportSessionStatus{
		SupportSessionRinging,
		SupportSessionActive,
		SupportSessionGeneratingGuide,
		SupportSessionReviewingGuide,
		SupportSessionGuideSaved,
		SupportSessionEnded,
	}
	for _, from := range statuses {
		for _, to := range statuses {
			want := allowed[[2]SupportSessionStatus{from, to}]
			if got := from.CanTransitionTo(to); got != want {
				t.Errorf("%s.CanTransitionTo(%s) = %v, want %v", from, to, got, want)
			}
		}
	}
}

func TestGuideGenerationTransitions(t *testing.T) {
	t.Parallel()
	tests := []struct {
		from    GuideGenerationJobStatus
		to      GuideGenerationJobStatus
		attempt int
		want    bool
	}{
		{GuideGenerationJobQueued, GuideGenerationJobRunning, 0, true},
		{GuideGenerationJobRunning, GuideGenerationJobSucceeded, 1, true},
		{GuideGenerationJobRunning, GuideGenerationJobFailed, 1, true},
		{GuideGenerationJobFailed, GuideGenerationJobQueued, 1, true},
		{GuideGenerationJobFailed, GuideGenerationJobQueued, 3, false},
		{GuideGenerationJobQueued, GuideGenerationJobRunning, -1, false},
		{GuideGenerationJobRunning, GuideGenerationJobSucceeded, 0, false},
		{GuideGenerationJobRunning, GuideGenerationJobFailed, 4, false},
		{GuideGenerationJobFailed, GuideGenerationJobQueued, 0, false},
		{GuideGenerationJobSucceeded, GuideGenerationJobQueued, 1, false},
	}
	for _, test := range tests {
		if got := CanTransitionGuideGenerationJob(test.from, test.to, test.attempt); got != test.want {
			t.Errorf("CanTransitionGuideGenerationJob(%s, %s, %d) = %v, want %v", test.from, test.to, test.attempt, got, test.want)
		}
	}
}

func TestGuideGenerationRecovery(t *testing.T) {
	t.Parallel()
	if !CanRecoverGuideGenerationJob(2, GuideGenerationJobQueued) {
		t.Fatal("attempt 2 RUNNING job must recover to QUEUED")
	}
	if !CanRecoverGuideGenerationJob(3, GuideGenerationJobFailed) {
		t.Fatal("attempt 3 RUNNING job must recover to FAILED")
	}
	if CanRecoverGuideGenerationJob(3, GuideGenerationJobQueued) {
		t.Fatal("attempt 3 RUNNING job must not recover to QUEUED")
	}
}

func TestSupportSessionEndReasons(t *testing.T) {
	t.Parallel()
	tests := []struct {
		status SupportSessionStatus
		reason SupportSessionEndReason
		want   bool
	}{
		{SupportSessionActive, EndReasonGuideSkipped, true},
		{SupportSessionGeneratingGuide, EndReasonNoMaterials, true},
		{SupportSessionGeneratingGuide, EndReasonGuideCancelled, true},
		{SupportSessionReviewingGuide, EndReasonGuideSaved, true},
		{SupportSessionGuideSaved, EndReasonGuideSaved, true},
		{SupportSessionReviewingGuide, EndReasonGuideCancelled, true},
		{SupportSessionActive, EndReasonGuideSaved, false},
		{SupportSessionRinging, EndReasonGuideCancelled, false},
	}
	for _, test := range tests {
		if got := CanEndSupportSession(test.status, test.reason); got != test.want {
			t.Errorf("CanEndSupportSession(%s, %s) = %v, want %v", test.status, test.reason, got, test.want)
		}
	}
}

func TestTerminalGuideStates(t *testing.T) {
	t.Parallel()
	if GuideDraftSaved.CanTransitionTo(GuideDraftEditing) {
		t.Fatal("saved draft must be terminal")
	}
	if GuideRunCompleted.CanTransitionTo(GuideRunInProgress) {
		t.Fatal("completed guide run must be terminal")
	}
	if GuideRunPausedForSupport.CanTransitionTo(GuideRunInProgress) {
		t.Fatal("paused guide run must be terminal")
	}
}
