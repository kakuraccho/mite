package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/generated"
	"github.com/kakuraccho/mite/server/internal/service"
)

type ArtifactSupportHandler struct {
	service *service.ArtifactSupportService
}

func NewArtifactSupportHandler(service *service.ArtifactSupportService) *ArtifactSupportHandler {
	return &ArtifactSupportHandler{service: service}
}

func (h *ArtifactSupportHandler) CreateArtifact(
	ctx context.Context,
	request generated.CreateArtifactRequestObject,
) (generated.CreateArtifactResponseObject, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return newRawErrorResponse(ctx, domain.NewError(domain.CodeUnauthenticated, "認証が必要")), nil
	}
	input, err := parseCreateArtifactMultipart(request.Body)
	if err != nil {
		return newRawErrorResponse(ctx, err), nil
	}
	result, err := h.service.CreateArtifact(ctx, actor, string(request.Params.IdempotencyKey), input)
	if err != nil {
		return newRawErrorResponse(ctx, err), nil
	}
	return rawJSONResponse{status: result.ResponseStatus, body: result.ResponseBody}, nil
}

func (h *ArtifactSupportHandler) GetArtifactContent(
	ctx context.Context,
	request generated.GetArtifactContentRequestObject,
) (generated.GetArtifactContentResponseObject, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return newRawErrorResponse(ctx, domain.NewError(domain.CodeUnauthenticated, "認証が必要")), nil
	}
	content, err := h.service.GetArtifactContent(ctx, actor, domain.ID(request.Id))
	if err != nil {
		return newRawErrorResponse(ctx, err), nil
	}
	return generated.GetArtifactContent200ImagejpegResponse{
		Body:          content.Body,
		Headers:       generated.GetArtifactContent200ResponseHeaders{CacheControl: "private, no-store"},
		ContentLength: content.Size,
	}, nil
}

func (h *ArtifactSupportHandler) CreateSupportRequest(
	ctx context.Context,
	request generated.CreateSupportRequestRequestObject,
) (generated.CreateSupportRequestResponseObject, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return newRawErrorResponse(ctx, domain.NewError(domain.CodeUnauthenticated, "認証が必要")), nil
	}
	if request.Body == nil {
		return newRawErrorResponse(ctx, domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")), nil
	}
	comment := ""
	if request.Body.Comment != nil {
		comment = *request.Body.Comment
	}
	result, err := h.service.CreateSupportRequest(ctx, actor, string(request.Params.IdempotencyKey), service.CreateSupportRequestInput{
		InitialScreenshotArtifactID: domain.ID(request.Body.InitialScreenshotArtifactId),
		Comment:                     comment,
		RequestID:                   RequestIDFromContext(ctx),
	})
	if err != nil {
		return newRawErrorResponse(ctx, err), nil
	}
	return rawJSONResponse{status: result.ResponseStatus, body: result.ResponseBody}, nil
}

func (h *ArtifactSupportHandler) ListSupportRequests(
	ctx context.Context,
	request generated.ListSupportRequestsRequestObject,
) (generated.ListSupportRequestsResponseObject, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return newRawErrorResponse(ctx, domain.NewError(domain.CodeUnauthenticated, "認証が必要")), nil
	}
	var status *domain.SupportRequestStatus
	if request.Params.Status != nil {
		value := domain.SupportRequestStatus(*request.Params.Status)
		status = &value
	}
	requests, err := h.service.ListSupportRequests(ctx, actor, status)
	if err != nil {
		return newRawErrorResponse(ctx, err), nil
	}
	response := generated.ListSupportRequests200JSONResponse{}
	response.Data.Items = make([]generated.SupportRequest, 0, len(requests))
	for _, item := range requests {
		response.Data.Items = append(response.Data.Items, supportRequestToGenerated(item))
	}
	return response, nil
}

func (h *ArtifactSupportHandler) GetSupportRequest(
	ctx context.Context,
	request generated.GetSupportRequestRequestObject,
) (generated.GetSupportRequestResponseObject, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return newRawErrorResponse(ctx, domain.NewError(domain.CodeUnauthenticated, "認証が必要")), nil
	}
	result, err := h.service.GetSupportRequest(ctx, actor, domain.ID(request.Id))
	if err != nil {
		return newRawErrorResponse(ctx, err), nil
	}
	return generated.GetSupportRequest200JSONResponse{
		Data: supportRequestToGenerated(result),
	}, nil
}

func parseCreateArtifactMultipart(reader *multipart.Reader) (service.CreateArtifactInput, error) {
	if reader == nil {
		return service.CreateArtifactInput{}, domain.NewError(domain.CodeValidationError, "multipart本文が必要")
	}
	seen := make(map[string]bool, 3)
	var purpose string
	var capturedAtText string
	var file []byte
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return service.CreateArtifactInput{}, domain.WrapError(domain.CodeValidationError, "multipart本文が不正", err)
		}
		name := part.FormName()
		if name == "" || seen[name] {
			part.Close()
			return service.CreateArtifactInput{}, domain.NewError(domain.CodeValidationError, "multipart fieldが重複または不正")
		}
		seen[name] = true
		switch name {
		case "purpose":
			value, err := readMultipartPart(part, 64)
			if err != nil {
				return service.CreateArtifactInput{}, err
			}
			purpose = string(value)
		case "capturedAt":
			value, err := readMultipartPart(part, 128)
			if err != nil {
				return service.CreateArtifactInput{}, err
			}
			capturedAtText = string(value)
		case "file":
			value, err := readMultipartPart(part, domain.MaxArtifactBytes+1)
			if err != nil {
				return service.CreateArtifactInput{}, err
			}
			if int64(len(value)) > domain.MaxArtifactBytes {
				return service.CreateArtifactInput{}, domain.NewError(domain.CodeFileTooLarge, "JPEGファイルは10MB以下にする")
			}
			file = value
		default:
			part.Close()
			return service.CreateArtifactInput{}, domain.NewError(domain.CodeValidationError, "未定義のmultipart fieldがある")
		}
	}
	if !seen["purpose"] || !seen["capturedAt"] || !seen["file"] {
		return service.CreateArtifactInput{}, domain.NewError(domain.CodeValidationError, "multipartの必須fieldがない")
	}
	if purpose != string(domain.ArtifactPurposeRequestScreenshot) {
		return service.CreateArtifactInput{}, domain.NewError(domain.CodeValidationError, "purposeが不正")
	}
	capturedAt, err := time.Parse(time.RFC3339Nano, capturedAtText)
	if err != nil {
		return service.CreateArtifactInput{}, domain.WrapError(domain.CodeValidationError, "capturedAtが不正", err)
	}
	return service.CreateArtifactInput{
		Purpose:    domain.ArtifactPurposeRequestScreenshot,
		CapturedAt: capturedAt,
		File:       bytes.NewReader(file),
	}, nil
}

func readMultipartPart(part *multipart.Part, limit int64) ([]byte, error) {
	defer part.Close()
	value, err := io.ReadAll(io.LimitReader(part, limit))
	if err != nil {
		return nil, domain.WrapError(domain.CodeValidationError, "multipart fieldを読み取れない", err)
	}
	if int64(len(value)) == limit {
		// limitは許容最大値+1として渡す。テキストfieldも上限値ちょうどを
		// 許可する必要がないため、この時点で形式エラーにできる。
		if limit <= 128 {
			return nil, domain.NewError(domain.CodeValidationError, "multipart fieldが長すぎる")
		}
	}
	return value, nil
}

func supportRequestToGenerated(request domain.SupportRequest) generated.SupportRequest {
	result := generated.SupportRequest{
		Id: string(request.ID), UserId: string(request.UserID), FamilyId: string(request.FamilyID),
		InitialScreenshotArtifactId: string(request.InitialScreenshotArtifactID), Comment: request.Comment,
		Status: generated.SupportRequestStatus(request.Status), CreatedAt: request.CreatedAt,
		UpdatedAt: request.UpdatedAt, Revision: request.Revision,
	}
	if request.SupportSessionID != nil {
		value := string(*request.SupportSessionID)
		result.SupportSessionId = &value
	}
	if request.GuideContext != nil {
		result.GuideContext = &generated.GuideContext{
			GuideRunId: string(request.GuideContext.GuideRunID), GuideId: string(request.GuideContext.GuideID),
			GuideVersionNumber: request.GuideContext.GuideVersionNumber, StepNumber: request.GuideContext.StepNumber,
			GuideTitle: request.GuideContext.GuideTitle, StepInstruction: request.GuideContext.StepInstruction,
			StepArtifactId: string(request.GuideContext.StepArtifactID),
		}
	}
	result.AcknowledgedAt = request.AcknowledgedAt
	if request.AcknowledgementKind != nil {
		kind := generated.SupportAcknowledgementKind(*request.AcknowledgementKind)
		result.AcknowledgementKind = &kind
	}
	result.EstimatedSupportAt = request.EstimatedSupportAt
	return result
}

type rawJSONResponse struct {
	status int
	body   json.RawMessage
}

func newRawErrorResponse(ctx context.Context, err error) rawJSONResponse {
	domainErr := publicError(err)
	body, marshalErr := json.Marshal(errorEnvelope{Error: errorBody{
		Code: domainErr.Code, Message: domainErr.Message, RequestID: RequestIDFromContext(ctx),
	}})
	if marshalErr != nil {
		body = []byte(`{"error":{"code":"INTERNAL_ERROR","message":"サーバー内部でエラーが発生した","requestId":"unknown"}}`)
	}
	return rawJSONResponse{status: statusForCode(domainErr.Code), body: append(body, '\n')}
}

func (response rawJSONResponse) write(w http.ResponseWriter) error {
	w.Header().Set("Content-Type", "application/json")
	if response.status == http.StatusConflict {
		var payload errorEnvelope
		if json.Unmarshal(response.body, &payload) == nil && payload.Error.Code == domain.CodeIdempotencyRequestInProgress {
			w.Header().Set("Retry-After", "1")
		}
	}
	w.WriteHeader(response.status)
	_, err := w.Write(response.body)
	return err
}

func (response rawJSONResponse) VisitCreateArtifactResponse(w http.ResponseWriter) error {
	return response.write(w)
}

func (response rawJSONResponse) VisitGetArtifactContentResponse(w http.ResponseWriter) error {
	return response.write(w)
}

func (response rawJSONResponse) VisitCreateSupportRequestResponse(w http.ResponseWriter) error {
	return response.write(w)
}

func (response rawJSONResponse) VisitListSupportRequestsResponse(w http.ResponseWriter) error {
	return response.write(w)
}

func (response rawJSONResponse) VisitGetSupportRequestResponse(w http.ResponseWriter) error {
	return response.write(w)
}

func (response rawJSONResponse) VisitGetCompanionStatusResponse(w http.ResponseWriter) error {
	return response.write(w)
}
func (response rawJSONResponse) VisitRecordPresenceHeartbeatResponse(w http.ResponseWriter) error {
	return response.write(w)
}
func (response rawJSONResponse) VisitGetVapidPublicKeyResponse(w http.ResponseWriter) error {
	return response.write(w)
}
func (response rawJSONResponse) VisitUpsertPushSubscriptionResponse(w http.ResponseWriter) error {
	return response.write(w)
}
func (response rawJSONResponse) VisitDeletePushSubscriptionResponse(w http.ResponseWriter) error {
	return response.write(w)
}
func (response rawJSONResponse) VisitUpdateSupportRequestAcknowledgementResponse(w http.ResponseWriter) error {
	return response.write(w)
}
func (response rawJSONResponse) VisitCancelSupportRequestResponse(w http.ResponseWriter) error {
	return response.write(w)
}

var _ ArtifactSupportAPI = (*ArtifactSupportHandler)(nil)
