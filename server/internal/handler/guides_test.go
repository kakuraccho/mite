package handler

import (
	"bytes"
	"context"
	"mime/multipart"
	"testing"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/generated"
	"github.com/kakuraccho/mite/server/internal/service"
)

type guideUseCasesStub struct {
	GuideUseCases
	batchCommand    service.CreateGuideMaterialBatchCommand
	batchResult     service.GuideMaterialBatchCreated
	batchErr        error
	materialCommand service.CreateGuideMaterialCommand
	materialResult  service.GuideMaterialCreated
	materialStatus  int
	materialErr     error
}

func (s *guideUseCasesStub) CreateGuideMaterialBatch(_ context.Context, command service.CreateGuideMaterialBatchCommand) (service.GuideMaterialBatchCreated, error) {
	s.batchCommand = command
	return s.batchResult, s.batchErr
}

func (s *guideUseCasesStub) CreateGuideMaterial(_ context.Context, command service.CreateGuideMaterialCommand) (service.GuideMaterialCreated, int, error) {
	s.materialCommand = command
	return s.materialResult, s.materialStatus, s.materialErr
}

func guideHandlerContext() context.Context {
	ctx := context.WithValue(context.Background(), requestIDContextKey, "req_guide_test")
	return context.WithValue(ctx, actorContextKey, domain.Actor{ID: "user_demo", Role: domain.RoleUser})
}

func TestGuideHandlerCreateMaterialBatch(t *testing.T) {
	now := time.Date(2026, 9, 4, 1, 2, 3, 0, time.UTC)
	stub := &guideUseCasesStub{batchResult: service.GuideMaterialBatchCreated{
		Batch:          domain.GuideMaterialBatch{ID: "batch_test", SupportSessionID: "session_test", Status: domain.GuideMaterialBatchUploading, CaptureIntervalSeconds: 5, ExpectedItemCount: 2, CapturedFrom: now, CapturedTo: now.Add(5 * time.Second), CreatedAt: now, UpdatedAt: now, Revision: 1},
		SupportSession: domain.SupportSession{ID: "session_test", UserID: "user_demo", FamilyID: "family_demo", Status: domain.SupportSessionGeneratingGuide, CreatedAt: now, UpdatedAt: now, Revision: 2},
	}}
	handler := NewGuideHandler(stub)
	body := generated.CreateGuideMaterialBatchJSONRequestBody{ExpectedSessionRevision: 1, CaptureIntervalSeconds: 5, ExpectedItemCount: 2, CapturedFrom: &now, CapturedTo: timePointer(now.Add(5 * time.Second))}
	response, err := handler.CreateGuideMaterialBatch(guideHandlerContext(), generated.CreateGuideMaterialBatchRequestObject{Id: "session_test", Params: generated.CreateGuideMaterialBatchParams{IdempotencyKey: "idem-batch"}, Body: &body})
	if err != nil {
		t.Fatalf("CreateGuideMaterialBatch: %v", err)
	}
	if _, ok := response.(generated.CreateGuideMaterialBatch201JSONResponse); !ok {
		t.Fatalf("unexpected response type %T", response)
	}
	if stub.batchCommand.Meta.Actor.ID != "user_demo" || stub.batchCommand.Meta.RequestID != "req_guide_test" || stub.batchCommand.ExpectedItemCount != 2 {
		t.Fatalf("unexpected service command: %+v", stub.batchCommand)
	}

	stub.batchErr = domain.NewError(domain.CodeIdempotencyRequestInProgress, "同じリクエストを処理中")
	response, err = handler.CreateGuideMaterialBatch(guideHandlerContext(), generated.CreateGuideMaterialBatchRequestObject{Id: "session_test", Params: generated.CreateGuideMaterialBatchParams{IdempotencyKey: "idem-batch"}, Body: &body})
	if err != nil {
		t.Fatalf("CreateGuideMaterialBatch conflict: %v", err)
	}
	conflict, ok := response.(generated.CreateGuideMaterialBatch409JSONResponse)
	if !ok || conflict.Headers.RetryAfter == nil || *conflict.Headers.RetryAfter != 1 {
		t.Fatalf("expected 409 with Retry-After, got %#v", response)
	}
}

func TestGuideHandlerCreateMaterialMultipart(t *testing.T) {
	now := time.Date(2026, 9, 4, 1, 2, 3, 0, time.UTC)
	stub := &guideUseCasesStub{materialStatus: 201, materialResult: service.GuideMaterialCreated{
		Material: domain.GuideMaterial{ID: "material_test", BatchID: "batch_test", ClientCaptureID: "capture_test", ArtifactID: "artifact_test", Sequence: 1, CapturedAt: now, CreatedAt: now},
		Batch:    domain.GuideMaterialBatch{ID: "batch_test", SupportSessionID: "session_test", Status: domain.GuideMaterialBatchUploading, CaptureIntervalSeconds: 5, ExpectedItemCount: 1, ReceivedItemCount: 1, CapturedFrom: now, CapturedTo: now, CreatedAt: now, UpdatedAt: now, Revision: 2},
	}}
	handler := NewGuideHandler(stub)
	reader := newGuideMultipartReader(t, []multipartField{{"clientCaptureId", "capture_test"}, {"sequence", "1"}, {"capturedAt", now.Format(time.RFC3339)}, {"file", "jpeg-bytes"}})
	response, err := handler.CreateGuideMaterial(guideHandlerContext(), generated.CreateGuideMaterialRequestObject{Id: "batch_test", Params: generated.CreateGuideMaterialParams{IdempotencyKey: "idem-material"}, Body: reader})
	if err != nil {
		t.Fatalf("CreateGuideMaterial: %v", err)
	}
	if _, ok := response.(generated.CreateGuideMaterial201JSONResponse); !ok {
		t.Fatalf("unexpected response type %T", response)
	}
	if stub.materialCommand.ClientCaptureID != "capture_test" || stub.materialCommand.Sequence != 1 || !bytes.Equal(stub.materialCommand.JPEG, []byte("jpeg-bytes")) {
		t.Fatalf("unexpected multipart command: %+v", stub.materialCommand)
	}
}

func TestReadGuideMaterialMultipartRejectsDuplicateAndOversize(t *testing.T) {
	now := time.Date(2026, 9, 4, 1, 2, 3, 0, time.UTC).Format(time.RFC3339)
	duplicate := newGuideMultipartReader(t, []multipartField{{"clientCaptureId", "capture_a"}, {"clientCaptureId", "capture_b"}, {"sequence", "1"}, {"capturedAt", now}, {"file", "x"}})
	if _, err := readGuideMaterialMultipart(duplicate); errorCode(err) != domain.CodeValidationError {
		t.Fatalf("expected duplicate validation error, got %v", err)
	}
	oversize := newGuideMultipartReader(t, []multipartField{{"clientCaptureId", "capture_a"}, {"sequence", "1"}, {"capturedAt", now}, {"file", string(bytes.Repeat([]byte{'x'}, int(domain.MaxArtifactBytes)+1))}})
	if _, err := readGuideMaterialMultipart(oversize); errorCode(err) != domain.CodeFileTooLarge {
		t.Fatalf("expected payload too large, got %v", err)
	}
}

type multipartField struct{ name, value string }

func newGuideMultipartReader(t *testing.T, fields []multipartField) *multipart.Reader {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, field := range fields {
		part, err := writer.CreateFormField(field.name)
		if err != nil {
			t.Fatalf("create multipart field: %v", err)
		}
		if _, err := part.Write([]byte(field.value)); err != nil {
			t.Fatalf("write multipart field: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart writer: %v", err)
	}
	return multipart.NewReader(bytes.NewReader(body.Bytes()), writer.Boundary())
}

func timePointer(value time.Time) *time.Time { return &value }

func errorCode(err error) domain.ErrorCode {
	code, _ := domain.ErrorCodeOf(err)
	return code
}
