package handler

import (
	"context"
	"errors"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/generated"
	"github.com/kakuraccho/mite/server/internal/service"
)

type SupportSessionHandler struct {
	service *service.SupportSessionService
}

func NewSupportSessionHandler(sessionService *service.SupportSessionService) *SupportSessionHandler {
	return &SupportSessionHandler{service: sessionService}
}

var _ SupportSessionAPI = (*SupportSessionHandler)(nil)

func (h *SupportSessionHandler) CallSupportRequest(ctx context.Context, request generated.CallSupportRequestRequestObject) (generated.CallSupportRequestResponseObject, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return callError(ctx, domain.NewError(domain.CodeUnauthenticated, "認証が必要")), nil
	}
	if request.Body == nil {
		return callError(ctx, domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")), nil
	}
	result, err := h.service.Call(ctx, actor, request.Id, request.Body.ExpectedRequestRevision, request.Params.IdempotencyKey, RequestIDFromContext(ctx))
	if err != nil {
		return callError(ctx, err), nil
	}
	response := generated.CallSupportRequestResponse{}
	response.Data.SupportRequest = generatedSupportRequest(result.SupportRequest)
	response.Data.SupportSession = generatedSupportSession(result.SupportSession)
	return generated.CallSupportRequest201JSONResponse(response), nil
}

func (h *SupportSessionHandler) GetSupportSession(ctx context.Context, request generated.GetSupportSessionRequestObject) (generated.GetSupportSessionResponseObject, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return getSessionError(ctx, domain.NewError(domain.CodeUnauthenticated, "認証が必要")), nil
	}
	result, err := h.service.Get(ctx, actor, request.Id)
	if err != nil {
		return getSessionError(ctx, err), nil
	}
	return generated.GetSupportSession200JSONResponse(generated.SupportSessionResponse{Data: generatedSupportSession(result)}), nil
}

func (h *SupportSessionHandler) AcceptSupportSession(ctx context.Context, request generated.AcceptSupportSessionRequestObject) (generated.AcceptSupportSessionResponseObject, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return acceptError(ctx, domain.NewError(domain.CodeUnauthenticated, "認証が必要")), nil
	}
	if request.Body == nil {
		return acceptError(ctx, domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")), nil
	}
	consent := domain.Consent{Audio: request.Body.Consent.Audio, ScreenShare: request.Body.Consent.ScreenShare, PeriodicCapture: request.Body.Consent.PeriodicCapture, TextVersion: string(request.Body.Consent.TextVersion)}
	result, err := h.service.Accept(ctx, actor, request.Id, request.Body.ExpectedSessionRevision, consent, request.Params.IdempotencyKey, RequestIDFromContext(ctx))
	if err != nil {
		return acceptError(ctx, err), nil
	}
	response := generated.SupportRequestAndSessionResponse{}
	response.Data.SupportRequest = generatedSupportRequest(result.SupportRequest)
	response.Data.SupportSession = generatedSupportSession(result.SupportSession)
	return generated.AcceptSupportSession200JSONResponse(response), nil
}

func (h *SupportSessionHandler) CreateLiveKitToken(ctx context.Context, request generated.CreateLiveKitTokenRequestObject) (generated.CreateLiveKitTokenResponseObject, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return liveKitError(ctx, domain.NewError(domain.CodeUnauthenticated, "認証が必要")), nil
	}
	if request.Body == nil || len(*request.Body) != 0 {
		return liveKitError(ctx, domain.NewError(domain.CodeValidationError, "本文は空オブジェクトで指定する")), nil
	}
	result, err := h.service.CreateLiveKitToken(ctx, actor, request.Id)
	if err != nil {
		return liveKitError(ctx, err), nil
	}
	response := generated.LiveKitTokenResponse{}
	response.Data.ServerUrl = result.ServerURL
	response.Data.RoomName = result.RoomName
	response.Data.ParticipantIdentity = result.ParticipantIdentity
	response.Data.Token = result.Token
	response.Data.ExpiresAt = result.ExpiresAt
	return generated.CreateLiveKitToken200JSONResponse(response), nil
}

func (h *SupportSessionHandler) ResolveSupportSession(ctx context.Context, request generated.ResolveSupportSessionRequestObject) (generated.ResolveSupportSessionResponseObject, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return resolveError(ctx, domain.NewError(domain.CodeUnauthenticated, "認証が必要")), nil
	}
	if request.Body == nil {
		return resolveError(ctx, domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")), nil
	}
	result, err := h.service.Resolve(ctx, actor, request.Id, request.Body.ExpectedSessionRevision, domain.GuideDecision(request.Body.GuideDecision), request.Params.IdempotencyKey, RequestIDFromContext(ctx))
	if err != nil {
		return resolveError(ctx, err), nil
	}
	response := generated.SupportRequestAndSessionResponse{}
	response.Data.SupportRequest = generatedSupportRequest(result.SupportRequest)
	response.Data.SupportSession = generatedSupportSession(result.SupportSession)
	return generated.ResolveSupportSession200JSONResponse(response), nil
}

func (h *SupportSessionHandler) EndSupportSessionWithoutGuide(ctx context.Context, request generated.EndSupportSessionWithoutGuideRequestObject) (generated.EndSupportSessionWithoutGuideResponseObject, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return endSessionError(ctx, domain.NewError(domain.CodeUnauthenticated, "認証が必要")), nil
	}
	if request.Body == nil {
		return endSessionError(ctx, domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")), nil
	}
	result, err := h.service.EndWithoutGuide(ctx, actor, request.Id, request.Body.ExpectedSessionRevision, domain.SupportSessionEndReason(request.Body.Reason), request.Params.IdempotencyKey, RequestIDFromContext(ctx))
	if err != nil {
		return endSessionError(ctx, err), nil
	}
	return generated.EndSupportSessionWithoutGuide200JSONResponse(generated.SupportSessionResponse{Data: generatedSupportSession(result)}), nil
}

func generatedSupportRequest(value domain.SupportRequest) generated.SupportRequest {
	return supportRequestToGenerated(value)
}

func generatedSupportSession(value domain.SupportSession) generated.SupportSession {
	result := generated.SupportSession{ConsentedAt: value.ConsentedAt, CreatedAt: value.CreatedAt, EndReason: handlerEndReasonPointer(value.EndReason), EndedAt: value.EndedAt, FamilyId: string(value.FamilyID), GuideDecision: handlerDecisionPointer(value.GuideDecision), GuideDraftId: handlerIDPointer(value.GuideDraftID), GuideGenerationJobId: handlerIDPointer(value.GuideGenerationJobID), GuideId: handlerIDPointer(value.GuideID), GuideMaterialBatchId: handlerIDPointer(value.GuideMaterialBatchID), Id: string(value.ID), LivekitRoomName: value.LiveKitRoomName, Revision: value.Revision, StartedAt: value.StartedAt, Status: generated.SupportSessionStatus(value.Status), SupportRequestId: string(value.SupportRequestID), UpdatedAt: value.UpdatedAt, UserId: string(value.UserID)}
	if value.Consent != nil {
		result.Consent = &generated.Consent{Audio: value.Consent.Audio, ScreenShare: value.Consent.ScreenShare, PeriodicCapture: value.Consent.PeriodicCapture, TextVersion: generated.ConsentTextVersion(value.Consent.TextVersion)}
	}
	return result
}

func generatedErrorResponse(ctx context.Context, err error) generated.ErrorResponse {
	public := publicError(err)
	requestID := RequestIDFromContext(ctx)
	var operationError *service.SupportSessionOperationError
	if errors.As(err, &operationError) && operationError.RequestID != "" {
		requestID = operationError.RequestID
	}
	return generated.ErrorResponse{Error: generated.Error{Code: generated.ErrorCode(public.Code), Message: public.Message, RequestId: requestID}}
}

func conflictResponse(ctx context.Context, err error) generated.ConflictJSONResponse {
	response := generated.ConflictJSONResponse{Body: generatedErrorResponse(ctx, err)}
	if code, _ := domain.ErrorCodeOf(err); code == domain.CodeIdempotencyRequestInProgress {
		retry := 1
		response.Headers.RetryAfter = &retry
	}
	return response
}

func callError(ctx context.Context, err error) generated.CallSupportRequestResponseObject {
	response := generatedErrorResponse(ctx, err)
	switch statusForCode(responseCode(err)) {
	case 400:
		return generated.CallSupportRequest400JSONResponse{BadRequestJSONResponse: generated.BadRequestJSONResponse(response)}
	case 401:
		return generated.CallSupportRequest401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(response)}
	case 403:
		return generated.CallSupportRequest403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(response)}
	case 404:
		return generated.CallSupportRequest404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(response)}
	case 409:
		return generated.CallSupportRequest409JSONResponse{ConflictJSONResponse: conflictResponse(ctx, err)}
	default:
		return generated.CallSupportRequest500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(response)}
	}
}
func getSessionError(ctx context.Context, err error) generated.GetSupportSessionResponseObject {
	response := generatedErrorResponse(ctx, err)
	switch statusForCode(responseCode(err)) {
	case 401:
		return generated.GetSupportSession401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(response)}
	case 403:
		return generated.GetSupportSession403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(response)}
	case 404:
		return generated.GetSupportSession404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(response)}
	default:
		return generated.GetSupportSession500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(response)}
	}
}
func acceptError(ctx context.Context, err error) generated.AcceptSupportSessionResponseObject {
	response := generatedErrorResponse(ctx, err)
	switch statusForCode(responseCode(err)) {
	case 400:
		return generated.AcceptSupportSession400JSONResponse{BadRequestJSONResponse: generated.BadRequestJSONResponse(response)}
	case 401:
		return generated.AcceptSupportSession401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(response)}
	case 403:
		return generated.AcceptSupportSession403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(response)}
	case 404:
		return generated.AcceptSupportSession404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(response)}
	case 409:
		return generated.AcceptSupportSession409JSONResponse{ConflictJSONResponse: conflictResponse(ctx, err)}
	default:
		return generated.AcceptSupportSession500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(response)}
	}
}
func resolveError(ctx context.Context, err error) generated.ResolveSupportSessionResponseObject {
	response := generatedErrorResponse(ctx, err)
	switch statusForCode(responseCode(err)) {
	case 400:
		return generated.ResolveSupportSession400JSONResponse{BadRequestJSONResponse: generated.BadRequestJSONResponse(response)}
	case 401:
		return generated.ResolveSupportSession401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(response)}
	case 403:
		return generated.ResolveSupportSession403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(response)}
	case 404:
		return generated.ResolveSupportSession404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(response)}
	case 409:
		return generated.ResolveSupportSession409JSONResponse{ConflictJSONResponse: conflictResponse(ctx, err)}
	default:
		return generated.ResolveSupportSession500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(response)}
	}
}
func endSessionError(ctx context.Context, err error) generated.EndSupportSessionWithoutGuideResponseObject {
	response := generatedErrorResponse(ctx, err)
	switch statusForCode(responseCode(err)) {
	case 400:
		return generated.EndSupportSessionWithoutGuide400JSONResponse{BadRequestJSONResponse: generated.BadRequestJSONResponse(response)}
	case 401:
		return generated.EndSupportSessionWithoutGuide401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(response)}
	case 403:
		return generated.EndSupportSessionWithoutGuide403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(response)}
	case 404:
		return generated.EndSupportSessionWithoutGuide404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(response)}
	case 409:
		return generated.EndSupportSessionWithoutGuide409JSONResponse{ConflictJSONResponse: conflictResponse(ctx, err)}
	default:
		return generated.EndSupportSessionWithoutGuide500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(response)}
	}
}
func liveKitError(ctx context.Context, err error) generated.CreateLiveKitTokenResponseObject {
	response := generatedErrorResponse(ctx, err)
	switch statusForCode(responseCode(err)) {
	case 400:
		return generated.CreateLiveKitToken400JSONResponse{BadRequestJSONResponse: generated.BadRequestJSONResponse(response)}
	case 401:
		return generated.CreateLiveKitToken401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(response)}
	case 403:
		return generated.CreateLiveKitToken403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(response)}
	case 404:
		return generated.CreateLiveKitToken404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(response)}
	case 409:
		return generated.CreateLiveKitToken409JSONResponse{ConflictJSONResponse: conflictResponse(ctx, err)}
	case 503:
		return generated.CreateLiveKitToken503JSONResponse{ServiceUnavailableJSONResponse: generated.ServiceUnavailableJSONResponse(response)}
	default:
		return generated.CreateLiveKitToken500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(response)}
	}
}

func responseCode(err error) domain.ErrorCode {
	code, ok := domain.ErrorCodeOf(err)
	if !ok {
		return domain.CodeInternalError
	}
	return code
}
func handlerIDPointer(value *domain.ID) *string {
	if value == nil {
		return nil
	}
	converted := string(*value)
	return &converted
}
func handlerDecisionPointer(value *domain.GuideDecision) *generated.GuideDecision {
	if value == nil {
		return nil
	}
	converted := generated.GuideDecision(*value)
	return &converted
}
func handlerEndReasonPointer(value *domain.SupportSessionEndReason) *generated.SupportSessionEndReason {
	if value == nil {
		return nil
	}
	converted := generated.SupportSessionEndReason(*value)
	return &converted
}

func (h *SupportSessionHandler) EndSupportSession(ctx context.Context, request generated.EndSupportSessionRequestObject) (generated.EndSupportSessionResponseObject, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return endSavedSessionError(ctx, domain.NewError(domain.CodeUnauthenticated, "認証が必要")), nil
	}
	if request.Body == nil {
		return endSavedSessionError(ctx, domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")), nil
	}
	result, err := h.service.End(ctx, actor, request.Id, request.Body.ExpectedSessionRevision, request.Params.IdempotencyKey, RequestIDFromContext(ctx))
	if err != nil {
		return endSavedSessionError(ctx, err), nil
	}
	return generated.EndSupportSession200JSONResponse(generated.SupportSessionResponse{Data: generatedSupportSession(result)}), nil
}

func endSavedSessionError(ctx context.Context, err error) generated.EndSupportSessionResponseObject {
	response := generatedErrorResponse(ctx, err)
	switch statusForCode(responseCode(err)) {
	case 400:
		return generated.EndSupportSession400JSONResponse{BadRequestJSONResponse: generated.BadRequestJSONResponse(response)}
	case 401:
		return generated.EndSupportSession401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(response)}
	case 403:
		return generated.EndSupportSession403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(response)}
	case 404:
		return generated.EndSupportSession404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(response)}
	case 409:
		return generated.EndSupportSession409JSONResponse{ConflictJSONResponse: conflictResponse(ctx, err)}
	default:
		return generated.EndSupportSession500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(response)}
	}
}
