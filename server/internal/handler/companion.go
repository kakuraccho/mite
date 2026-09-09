package handler

import (
	"context"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/generated"
	"github.com/kakuraccho/mite/server/internal/service"
)

type CompanionHandler struct {
	companion *service.CompanionService
	support   *service.ArtifactSupportService
}

func NewCompanionHandler(companion *service.CompanionService, support *service.ArtifactSupportService) *CompanionHandler {
	return &CompanionHandler{companion: companion, support: support}
}

func (h *CompanionHandler) RecordPresenceHeartbeat(ctx context.Context, request generated.RecordPresenceHeartbeatRequestObject) (generated.RecordPresenceHeartbeatResponseObject, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return newRawErrorResponse(ctx, domain.NewError(domain.CodeUnauthenticated, "認証が必要")), nil
	}
	presence, err := h.companion.RecordHeartbeat(ctx, actor)
	if err != nil {
		return newRawErrorResponse(ctx, err), nil
	}
	response := generated.RecordPresenceHeartbeat200JSONResponse{}
	response.Data = presenceToGenerated(presence)
	return response, nil
}

func (h *CompanionHandler) GetCompanionStatus(ctx context.Context, request generated.GetCompanionStatusRequestObject) (generated.GetCompanionStatusResponseObject, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return newRawErrorResponse(ctx, domain.NewError(domain.CodeUnauthenticated, "認証が必要")), nil
	}
	status, err := h.companion.GetStatus(ctx, actor)
	if err != nil {
		return newRawErrorResponse(ctx, err), nil
	}
	response := generated.GetCompanionStatus200JSONResponse{}
	response.Data.User = generated.User{Id: string(status.User.ID), Role: generated.UserRole(status.User.Role), DisplayName: status.User.DisplayName}
	response.Data.Presence = presenceToGenerated(status.Presence)
	return response, nil
}

func (h *CompanionHandler) GetVapidPublicKey(ctx context.Context, request generated.GetVapidPublicKeyRequestObject) (generated.GetVapidPublicKeyResponseObject, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return newRawErrorResponse(ctx, domain.NewError(domain.CodeUnauthenticated, "認証が必要")), nil
	}
	key, err := h.companion.VAPIDPublicKey(ctx, actor)
	if err != nil {
		return newRawErrorResponse(ctx, err), nil
	}
	response := generated.GetVapidPublicKey200JSONResponse{}
	response.Data.PublicKey = key
	return response, nil
}

func (h *CompanionHandler) UpsertPushSubscription(ctx context.Context, request generated.UpsertPushSubscriptionRequestObject) (generated.UpsertPushSubscriptionResponseObject, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return newRawErrorResponse(ctx, domain.NewError(domain.CodeUnauthenticated, "認証が必要")), nil
	}
	if request.Body == nil {
		return newRawErrorResponse(ctx, domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")), nil
	}
	if _, err := h.companion.UpsertPushSubscription(ctx, actor, request.Body.Endpoint, request.Body.P256dh, request.Body.Auth); err != nil {
		return newRawErrorResponse(ctx, err), nil
	}
	response := generated.UpsertPushSubscription200JSONResponse{}
	response.Data.Enabled = true
	return response, nil
}

func (h *CompanionHandler) DeletePushSubscription(ctx context.Context, request generated.DeletePushSubscriptionRequestObject) (generated.DeletePushSubscriptionResponseObject, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return newRawErrorResponse(ctx, domain.NewError(domain.CodeUnauthenticated, "認証が必要")), nil
	}
	if request.Body == nil {
		return newRawErrorResponse(ctx, domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")), nil
	}
	if err := h.companion.DeletePushSubscription(ctx, actor, request.Body.Endpoint); err != nil {
		return newRawErrorResponse(ctx, err), nil
	}
	return generated.DeletePushSubscription204Response{}, nil
}

func (h *CompanionHandler) UpdateSupportRequestAcknowledgement(ctx context.Context, request generated.UpdateSupportRequestAcknowledgementRequestObject) (generated.UpdateSupportRequestAcknowledgementResponseObject, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return newRawErrorResponse(ctx, domain.NewError(domain.CodeUnauthenticated, "認証が必要")), nil
	}
	if request.Body == nil {
		return newRawErrorResponse(ctx, domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")), nil
	}
	updated, err := h.support.UpdateSupportRequestAcknowledgement(ctx, actor, domain.ID(request.Id), service.UpdateSupportRequestAcknowledgementInput{
		Kind: domain.SupportAcknowledgementKind(request.Body.AcknowledgementKind), EstimatedSupportAt: request.Body.EstimatedSupportAt, ExpectedRevision: request.Body.ExpectedRevision,
	})
	if err != nil {
		return newRawErrorResponse(ctx, err), nil
	}
	response := generated.UpdateSupportRequestAcknowledgement200JSONResponse{}
	response.Data = supportRequestToGenerated(updated)
	return response, nil
}

func (h *CompanionHandler) CancelSupportRequest(ctx context.Context, request generated.CancelSupportRequestRequestObject) (generated.CancelSupportRequestResponseObject, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return newRawErrorResponse(ctx, domain.NewError(domain.CodeUnauthenticated, "認証が必要")), nil
	}
	if request.Body == nil {
		return newRawErrorResponse(ctx, domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")), nil
	}
	result, err := h.support.CancelSupportRequest(ctx, actor, string(request.Params.IdempotencyKey), domain.ID(request.Id), request.Body.ExpectedRevision)
	if err != nil {
		return newRawErrorResponse(ctx, err), nil
	}
	return rawJSONResponse{status: result.ResponseStatus, body: result.ResponseBody}, nil
}

func presenceToGenerated(value domain.UserPresence) generated.UserPresence {
	return generated.UserPresence{UserId: string(value.UserID), Status: generated.PresenceStatus(value.Status), ConnectedSince: value.ConnectedSince, LastSeenAt: value.LastSeenAt, UpdatedAt: value.UpdatedAt, Revision: value.Revision}
}

var _ CompanionAPI = (*CompanionHandler)(nil)
