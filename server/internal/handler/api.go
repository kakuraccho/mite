package handler

import (
	"context"

	"github.com/kakuraccho/mite/server/internal/generated"
)

// ArtifactSupportAPI is the HTTP boundary for the Artifact, Storage, and
// SupportRequest implementation lane.
type ArtifactSupportAPI interface {
	CreateArtifact(context.Context, generated.CreateArtifactRequestObject) (generated.CreateArtifactResponseObject, error)
	GetArtifactContent(context.Context, generated.GetArtifactContentRequestObject) (generated.GetArtifactContentResponseObject, error)
	ListSupportRequests(context.Context, generated.ListSupportRequestsRequestObject) (generated.ListSupportRequestsResponseObject, error)
	CreateSupportRequest(context.Context, generated.CreateSupportRequestRequestObject) (generated.CreateSupportRequestResponseObject, error)
	GetSupportRequest(context.Context, generated.GetSupportRequestRequestObject) (generated.GetSupportRequestResponseObject, error)
}

// SupportSessionAPI is the HTTP boundary for the SupportSession, WebSocket,
// and LiveKit implementation lane.
type SupportSessionAPI interface {
	CallSupportRequest(context.Context, generated.CallSupportRequestRequestObject) (generated.CallSupportRequestResponseObject, error)
	GetSupportSession(context.Context, generated.GetSupportSessionRequestObject) (generated.GetSupportSessionResponseObject, error)
	AcceptSupportSession(context.Context, generated.AcceptSupportSessionRequestObject) (generated.AcceptSupportSessionResponseObject, error)
	EndSupportSessionWithoutGuide(context.Context, generated.EndSupportSessionWithoutGuideRequestObject) (generated.EndSupportSessionWithoutGuideResponseObject, error)
	CreateLiveKitToken(context.Context, generated.CreateLiveKitTokenRequestObject) (generated.CreateLiveKitTokenResponseObject, error)
	ResolveSupportSession(context.Context, generated.ResolveSupportSessionRequestObject) (generated.ResolveSupportSessionResponseObject, error)
}

// GuideAPI is the HTTP boundary for material upload, generation, drafts,
// guides, and guide runs.
type GuideAPI interface {
	ListSessionGuideDrafts(context.Context, generated.ListSessionGuideDraftsRequestObject) (generated.ListSessionGuideDraftsResponseObject, error)
	CompleteGuideReview(context.Context, generated.CompleteGuideReviewRequestObject) (generated.CompleteGuideReviewResponseObject, error)
	GetGuideDraft(context.Context, generated.GetGuideDraftRequestObject) (generated.GetGuideDraftResponseObject, error)
	UpdateGuideDraft(context.Context, generated.UpdateGuideDraftRequestObject) (generated.UpdateGuideDraftResponseObject, error)
	SaveGuideDraft(context.Context, generated.SaveGuideDraftRequestObject) (generated.SaveGuideDraftResponseObject, error)
	GetGuideGenerationJob(context.Context, generated.GetGuideGenerationJobRequestObject) (generated.GetGuideGenerationJobResponseObject, error)
	RetryGuideGenerationJob(context.Context, generated.RetryGuideGenerationJobRequestObject) (generated.RetryGuideGenerationJobResponseObject, error)
	CreateGuideMaterialBatch(context.Context, generated.CreateGuideMaterialBatchRequestObject) (generated.CreateGuideMaterialBatchResponseObject, error)
	GetGuideMaterialBatch(context.Context, generated.GetGuideMaterialBatchRequestObject) (generated.GetGuideMaterialBatchResponseObject, error)
	CompleteGuideMaterialBatch(context.Context, generated.CompleteGuideMaterialBatchRequestObject) (generated.CompleteGuideMaterialBatchResponseObject, error)
	CreateGuideMaterial(context.Context, generated.CreateGuideMaterialRequestObject) (generated.CreateGuideMaterialResponseObject, error)
	CreateGuideRun(context.Context, generated.CreateGuideRunRequestObject) (generated.CreateGuideRunResponseObject, error)
	GetGuideRun(context.Context, generated.GetGuideRunRequestObject) (generated.GetGuideRunResponseObject, error)
	UpdateGuideRun(context.Context, generated.UpdateGuideRunRequestObject) (generated.UpdateGuideRunResponseObject, error)
	CompleteGuideRun(context.Context, generated.CompleteGuideRunRequestObject) (generated.CompleteGuideRunResponseObject, error)
	CreateSupportRequestFromGuideRun(context.Context, generated.CreateSupportRequestFromGuideRunRequestObject) (generated.CreateSupportRequestFromGuideRunResponseObject, error)
	ListGuides(context.Context, generated.ListGuidesRequestObject) (generated.ListGuidesResponseObject, error)
	GetGuide(context.Context, generated.GetGuideRequestObject) (generated.GetGuideResponseObject, error)
}

// API combines independently implemented feature lanes into the generated
// strict server contract.
type API struct {
	ArtifactSupportAPI
	SupportSessionAPI
	GuideAPI
}

var _ generated.StrictServerInterface = API{}
