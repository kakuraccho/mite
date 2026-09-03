package handler

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"testing"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/generated"
	"github.com/kakuraccho/mite/server/internal/repository"
	"github.com/kakuraccho/mite/server/internal/service"
)

func TestArtifactSupportHandlerReturnsPrivateJPEG(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	artifact := domain.Artifact{
		ID: "art_1", OwnerUserID: "user_demo", Purpose: domain.ArtifactPurposeRequestScreenshot,
		MimeType: "image/jpeg", StorageKey: "user_demo/art_1.jpg", SHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ByteSize: 4, Width: 1, Height: 1, CapturedAt: now, CreatedAt: now, UpdatedAt: now, Revision: 1,
	}
	store := &handlerTestStore{pair: domain.UserPair{UserID: "user_demo", FamilyID: "family_demo"}, artifact: artifact}
	storage := &handlerTestStorage{content: []byte("jpeg")}
	service := service.NewArtifactSupportService(store, storage, nil, slog.New(slog.NewTextHandler(io.Discard, nil)), service.ArtifactSupportServiceOptions{})
	handler := NewArtifactSupportHandler(service)
	ctx := context.WithValue(context.Background(), actorContextKey, domain.Actor{ID: "family_demo", Role: domain.RoleFamily})
	ctx = context.WithValue(ctx, requestIDContextKey, "req_1")

	response, err := handler.GetArtifactContent(ctx, generated.GetArtifactContentRequestObject{Id: "art_1"})
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	if err := response.VisitGetArtifactContentResponse(recorder); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != http.StatusOK || recorder.Header().Get("Content-Type") != "image/jpeg" ||
		recorder.Header().Get("Cache-Control") != "private, no-store" || recorder.Header().Get("Content-Length") != "4" {
		t.Fatalf("response = %d headers=%v", recorder.Code, recorder.Header())
	}
	if recorder.Body.String() != "jpeg" {
		t.Fatalf("body = %q", recorder.Body.String())
	}
}

func TestParseCreateArtifactMultipart(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 9, 4, 10, 0, 0, 0, time.UTC)
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("purpose", "REQUEST_SCREENSHOT"); err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteField("capturedAt", now.Format(time.RFC3339)); err != nil {
		t.Fatal(err)
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", `form-data; name="file"; filename="screen.jpg"`)
	header.Set("Content-Type", "application/octet-stream")
	part, err := writer.CreatePart(header)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = part.Write([]byte("content is validated in service"))
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}

	input, err := parseCreateArtifactMultipart(multipart.NewReader(bytes.NewReader(body.Bytes()), writer.Boundary()))
	if err != nil {
		t.Fatalf("parseCreateArtifactMultipart() error = %v", err)
	}
	if input.Purpose != domain.ArtifactPurposeRequestScreenshot || !input.CapturedAt.Equal(now) {
		t.Fatalf("input = %+v", input)
	}
	data, _ := io.ReadAll(input.File)
	if string(data) != "content is validated in service" {
		t.Fatalf("file = %q", data)
	}
}

func TestParseCreateArtifactMultipartRejectsUnknownAndDuplicateFields(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		fields [][2]string
	}{
		{name: "unknown", fields: [][2]string{{"purpose", "REQUEST_SCREENSHOT"}, {"capturedAt", "2026-09-04T10:00:00Z"}, {"file", "x"}, {"extra", "x"}}},
		{name: "duplicate", fields: [][2]string{{"purpose", "REQUEST_SCREENSHOT"}, {"purpose", "REQUEST_SCREENSHOT"}, {"capturedAt", "2026-09-04T10:00:00Z"}, {"file", "x"}}},
		{name: "missing", fields: [][2]string{{"purpose", "REQUEST_SCREENSHOT"}, {"capturedAt", "2026-09-04T10:00:00Z"}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var body bytes.Buffer
			writer := multipart.NewWriter(&body)
			for _, field := range test.fields {
				if err := writer.WriteField(field[0], field[1]); err != nil {
					t.Fatal(err)
				}
			}
			_ = writer.Close()
			_, err := parseCreateArtifactMultipart(multipart.NewReader(bytes.NewReader(body.Bytes()), writer.Boundary()))
			code, ok := domain.ErrorCodeOf(err)
			if !ok || code != domain.CodeValidationError {
				t.Fatalf("error = %v, code=%q", err, code)
			}
		})
	}
}

func TestRawArtifactSupportErrorSetsRetryAfter(t *testing.T) {
	t.Parallel()
	ctx := context.WithValue(context.Background(), requestIDContextKey, "req_retry")
	response := newRawErrorResponse(ctx, domain.NewError(domain.CodeIdempotencyRequestInProgress, "処理中"))
	recorder := httptest.NewRecorder()
	if err := response.VisitCreateArtifactResponse(recorder); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != http.StatusConflict || recorder.Header().Get("Retry-After") != "1" {
		t.Fatalf("response = %d headers=%v", recorder.Code, recorder.Header())
	}
	if !bytes.Contains(recorder.Body.Bytes(), []byte(`"requestId":"req_retry"`)) {
		t.Fatalf("body = %s", recorder.Body.Bytes())
	}
}

type handlerTestStore struct {
	repository.ArtifactSupportStore
	pair     domain.UserPair
	artifact domain.Artifact
}

func (s *handlerTestStore) GetUserPair(context.Context, domain.ID) (domain.UserPair, bool, error) {
	return s.pair, true, nil
}

func (s *handlerTestStore) GetAvailableArtifact(_ context.Context, id domain.ID) (domain.Artifact, bool, error) {
	return s.artifact, id == s.artifact.ID, nil
}

type handlerTestStorage struct {
	repository.ObjectStorage
	content []byte
}

func (s *handlerTestStorage) Get(context.Context, string) (repository.StoredObject, error) {
	return repository.StoredObject{
		Body: io.NopCloser(bytes.NewReader(s.content)), ContentType: "image/jpeg", Size: int64(len(s.content)),
	}, nil
}
