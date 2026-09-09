package domain

type SupportRequestStatus string

const (
	SupportRequestPending   SupportRequestStatus = "PENDING"
	SupportRequestInSupport SupportRequestStatus = "IN_SUPPORT"
	SupportRequestResolved  SupportRequestStatus = "RESOLVED"
	SupportRequestCancelled SupportRequestStatus = "CANCELLED"
)

func (s SupportRequestStatus) Valid() bool {
	return s == SupportRequestPending || s == SupportRequestInSupport ||
		s == SupportRequestResolved || s == SupportRequestCancelled
}

func (s SupportRequestStatus) CanTransitionTo(next SupportRequestStatus) bool {
	return (s == SupportRequestPending && (next == SupportRequestInSupport || next == SupportRequestCancelled)) ||
		(s == SupportRequestInSupport && next == SupportRequestResolved)
}

type SupportAcknowledgementKind string

const (
	SupportAcknowledgementNow       SupportAcknowledgementKind = "NOW"
	SupportAcknowledgementScheduled SupportAcknowledgementKind = "SCHEDULED"
	SupportAcknowledgementUnknown   SupportAcknowledgementKind = "UNKNOWN"
)

func (k SupportAcknowledgementKind) Valid() bool {
	return k == SupportAcknowledgementNow || k == SupportAcknowledgementScheduled ||
		k == SupportAcknowledgementUnknown
}

type PresenceStatus string

const (
	PresenceConnecting PresenceStatus = "CONNECTING"
	PresenceOnline     PresenceStatus = "ONLINE"
	PresenceOffline    PresenceStatus = "OFFLINE"
)

func (s PresenceStatus) Valid() bool {
	return s == PresenceConnecting || s == PresenceOnline || s == PresenceOffline
}

type SupportSessionStatus string

const (
	SupportSessionRinging         SupportSessionStatus = "RINGING"
	SupportSessionActive          SupportSessionStatus = "ACTIVE"
	SupportSessionGeneratingGuide SupportSessionStatus = "GENERATING_GUIDE"
	SupportSessionReviewingGuide  SupportSessionStatus = "REVIEWING_GUIDE"
	SupportSessionGuideSaved      SupportSessionStatus = "GUIDE_SAVED"
	SupportSessionEnded           SupportSessionStatus = "ENDED"
)

func (s SupportSessionStatus) Valid() bool {
	switch s {
	case SupportSessionRinging,
		SupportSessionActive,
		SupportSessionGeneratingGuide,
		SupportSessionReviewingGuide,
		SupportSessionGuideSaved,
		SupportSessionEnded:
		return true
	default:
		return false
	}
}

func (s SupportSessionStatus) CanTransitionTo(next SupportSessionStatus) bool {
	switch s {
	case SupportSessionRinging:
		return next == SupportSessionActive
	case SupportSessionActive:
		return next == SupportSessionGeneratingGuide || next == SupportSessionEnded
	case SupportSessionGeneratingGuide:
		return next == SupportSessionReviewingGuide || next == SupportSessionEnded
	case SupportSessionReviewingGuide:
		return next == SupportSessionEnded
	case SupportSessionGuideSaved:
		return next == SupportSessionEnded
	default:
		return false
	}
}

type GuideGenerationJobStatus string

const (
	GuideGenerationJobQueued    GuideGenerationJobStatus = "QUEUED"
	GuideGenerationJobRunning   GuideGenerationJobStatus = "RUNNING"
	GuideGenerationJobSucceeded GuideGenerationJobStatus = "SUCCEEDED"
	GuideGenerationJobFailed    GuideGenerationJobStatus = "FAILED"
)

func (s GuideGenerationJobStatus) Valid() bool {
	return s == GuideGenerationJobQueued || s == GuideGenerationJobRunning ||
		s == GuideGenerationJobSucceeded || s == GuideGenerationJobFailed
}

func CanTransitionGuideGenerationJob(from, to GuideGenerationJobStatus, attempt int) bool {
	switch from {
	case GuideGenerationJobQueued:
		return to == GuideGenerationJobRunning && attempt >= 0 && attempt < 3
	case GuideGenerationJobRunning:
		return attempt >= 1 && attempt <= 3 &&
			(to == GuideGenerationJobSucceeded || to == GuideGenerationJobFailed)
	case GuideGenerationJobFailed:
		return to == GuideGenerationJobQueued && attempt >= 1 && attempt < 3
	default:
		return false
	}
}

func CanRecoverGuideGenerationJob(attempt int, next GuideGenerationJobStatus) bool {
	if attempt < 1 || attempt > 3 {
		return false
	}
	if attempt < 3 {
		return next == GuideGenerationJobQueued
	}
	return next == GuideGenerationJobFailed
}

type GuideDraftStatus string

const (
	GuideDraftEditing GuideDraftStatus = "EDITING"
	GuideDraftSaved   GuideDraftStatus = "SAVED"
)

func (s GuideDraftStatus) Valid() bool {
	return s == GuideDraftEditing || s == GuideDraftSaved
}

func (s GuideDraftStatus) CanTransitionTo(next GuideDraftStatus) bool {
	return s == GuideDraftEditing && next == GuideDraftSaved
}

type GuideRunStatus string

const (
	GuideRunInProgress       GuideRunStatus = "IN_PROGRESS"
	GuideRunCompleted        GuideRunStatus = "COMPLETED"
	GuideRunPausedForSupport GuideRunStatus = "PAUSED_FOR_SUPPORT"
)

func (s GuideRunStatus) Valid() bool {
	return s == GuideRunInProgress || s == GuideRunCompleted || s == GuideRunPausedForSupport
}

func (s GuideRunStatus) CanTransitionTo(next GuideRunStatus) bool {
	return s == GuideRunInProgress && (next == GuideRunCompleted || next == GuideRunPausedForSupport)
}

type GuideMaterialBatchStatus string

const (
	GuideMaterialBatchUploading GuideMaterialBatchStatus = "UPLOADING"
	GuideMaterialBatchCompleted GuideMaterialBatchStatus = "COMPLETED"
)

func (s GuideMaterialBatchStatus) Valid() bool {
	return s == GuideMaterialBatchUploading || s == GuideMaterialBatchCompleted
}

func (s GuideMaterialBatchStatus) CanTransitionTo(next GuideMaterialBatchStatus) bool {
	return s == GuideMaterialBatchUploading && next == GuideMaterialBatchCompleted
}

type ArtifactPurpose string

const (
	ArtifactPurposeRequestScreenshot ArtifactPurpose = "REQUEST_SCREENSHOT"
	ArtifactPurposeGuideMaterial     ArtifactPurpose = "GUIDE_MATERIAL"
	ArtifactPurposeGuideStep         ArtifactPurpose = "GUIDE_STEP"
)

func (p ArtifactPurpose) Valid() bool {
	return p == ArtifactPurposeRequestScreenshot || p == ArtifactPurposeGuideMaterial || p == ArtifactPurposeGuideStep
}

func (p ArtifactPurpose) CanTransitionTo(next ArtifactPurpose) bool {
	return p == ArtifactPurposeGuideMaterial && next == ArtifactPurposeGuideStep
}

type GuideDecision string

const (
	GuideDecisionCreate GuideDecision = "CREATE"
	GuideDecisionSkip   GuideDecision = "SKIP"
)

func (d GuideDecision) Valid() bool {
	return d == GuideDecisionCreate || d == GuideDecisionSkip
}

type SupportSessionEndReason string

const (
	EndReasonGuideSkipped   SupportSessionEndReason = "GUIDE_SKIPPED"
	EndReasonGuideSaved     SupportSessionEndReason = "GUIDE_SAVED"
	EndReasonGuideCancelled SupportSessionEndReason = "GUIDE_CANCELLED"
	EndReasonNoMaterials    SupportSessionEndReason = "NO_MATERIALS"
)

func (r SupportSessionEndReason) Valid() bool {
	return r == EndReasonGuideSkipped || r == EndReasonGuideSaved ||
		r == EndReasonGuideCancelled || r == EndReasonNoMaterials
}

func CanEndSupportSession(status SupportSessionStatus, reason SupportSessionEndReason) bool {
	switch status {
	case SupportSessionActive:
		return reason == EndReasonGuideSkipped
	case SupportSessionGeneratingGuide:
		return reason == EndReasonGuideCancelled || reason == EndReasonNoMaterials
	case SupportSessionReviewingGuide:
		return reason == EndReasonGuideSaved || reason == EndReasonGuideCancelled
	case SupportSessionGuideSaved:
		return reason == EndReasonGuideSaved
	default:
		return false
	}
}

type GuideRunAction string

const (
	GuideRunNext     GuideRunAction = "NEXT"
	GuideRunPrevious GuideRunAction = "PREVIOUS"
)

func (a GuideRunAction) Valid() bool {
	return a == GuideRunNext || a == GuideRunPrevious
}
