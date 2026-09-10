package handler

import (
	"context"
	"errors"
	"io"
	"mime/multipart"
	"strconv"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/generated"
	"github.com/kakuraccho/mite/server/internal/service"
)

type GuideUseCases interface {
	ListSessionGuideDrafts(context.Context, domain.Actor, domain.ID) ([]domain.GuideDraft, error)
	CompleteGuideReview(context.Context, service.CompleteGuideReviewCommand) (service.GuideReviewCompleted, error)
	CreateGuideMaterialBatch(context.Context, service.CreateGuideMaterialBatchCommand) (service.GuideMaterialBatchCreated, error)
	GetGuideMaterialBatch(context.Context, domain.Actor, domain.ID) (service.GuideMaterialBatchView, error)
	CreateGuideMaterial(context.Context, service.CreateGuideMaterialCommand) (service.GuideMaterialCreated, int, error)
	CompleteGuideMaterialBatch(context.Context, service.CompleteGuideMaterialBatchCommand) (service.GuideMaterialBatchCompleted, error)
	GetGuideGenerationJob(context.Context, domain.Actor, domain.ID) (domain.GuideGenerationJob, error)
	RetryGuideGenerationJob(context.Context, service.RetryGuideGenerationJobCommand) (domain.GuideGenerationJob, error)
	GetGuideDraft(context.Context, domain.Actor, domain.ID) (domain.GuideDraft, error)
	UpdateGuideDraft(context.Context, service.UpdateGuideDraftCommand) (domain.GuideDraft, error)
	SaveGuideDraft(context.Context, service.SaveGuideDraftCommand) (service.GuideSaved, error)
	ListGuides(context.Context, domain.Actor) ([]domain.GuideSummary, error)
	GetGuide(context.Context, domain.Actor, domain.ID) (domain.GuideDetail, error)
	CreateGuideRun(context.Context, service.CreateGuideRunCommand) (domain.GuideRun, error)
	GetGuideRun(context.Context, domain.Actor, domain.ID) (domain.GuideRun, error)
	UpdateGuideRun(context.Context, service.UpdateGuideRunCommand) (domain.GuideRun, error)
	CompleteGuideRun(context.Context, service.CompleteGuideRunCommand) (domain.GuideRun, error)
	CancelGuideRun(context.Context, service.CancelGuideRunCommand) (domain.GuideRun, error)
	CreateSupportRequestFromGuideRun(context.Context, service.CreateSupportRequestFromGuideRunCommand) (service.GuideRunSupportRequestCreated, error)
}

type GuideHandler struct{ service GuideUseCases }

func NewGuideHandler(guideService GuideUseCases) *GuideHandler {
	return &GuideHandler{service: guideService}
}

type guideAPIError struct {
	Status     int
	Response   generated.ErrorResponse
	RetryAfter *int
}

func makeGuideAPIError(ctx context.Context, err error) guideAPIError {
	requestID := RequestIDFromContext(ctx)
	var operationErr *service.GuideOperationError
	if errors.As(err, &operationErr) && operationErr.RequestID != "" {
		requestID = operationErr.RequestID
	}
	domainErr := publicError(err)
	status := statusForCode(domainErr.Code)
	response := generated.ErrorResponse{Error: generated.Error{Code: generated.ErrorCode(domainErr.Code), Message: domainErr.Message, RequestId: requestID}}
	var retry *int
	if domainErr.Code == domain.CodeIdempotencyRequestInProgress {
		value := 1
		retry = &value
	}
	return guideAPIError{Status: status, Response: response, RetryAfter: retry}
}

func actorFromGuideContext(ctx context.Context) (domain.Actor, error) {
	actor, ok := ActorFromContext(ctx)
	if !ok {
		return domain.Actor{}, domain.NewError(domain.CodeUnauthenticated, "認証が必要")
	}
	return actor, nil
}
func commandMeta(ctx context.Context, key string) (service.CommandMeta, error) {
	actor, err := actorFromGuideContext(ctx)
	if err != nil {
		return service.CommandMeta{}, err
	}
	return service.CommandMeta{Actor: actor, Key: key, RequestID: RequestIDFromContext(ctx)}, nil
}

func (h *GuideHandler) CreateGuideMaterialBatch(ctx context.Context, request generated.CreateGuideMaterialBatchRequestObject) (generated.CreateGuideMaterialBatchResponseObject, error) {
	meta, err := commandMeta(ctx, request.Params.IdempotencyKey)
	if err == nil && request.Body == nil {
		err = domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")
	}
	var value service.GuideMaterialBatchCreated
	if err == nil {
		value, err = h.service.CreateGuideMaterialBatch(ctx, service.CreateGuideMaterialBatchCommand{Meta: meta, SupportSessionID: domain.ID(request.Id), ExpectedSessionRevision: request.Body.ExpectedSessionRevision, CaptureIntervalSeconds: int(request.Body.CaptureIntervalSeconds), CapturedFrom: request.Body.CapturedFrom, CapturedTo: request.Body.CapturedTo, ExpectedItemCount: request.Body.ExpectedItemCount})
	}
	if err != nil {
		apiErr := makeGuideAPIError(ctx, err)
		switch apiErr.Status {
		case 400:
			return generated.CreateGuideMaterialBatch400JSONResponse{BadRequestJSONResponse: generated.BadRequestJSONResponse(apiErr.Response)}, nil
		case 401:
			return generated.CreateGuideMaterialBatch401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(apiErr.Response)}, nil
		case 403:
			return generated.CreateGuideMaterialBatch403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(apiErr.Response)}, nil
		case 404:
			return generated.CreateGuideMaterialBatch404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(apiErr.Response)}, nil
		case 409:
			return generated.CreateGuideMaterialBatch409JSONResponse{ConflictJSONResponse: generated.ConflictJSONResponse{Body: apiErr.Response, Headers: generated.ConflictResponseHeaders{RetryAfter: apiErr.RetryAfter}}}, nil
		case 422:
			return generated.CreateGuideMaterialBatch422JSONResponse{UnprocessableEntityJSONResponse: generated.UnprocessableEntityJSONResponse(apiErr.Response)}, nil
		default:
			return generated.CreateGuideMaterialBatch500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(apiErr.Response)}, nil
		}
	}
	response := generated.GuideMaterialBatchCreatedResponse{}
	response.Data.Batch = guideBatchToAPI(value.Batch)
	response.Data.SupportSession = supportSessionToAPI(value.SupportSession)
	return generated.CreateGuideMaterialBatch201JSONResponse(response), nil
}

func (h *GuideHandler) GetGuideMaterialBatch(ctx context.Context, request generated.GetGuideMaterialBatchRequestObject) (generated.GetGuideMaterialBatchResponseObject, error) {
	actor, err := actorFromGuideContext(ctx)
	var value service.GuideMaterialBatchView
	if err == nil {
		value, err = h.service.GetGuideMaterialBatch(ctx, actor, domain.ID(request.Id))
	}
	if err != nil {
		apiErr := makeGuideAPIError(ctx, err)
		switch apiErr.Status {
		case 401:
			return generated.GetGuideMaterialBatch401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(apiErr.Response)}, nil
		case 403:
			return generated.GetGuideMaterialBatch403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(apiErr.Response)}, nil
		case 404:
			return generated.GetGuideMaterialBatch404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(apiErr.Response)}, nil
		default:
			return generated.GetGuideMaterialBatch500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(apiErr.Response)}, nil
		}
	}
	response := generated.GuideMaterialBatchResponse{}
	response.Data.Batch = guideBatchToAPI(value.Batch)
	response.Data.Materials = make([]generated.GuideMaterial, len(value.Materials))
	for index, material := range value.Materials {
		response.Data.Materials[index] = guideMaterialToAPI(material)
	}
	return generated.GetGuideMaterialBatch200JSONResponse(response), nil
}

func (h *GuideHandler) CreateGuideMaterial(ctx context.Context, request generated.CreateGuideMaterialRequestObject) (generated.CreateGuideMaterialResponseObject, error) {
	meta, err := commandMeta(ctx, request.Params.IdempotencyKey)
	var body guideMaterialMultipart
	if err == nil {
		body, err = readGuideMaterialMultipart(request.Body)
	}
	var value service.GuideMaterialCreated
	status := 0
	if err == nil {
		value, status, err = h.service.CreateGuideMaterial(ctx, service.CreateGuideMaterialCommand{Meta: meta, BatchID: domain.ID(request.Id), ClientCaptureID: body.ClientCaptureID, Sequence: body.Sequence, CapturedAt: body.CapturedAt, JPEG: body.File})
	}
	if err != nil {
		apiErr := makeGuideAPIError(ctx, err)
		switch apiErr.Status {
		case 400:
			return generated.CreateGuideMaterial400JSONResponse{BadRequestJSONResponse: generated.BadRequestJSONResponse(apiErr.Response)}, nil
		case 401:
			return generated.CreateGuideMaterial401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(apiErr.Response)}, nil
		case 403:
			return generated.CreateGuideMaterial403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(apiErr.Response)}, nil
		case 404:
			return generated.CreateGuideMaterial404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(apiErr.Response)}, nil
		case 409:
			return generated.CreateGuideMaterial409JSONResponse{ConflictJSONResponse: generated.ConflictJSONResponse{Body: apiErr.Response, Headers: generated.ConflictResponseHeaders{RetryAfter: apiErr.RetryAfter}}}, nil
		case 413:
			return generated.CreateGuideMaterial413JSONResponse{PayloadTooLargeJSONResponse: generated.PayloadTooLargeJSONResponse(apiErr.Response)}, nil
		case 503:
			return generated.CreateGuideMaterial503JSONResponse{ServiceUnavailableJSONResponse: generated.ServiceUnavailableJSONResponse(apiErr.Response)}, nil
		default:
			return generated.CreateGuideMaterial500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(apiErr.Response)}, nil
		}
	}
	response := generated.GuideMaterialCreatedResponse{}
	response.Data.Material = guideMaterialToAPI(value.Material)
	response.Data.Batch = guideBatchToAPI(value.Batch)
	if status == 200 {
		return generated.CreateGuideMaterial200JSONResponse(response), nil
	}
	return generated.CreateGuideMaterial201JSONResponse(response), nil
}

type guideMaterialMultipart struct {
	ClientCaptureID string
	Sequence        int
	CapturedAt      time.Time
	File            []byte
}

func readGuideMaterialMultipart(reader *multipart.Reader) (guideMaterialMultipart, error) {
	if reader == nil {
		return guideMaterialMultipart{}, domain.NewError(domain.CodeValidationError, "multipart本文が必要")
	}
	var result guideMaterialMultipart
	seen := map[string]bool{}
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return guideMaterialMultipart{}, domain.NewError(domain.CodeValidationError, "multipart本文が不正")
		}
		name := part.FormName()
		if seen[name] || (name != "clientCaptureId" && name != "sequence" && name != "capturedAt" && name != "file") {
			return guideMaterialMultipart{}, domain.NewError(domain.CodeValidationError, "multipart fieldが不正")
		}
		seen[name] = true
		limit := int64(4096 + 1)
		if name == "file" {
			limit = domain.MaxArtifactBytes + 1
		}
		data, readErr := io.ReadAll(io.LimitReader(part, limit))
		if readErr != nil {
			_ = part.Close()
			return guideMaterialMultipart{}, domain.NewError(domain.CodeValidationError, "multipart fieldを読めない")
		}
		if name != "file" && len(data) > 4096 {
			return guideMaterialMultipart{}, domain.NewError(domain.CodeValidationError, "multipart fieldが長すぎる")
		}
		if name == "file" && int64(len(data)) > domain.MaxArtifactBytes {
			return guideMaterialMultipart{}, domain.NewError(domain.CodeFileTooLarge, "画像は10MB以下にする")
		}
		_ = part.Close()
		switch name {
		case "clientCaptureId":
			result.ClientCaptureID = string(data)
		case "sequence":
			result.Sequence, err = strconv.Atoi(string(data))
			if err != nil {
				return guideMaterialMultipart{}, domain.NewError(domain.CodeValidationError, "sequenceが不正")
			}
		case "capturedAt":
			result.CapturedAt, err = time.Parse(time.RFC3339, string(data))
			if err != nil {
				return guideMaterialMultipart{}, domain.NewError(domain.CodeValidationError, "capturedAtが不正")
			}
		case "file":
			result.File = data
		}
	}
	for _, field := range []string{"clientCaptureId", "sequence", "capturedAt", "file"} {
		if !seen[field] {
			return guideMaterialMultipart{}, domain.NewError(domain.CodeValidationError, "必須multipart fieldがない")
		}
	}
	return result, nil
}

func (h *GuideHandler) CompleteGuideMaterialBatch(ctx context.Context, request generated.CompleteGuideMaterialBatchRequestObject) (generated.CompleteGuideMaterialBatchResponseObject, error) {
	meta, err := commandMeta(ctx, request.Params.IdempotencyKey)
	if err == nil && request.Body == nil {
		err = domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")
	}
	var value service.GuideMaterialBatchCompleted
	if err == nil {
		value, err = h.service.CompleteGuideMaterialBatch(ctx, service.CompleteGuideMaterialBatchCommand{Meta: meta, BatchID: domain.ID(request.Id), ExpectedBatchRevision: request.Body.ExpectedBatchRevision, ExpectedItemCount: request.Body.ExpectedItemCount})
	}
	if err != nil {
		apiErr := makeGuideAPIError(ctx, err)
		switch apiErr.Status {
		case 400:
			return generated.CompleteGuideMaterialBatch400JSONResponse{BadRequestJSONResponse: generated.BadRequestJSONResponse(apiErr.Response)}, nil
		case 401:
			return generated.CompleteGuideMaterialBatch401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(apiErr.Response)}, nil
		case 403:
			return generated.CompleteGuideMaterialBatch403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(apiErr.Response)}, nil
		case 404:
			return generated.CompleteGuideMaterialBatch404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(apiErr.Response)}, nil
		case 409:
			return generated.CompleteGuideMaterialBatch409JSONResponse{ConflictJSONResponse: generated.ConflictJSONResponse{Body: apiErr.Response, Headers: generated.ConflictResponseHeaders{RetryAfter: apiErr.RetryAfter}}}, nil
		default:
			return generated.CompleteGuideMaterialBatch500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(apiErr.Response)}, nil
		}
	}
	response := generated.GuideMaterialBatchCompletedResponse{}
	response.Data.Batch = guideBatchToAPI(value.Batch)
	response.Data.Job = guideJobToAPI(value.Job)
	response.Data.SupportSession = supportSessionToAPI(value.SupportSession)
	return generated.CompleteGuideMaterialBatch202JSONResponse(response), nil
}

func (h *GuideHandler) GetGuideGenerationJob(ctx context.Context, request generated.GetGuideGenerationJobRequestObject) (generated.GetGuideGenerationJobResponseObject, error) {
	actor, err := actorFromGuideContext(ctx)
	var value domain.GuideGenerationJob
	if err == nil {
		value, err = h.service.GetGuideGenerationJob(ctx, actor, domain.ID(request.Id))
	}
	if err != nil {
		apiErr := makeGuideAPIError(ctx, err)
		switch apiErr.Status {
		case 401:
			return generated.GetGuideGenerationJob401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(apiErr.Response)}, nil
		case 403:
			return generated.GetGuideGenerationJob403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(apiErr.Response)}, nil
		case 404:
			return generated.GetGuideGenerationJob404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(apiErr.Response)}, nil
		default:
			return generated.GetGuideGenerationJob500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(apiErr.Response)}, nil
		}
	}
	return generated.GetGuideGenerationJob200JSONResponse(generated.GuideGenerationJobResponse{Data: guideJobToAPI(value)}), nil
}

func (h *GuideHandler) RetryGuideGenerationJob(ctx context.Context, request generated.RetryGuideGenerationJobRequestObject) (generated.RetryGuideGenerationJobResponseObject, error) {
	meta, err := commandMeta(ctx, request.Params.IdempotencyKey)
	if err == nil && request.Body == nil {
		err = domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")
	}
	var value domain.GuideGenerationJob
	if err == nil {
		value, err = h.service.RetryGuideGenerationJob(ctx, service.RetryGuideGenerationJobCommand{Meta: meta, JobID: domain.ID(request.Id), ExpectedJobRevision: request.Body.ExpectedJobRevision})
	}
	if err != nil {
		apiErr := makeGuideAPIError(ctx, err)
		switch apiErr.Status {
		case 400:
			return generated.RetryGuideGenerationJob400JSONResponse{BadRequestJSONResponse: generated.BadRequestJSONResponse(apiErr.Response)}, nil
		case 401:
			return generated.RetryGuideGenerationJob401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(apiErr.Response)}, nil
		case 403:
			return generated.RetryGuideGenerationJob403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(apiErr.Response)}, nil
		case 404:
			return generated.RetryGuideGenerationJob404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(apiErr.Response)}, nil
		case 409:
			return generated.RetryGuideGenerationJob409JSONResponse{ConflictJSONResponse: generated.ConflictJSONResponse{Body: apiErr.Response, Headers: generated.ConflictResponseHeaders{RetryAfter: apiErr.RetryAfter}}}, nil
		default:
			return generated.RetryGuideGenerationJob500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(apiErr.Response)}, nil
		}
	}
	return generated.RetryGuideGenerationJob202JSONResponse(generated.GuideGenerationJobResponse{Data: guideJobToAPI(value)}), nil
}

func (h *GuideHandler) GetGuideDraft(ctx context.Context, request generated.GetGuideDraftRequestObject) (generated.GetGuideDraftResponseObject, error) {
	actor, err := actorFromGuideContext(ctx)
	var value domain.GuideDraft
	if err == nil {
		value, err = h.service.GetGuideDraft(ctx, actor, domain.ID(request.Id))
	}
	if err != nil {
		apiErr := makeGuideAPIError(ctx, err)
		switch apiErr.Status {
		case 401:
			return generated.GetGuideDraft401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(apiErr.Response)}, nil
		case 403:
			return generated.GetGuideDraft403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(apiErr.Response)}, nil
		case 404:
			return generated.GetGuideDraft404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(apiErr.Response)}, nil
		default:
			return generated.GetGuideDraft500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(apiErr.Response)}, nil
		}
	}
	return generated.GetGuideDraft200JSONResponse(generated.GuideDraftResponse{Data: guideDraftToAPI(value)}), nil
}

func (h *GuideHandler) UpdateGuideDraft(ctx context.Context, request generated.UpdateGuideDraftRequestObject) (generated.UpdateGuideDraftResponseObject, error) {
	actor, err := actorFromGuideContext(ctx)
	if err == nil && request.Body == nil {
		err = domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")
	}
	var value domain.GuideDraft
	if err == nil {
		steps := make([]domain.GuideStep, len(request.Body.Steps))
		for index, step := range request.Body.Steps {
			steps[index] = domain.GuideStep{Position: step.Position, ArtifactID: domain.ID(step.ArtifactId), Instruction: step.Instruction}
		}
		value, err = h.service.UpdateGuideDraft(ctx, service.UpdateGuideDraftCommand{Actor: actor, DraftID: domain.ID(request.Id), ExpectedRevision: request.Body.ExpectedRevision, Title: request.Body.Title, Steps: steps})
	}
	if err != nil {
		apiErr := makeGuideAPIError(ctx, err)
		switch apiErr.Status {
		case 400:
			return generated.UpdateGuideDraft400JSONResponse{BadRequestJSONResponse: generated.BadRequestJSONResponse(apiErr.Response)}, nil
		case 401:
			return generated.UpdateGuideDraft401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(apiErr.Response)}, nil
		case 403:
			return generated.UpdateGuideDraft403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(apiErr.Response)}, nil
		case 404:
			return generated.UpdateGuideDraft404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(apiErr.Response)}, nil
		case 409:
			return generated.UpdateGuideDraft409JSONResponse{ConflictJSONResponse: generated.ConflictJSONResponse{Body: apiErr.Response, Headers: generated.ConflictResponseHeaders{RetryAfter: apiErr.RetryAfter}}}, nil
		default:
			return generated.UpdateGuideDraft500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(apiErr.Response)}, nil
		}
	}
	return generated.UpdateGuideDraft200JSONResponse(generated.GuideDraftResponse{Data: guideDraftToAPI(value)}), nil
}

func (h *GuideHandler) SaveGuideDraft(ctx context.Context, request generated.SaveGuideDraftRequestObject) (generated.SaveGuideDraftResponseObject, error) {
	meta, err := commandMeta(ctx, request.Params.IdempotencyKey)
	if err == nil && request.Body == nil {
		err = domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")
	}
	var value service.GuideSaved
	if err == nil {
		value, err = h.service.SaveGuideDraft(ctx, service.SaveGuideDraftCommand{Meta: meta, DraftID: domain.ID(request.Id), ExpectedRevision: request.Body.ExpectedRevision})
	}
	if err != nil {
		apiErr := makeGuideAPIError(ctx, err)
		switch apiErr.Status {
		case 400:
			return generated.SaveGuideDraft400JSONResponse{BadRequestJSONResponse: generated.BadRequestJSONResponse(apiErr.Response)}, nil
		case 401:
			return generated.SaveGuideDraft401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(apiErr.Response)}, nil
		case 403:
			return generated.SaveGuideDraft403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(apiErr.Response)}, nil
		case 404:
			return generated.SaveGuideDraft404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(apiErr.Response)}, nil
		case 409:
			return generated.SaveGuideDraft409JSONResponse{ConflictJSONResponse: generated.ConflictJSONResponse{Body: apiErr.Response, Headers: generated.ConflictResponseHeaders{RetryAfter: apiErr.RetryAfter}}}, nil
		default:
			return generated.SaveGuideDraft500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(apiErr.Response)}, nil
		}
	}
	response := generated.GuideSavedResponse{}
	response.Data.Guide = guideDetailToAPI(value.Guide)
	response.Data.SupportSession = supportSessionToAPI(value.SupportSession)
	return generated.SaveGuideDraft201JSONResponse(response), nil
}

func (h *GuideHandler) ListGuides(ctx context.Context, _ generated.ListGuidesRequestObject) (generated.ListGuidesResponseObject, error) {
	actor, err := actorFromGuideContext(ctx)
	var values []domain.GuideSummary
	if err == nil {
		values, err = h.service.ListGuides(ctx, actor)
	}
	if err != nil {
		apiErr := makeGuideAPIError(ctx, err)
		switch apiErr.Status {
		case 401:
			return generated.ListGuides401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(apiErr.Response)}, nil
		case 403:
			return generated.ListGuides403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(apiErr.Response)}, nil
		default:
			return generated.ListGuides500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(apiErr.Response)}, nil
		}
	}
	response := generated.GuideListResponse{}
	response.Data.Items = make([]generated.GuideSummary, len(values))
	for index, value := range values {
		response.Data.Items[index] = guideSummaryToAPI(value)
	}
	return generated.ListGuides200JSONResponse(response), nil
}

func (h *GuideHandler) GetGuide(ctx context.Context, request generated.GetGuideRequestObject) (generated.GetGuideResponseObject, error) {
	actor, err := actorFromGuideContext(ctx)
	var value domain.GuideDetail
	if err == nil {
		value, err = h.service.GetGuide(ctx, actor, domain.ID(request.Id))
	}
	if err != nil {
		apiErr := makeGuideAPIError(ctx, err)
		switch apiErr.Status {
		case 401:
			return generated.GetGuide401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(apiErr.Response)}, nil
		case 403:
			return generated.GetGuide403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(apiErr.Response)}, nil
		case 404:
			return generated.GetGuide404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(apiErr.Response)}, nil
		default:
			return generated.GetGuide500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(apiErr.Response)}, nil
		}
	}
	return generated.GetGuide200JSONResponse(generated.GuideDetailResponse{Data: guideDetailToAPI(value)}), nil
}

func (h *GuideHandler) CreateGuideRun(ctx context.Context, request generated.CreateGuideRunRequestObject) (generated.CreateGuideRunResponseObject, error) {
	meta, err := commandMeta(ctx, request.Params.IdempotencyKey)
	if err == nil && request.Body == nil {
		err = domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")
	}
	var value domain.GuideRun
	if err == nil {
		value, err = h.service.CreateGuideRun(ctx, service.CreateGuideRunCommand{Meta: meta, GuideID: domain.ID(request.Body.GuideId)})
	}
	if err != nil {
		apiErr := makeGuideAPIError(ctx, err)
		switch apiErr.Status {
		case 400:
			return generated.CreateGuideRun400JSONResponse{BadRequestJSONResponse: generated.BadRequestJSONResponse(apiErr.Response)}, nil
		case 401:
			return generated.CreateGuideRun401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(apiErr.Response)}, nil
		case 403:
			return generated.CreateGuideRun403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(apiErr.Response)}, nil
		case 404:
			return generated.CreateGuideRun404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(apiErr.Response)}, nil
		case 409:
			return generated.CreateGuideRun409JSONResponse{ConflictJSONResponse: generated.ConflictJSONResponse{Body: apiErr.Response, Headers: generated.ConflictResponseHeaders{RetryAfter: apiErr.RetryAfter}}}, nil
		default:
			return generated.CreateGuideRun500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(apiErr.Response)}, nil
		}
	}
	return generated.CreateGuideRun201JSONResponse(generated.GuideRunResponse{Data: guideRunToAPI(value)}), nil
}

func (h *GuideHandler) GetGuideRun(ctx context.Context, request generated.GetGuideRunRequestObject) (generated.GetGuideRunResponseObject, error) {
	actor, err := actorFromGuideContext(ctx)
	var value domain.GuideRun
	if err == nil {
		value, err = h.service.GetGuideRun(ctx, actor, domain.ID(request.Id))
	}
	if err != nil {
		apiErr := makeGuideAPIError(ctx, err)
		switch apiErr.Status {
		case 401:
			return generated.GetGuideRun401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(apiErr.Response)}, nil
		case 403:
			return generated.GetGuideRun403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(apiErr.Response)}, nil
		case 404:
			return generated.GetGuideRun404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(apiErr.Response)}, nil
		default:
			return generated.GetGuideRun500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(apiErr.Response)}, nil
		}
	}
	return generated.GetGuideRun200JSONResponse(generated.GuideRunResponse{Data: guideRunToAPI(value)}), nil
}

func (h *GuideHandler) UpdateGuideRun(ctx context.Context, request generated.UpdateGuideRunRequestObject) (generated.UpdateGuideRunResponseObject, error) {
	actor, err := actorFromGuideContext(ctx)
	if err == nil && request.Body == nil {
		err = domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")
	}
	var value domain.GuideRun
	if err == nil {
		value, err = h.service.UpdateGuideRun(ctx, service.UpdateGuideRunCommand{Actor: actor, RunID: domain.ID(request.Id), ExpectedRevision: request.Body.ExpectedRevision, Action: domain.GuideRunAction(request.Body.Action)})
	}
	if err != nil {
		apiErr := makeGuideAPIError(ctx, err)
		switch apiErr.Status {
		case 400:
			return generated.UpdateGuideRun400JSONResponse{BadRequestJSONResponse: generated.BadRequestJSONResponse(apiErr.Response)}, nil
		case 401:
			return generated.UpdateGuideRun401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(apiErr.Response)}, nil
		case 403:
			return generated.UpdateGuideRun403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(apiErr.Response)}, nil
		case 404:
			return generated.UpdateGuideRun404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(apiErr.Response)}, nil
		case 409:
			return generated.UpdateGuideRun409JSONResponse{ConflictJSONResponse: generated.ConflictJSONResponse{Body: apiErr.Response, Headers: generated.ConflictResponseHeaders{RetryAfter: apiErr.RetryAfter}}}, nil
		default:
			return generated.UpdateGuideRun500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(apiErr.Response)}, nil
		}
	}
	return generated.UpdateGuideRun200JSONResponse(generated.GuideRunResponse{Data: guideRunToAPI(value)}), nil
}

func (h *GuideHandler) CompleteGuideRun(ctx context.Context, request generated.CompleteGuideRunRequestObject) (generated.CompleteGuideRunResponseObject, error) {
	meta, err := commandMeta(ctx, request.Params.IdempotencyKey)
	if err == nil && request.Body == nil {
		err = domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")
	}
	var value domain.GuideRun
	if err == nil {
		value, err = h.service.CompleteGuideRun(ctx, service.CompleteGuideRunCommand{Meta: meta, RunID: domain.ID(request.Id), ExpectedRevision: request.Body.ExpectedRevision})
	}
	if err != nil {
		apiErr := makeGuideAPIError(ctx, err)
		switch apiErr.Status {
		case 400:
			return generated.CompleteGuideRun400JSONResponse{BadRequestJSONResponse: generated.BadRequestJSONResponse(apiErr.Response)}, nil
		case 401:
			return generated.CompleteGuideRun401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(apiErr.Response)}, nil
		case 403:
			return generated.CompleteGuideRun403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(apiErr.Response)}, nil
		case 404:
			return generated.CompleteGuideRun404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(apiErr.Response)}, nil
		case 409:
			return generated.CompleteGuideRun409JSONResponse{ConflictJSONResponse: generated.ConflictJSONResponse{Body: apiErr.Response, Headers: generated.ConflictResponseHeaders{RetryAfter: apiErr.RetryAfter}}}, nil
		default:
			return generated.CompleteGuideRun500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(apiErr.Response)}, nil
		}
	}
	return generated.CompleteGuideRun200JSONResponse(generated.GuideRunResponse{Data: guideRunToAPI(value)}), nil
}

func (h *GuideHandler) CancelGuideRun(ctx context.Context, request generated.CancelGuideRunRequestObject) (generated.CancelGuideRunResponseObject, error) {
	meta, err := commandMeta(ctx, request.Params.IdempotencyKey)
	if err == nil && request.Body == nil {
		err = domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")
	}
	var value domain.GuideRun
	if err == nil {
		value, err = h.service.CancelGuideRun(ctx, service.CancelGuideRunCommand{Meta: meta, RunID: domain.ID(request.Id), ExpectedRevision: request.Body.ExpectedRevision})
	}
	if err != nil {
		apiErr := makeGuideAPIError(ctx, err)
		switch apiErr.Status {
		case 400:
			return generated.CancelGuideRun400JSONResponse{BadRequestJSONResponse: generated.BadRequestJSONResponse(apiErr.Response)}, nil
		case 401:
			return generated.CancelGuideRun401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(apiErr.Response)}, nil
		case 403:
			return generated.CancelGuideRun403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(apiErr.Response)}, nil
		case 404:
			return generated.CancelGuideRun404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(apiErr.Response)}, nil
		case 409:
			return generated.CancelGuideRun409JSONResponse{ConflictJSONResponse: generated.ConflictJSONResponse{Body: apiErr.Response, Headers: generated.ConflictResponseHeaders{RetryAfter: apiErr.RetryAfter}}}, nil
		default:
			return generated.CancelGuideRun500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(apiErr.Response)}, nil
		}
	}
	return generated.CancelGuideRun200JSONResponse(generated.GuideRunResponse{Data: guideRunToAPI(value)}), nil
}

func (h *GuideHandler) CreateSupportRequestFromGuideRun(ctx context.Context, request generated.CreateSupportRequestFromGuideRunRequestObject) (generated.CreateSupportRequestFromGuideRunResponseObject, error) {
	meta, err := commandMeta(ctx, request.Params.IdempotencyKey)
	if err == nil && request.Body == nil {
		err = domain.NewError(domain.CodeValidationError, "リクエスト本文が必要")
	}
	var value service.GuideRunSupportRequestCreated
	if err == nil {
		comment := ""
		if request.Body.Comment != nil {
			comment = *request.Body.Comment
		}
		value, err = h.service.CreateSupportRequestFromGuideRun(ctx, service.CreateSupportRequestFromGuideRunCommand{Meta: meta, RunID: domain.ID(request.Id), ExpectedRevision: request.Body.ExpectedRevision, InitialScreenshotArtifactID: domain.ID(request.Body.InitialScreenshotArtifactId), Comment: comment})
	}
	if err != nil {
		apiErr := makeGuideAPIError(ctx, err)
		switch apiErr.Status {
		case 400:
			return generated.CreateSupportRequestFromGuideRun400JSONResponse{BadRequestJSONResponse: generated.BadRequestJSONResponse(apiErr.Response)}, nil
		case 401:
			return generated.CreateSupportRequestFromGuideRun401JSONResponse{UnauthorizedJSONResponse: generated.UnauthorizedJSONResponse(apiErr.Response)}, nil
		case 403:
			return generated.CreateSupportRequestFromGuideRun403JSONResponse{ForbiddenJSONResponse: generated.ForbiddenJSONResponse(apiErr.Response)}, nil
		case 404:
			return generated.CreateSupportRequestFromGuideRun404JSONResponse{NotFoundJSONResponse: generated.NotFoundJSONResponse(apiErr.Response)}, nil
		case 409:
			return generated.CreateSupportRequestFromGuideRun409JSONResponse{ConflictJSONResponse: generated.ConflictJSONResponse{Body: apiErr.Response, Headers: generated.ConflictResponseHeaders{RetryAfter: apiErr.RetryAfter}}}, nil
		default:
			return generated.CreateSupportRequestFromGuideRun500JSONResponse{InternalErrorJSONResponse: generated.InternalErrorJSONResponse(apiErr.Response)}, nil
		}
	}
	response := generated.GuideRunSupportRequestResponse{}
	response.Data.GuideRun = guideRunToAPI(value.GuideRun)
	response.Data.SupportRequest = supportRequestToAPI(value.SupportRequest)
	return generated.CreateSupportRequestFromGuideRun201JSONResponse(response), nil
}

func guideBatchToAPI(value domain.GuideMaterialBatch) generated.GuideMaterialBatch {
	return generated.GuideMaterialBatch{Id: string(value.ID), SupportSessionId: string(value.SupportSessionID), Status: generated.GuideMaterialBatchStatus(value.Status), CaptureIntervalSeconds: generated.GuideMaterialBatchCaptureIntervalSeconds(value.CaptureIntervalSeconds), ExpectedItemCount: value.ExpectedItemCount, ReceivedItemCount: value.ReceivedItemCount, CapturedFrom: value.CapturedFrom, CapturedTo: value.CapturedTo, CompletedAt: value.CompletedAt, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt, Revision: value.Revision}
}
func guideMaterialToAPI(value domain.GuideMaterial) generated.GuideMaterial {
	return generated.GuideMaterial{Id: string(value.ID), BatchId: string(value.BatchID), ClientCaptureId: value.ClientCaptureID, ArtifactId: string(value.ArtifactID), Sequence: value.Sequence, CapturedAt: value.CapturedAt, CreatedAt: value.CreatedAt}
}
func guideJobToAPI(value domain.GuideGenerationJob) generated.GuideGenerationJob {
	var draftID *string
	if value.GuideDraftID != nil {
		id := string(*value.GuideDraftID)
		draftID = &id
	}
	var code *generated.GuideGenerationErrorCode
	if value.ErrorCode != nil {
		item := generated.GuideGenerationErrorCode(*value.ErrorCode)
		code = &item
	}
	return generated.GuideGenerationJob{Id: string(value.ID), BatchId: string(value.BatchID), Status: generated.GuideGenerationJobStatus(value.Status), Attempt: value.Attempt, GuideDraftId: draftID, ErrorCode: code, CreatedAt: value.CreatedAt, StartedAt: value.StartedAt, FinishedAt: value.FinishedAt, UpdatedAt: value.UpdatedAt, Revision: value.Revision}
}
func guideDraftToAPI(value domain.GuideDraft) generated.GuideDraft {
	steps := make([]generated.GuideStep, len(value.Steps))
	for index, step := range value.Steps {
		steps[index] = guideStepToAPI(step)
	}
	return generated.GuideDraft{Id: string(value.ID), SupportSessionId: string(value.SupportSessionID), Title: value.Title, Steps: steps, Status: generated.GuideDraftStatus(value.Status), Revision: value.Revision, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt}
}
func guideStepToAPI(value domain.GuideStep) generated.GuideStep {
	return generated.GuideStep{Position: value.Position, ArtifactId: string(value.ArtifactID), Instruction: value.Instruction}
}
func guideSummaryToAPI(value domain.GuideSummary) generated.GuideSummary {
	return generated.GuideSummary{Id: string(value.ID), Title: value.Title, CurrentVersionNumber: value.CurrentVersionNumber, RepresentativeArtifactId: string(value.RepresentativeArtifactID), UpdatedAt: value.UpdatedAt}
}
func guideDetailToAPI(value domain.GuideDetail) generated.GuideDetail {
	steps := make([]generated.GuideStep, len(value.CurrentVersion.Steps))
	for index, step := range value.CurrentVersion.Steps {
		steps[index] = guideStepToAPI(step)
	}
	return generated.GuideDetail{Id: string(value.Guide.ID), UserId: string(value.Guide.UserID), Title: value.Guide.Title, CurrentVersionNumber: value.Guide.CurrentVersionNumber, Revision: value.Guide.Revision, CreatedAt: value.Guide.CreatedAt, UpdatedAt: value.Guide.UpdatedAt, RepresentativeArtifactId: string(value.RepresentativeArtifactID), CurrentVersion: generated.GuideVersion{VersionNumber: value.CurrentVersion.VersionNumber, Title: value.CurrentVersion.Title, CreatedBy: string(value.CurrentVersion.CreatedBy), CreatedAt: value.CurrentVersion.CreatedAt, Steps: steps}}
}
func guideRunToAPI(value domain.GuideRun) generated.GuideRun {
	var requestID *string
	if value.SupportRequestID != nil {
		id := string(*value.SupportRequestID)
		requestID = &id
	}
	return generated.GuideRun{Id: string(value.ID), GuideId: string(value.GuideID), GuideVersionNumber: value.GuideVersionNumber, UserId: string(value.UserID), Status: generated.GuideRunStatus(value.Status), CurrentStepNumber: value.CurrentStepNumber, SupportRequestId: requestID, StartedAt: value.StartedAt, CompletedAt: value.CompletedAt, PausedAt: value.PausedAt, UpdatedAt: value.UpdatedAt, Revision: value.Revision}
}
func supportRequestToAPI(value domain.SupportRequest) generated.SupportRequest {
	var sessionID *string
	if value.SupportSessionID != nil {
		id := string(*value.SupportSessionID)
		sessionID = &id
	}
	var guideContext *generated.GuideContext
	if value.GuideContext != nil {
		guideContext = &generated.GuideContext{GuideRunId: string(value.GuideContext.GuideRunID), GuideId: string(value.GuideContext.GuideID), GuideVersionNumber: value.GuideContext.GuideVersionNumber, StepNumber: value.GuideContext.StepNumber, GuideTitle: value.GuideContext.GuideTitle, StepInstruction: value.GuideContext.StepInstruction, StepArtifactId: string(value.GuideContext.StepArtifactID)}
	}
	result := generated.SupportRequest{Id: string(value.ID), UserId: string(value.UserID), FamilyId: string(value.FamilyID), InitialScreenshotArtifactId: string(value.InitialScreenshotArtifactID), Comment: value.Comment, Status: generated.SupportRequestStatus(value.Status), SupportSessionId: sessionID, GuideContext: guideContext, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt, Revision: value.Revision, AcknowledgedAt: value.AcknowledgedAt, EstimatedSupportAt: value.EstimatedSupportAt}
	if value.AcknowledgementKind != nil {
		kind := generated.SupportAcknowledgementKind(*value.AcknowledgementKind)
		result.AcknowledgementKind = &kind
	}
	return result
}
func supportSessionToAPI(value domain.SupportSession) generated.SupportSession {
	var decision *generated.GuideDecision
	if value.GuideDecision != nil {
		item := generated.GuideDecision(*value.GuideDecision)
		decision = &item
	}
	var endReason *generated.SupportSessionEndReason
	if value.EndReason != nil {
		item := generated.SupportSessionEndReason(*value.EndReason)
		endReason = &item
	}
	var consent *generated.Consent
	if value.Consent != nil {
		consent = &generated.Consent{Audio: value.Consent.Audio, ScreenShare: value.Consent.ScreenShare, PeriodicCapture: value.Consent.PeriodicCapture, TextVersion: generated.ConsentTextVersion(value.Consent.TextVersion)}
	}
	return generated.SupportSession{Id: string(value.ID), SupportRequestId: string(value.SupportRequestID), UserId: string(value.UserID), FamilyId: string(value.FamilyID), LivekitRoomName: value.LiveKitRoomName, Status: generated.SupportSessionStatus(value.Status), GuideDecision: decision, GuideMaterialBatchId: idToStringPointer(value.GuideMaterialBatchID), GuideGenerationJobId: idToStringPointer(value.GuideGenerationJobID), GuideDraftId: idToStringPointer(value.GuideDraftID), GuideId: idToStringPointer(value.GuideID), Consent: consent, ConsentedAt: value.ConsentedAt, StartedAt: value.StartedAt, EndedAt: value.EndedAt, EndReason: endReason, CreatedAt: value.CreatedAt, UpdatedAt: value.UpdatedAt, Revision: value.Revision}
}
func idToStringPointer(value *domain.ID) *string {
	if value == nil {
		return nil
	}
	result := string(*value)
	return &result
}

var _ GuideAPI = (*GuideHandler)(nil)
