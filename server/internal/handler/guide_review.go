package handler

import (
	"context"
	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/generated"
	"github.com/kakuraccho/mite/server/internal/service"
)

func (h *GuideHandler) ListSessionGuideDrafts(ctx context.Context, request generated.ListSessionGuideDraftsRequestObject) (generated.ListSessionGuideDraftsResponseObject, error) {
	actor, err := actorFromGuideContext(ctx)
	var value []domain.GuideDraft
	if err == nil {
		value, err = h.service.ListSessionGuideDrafts(ctx, actor, domain.ID(request.Id))
	}
	if err != nil {
		apiErr := makeGuideAPIError(ctx, err)
		switch apiErr.Status {
		case 401:
			return generated.ListSessionGuideDrafts401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(apiErr.Response)}, nil
		case 403:
			return generated.ListSessionGuideDrafts403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(apiErr.Response)}, nil
		case 404:
			return generated.ListSessionGuideDrafts404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(apiErr.Response)}, nil
		default:
			return generated.ListSessionGuideDrafts500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(apiErr.Response)}, nil
		}
	}
	var response generated.GuideDraftListResponse
	response.Data.Items = make([]generated.GuideDraft, 0, len(value))
	for _, draft := range value {
		response.Data.Items = append(response.Data.Items, guideDraftToAPI(draft))
	}
	return generated.ListSessionGuideDrafts200JSONResponse(response), nil
}

func (h *GuideHandler) CompleteGuideReview(ctx context.Context, request generated.CompleteGuideReviewRequestObject) (generated.CompleteGuideReviewResponseObject, error) {
	meta, err := commandMeta(ctx, request.Params.IdempotencyKey)
	if err == nil && request.Body == nil {
		err = domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")
	}
	var value service.GuideReviewCompleted
	if err == nil {
		drafts := make([]service.GuideDraftRevision, len(request.Body.Drafts))
		for index, draft := range request.Body.Drafts {
			drafts[index] = service.GuideDraftRevision{ID: domain.ID(draft.Id), ExpectedRevision: draft.ExpectedRevision}
		}
		value, err = h.service.CompleteGuideReview(ctx, service.CompleteGuideReviewCommand{Meta: meta, SupportSessionID: domain.ID(request.Id), ExpectedSessionRevision: request.Body.ExpectedSessionRevision, Drafts: drafts})
	}
	if err != nil {
		apiErr := makeGuideAPIError(ctx, err)
		switch apiErr.Status {
		case 400:
			return generated.CompleteGuideReview400JSONResponse{BadRequestJSONResponse: generated.BadRequestJSONResponse(apiErr.Response)}, nil
		case 401:
			return generated.CompleteGuideReview401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(apiErr.Response)}, nil
		case 403:
			return generated.CompleteGuideReview403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(apiErr.Response)}, nil
		case 404:
			return generated.CompleteGuideReview404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(apiErr.Response)}, nil
		case 409:
			return generated.CompleteGuideReview409JSONResponse{ConflictJSONResponse: generated.ConflictJSONResponse{Body: apiErr.Response, Headers: generated.ConflictResponseHeaders{RetryAfter: apiErr.RetryAfter}}}, nil
		default:
			return generated.CompleteGuideReview500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(apiErr.Response)}, nil
		}
	}
	var response generated.GuideReviewCompletedResponse
	response.Data.SupportSession = supportSessionToAPI(value.SupportSession)
	response.Data.Guides = make([]generated.GuideDetail, 0, len(value.Guides))
	for _, guide := range value.Guides {
		response.Data.Guides = append(response.Data.Guides, guideDetailToAPI(guide))
	}
	return generated.CompleteGuideReview201JSONResponse(response), nil
}
