package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/net/websocket"

	"github.com/kakuraccho/mite/server/internal/config"
	"github.com/kakuraccho/mite/server/internal/domain"
)

const (
	e2eUserToken   = "e2e-user-token"
	e2eFamilyToken = "e2e-family-token"
	e2eOrigin      = "http://client.example"
)

type e2eGuideGenerator struct{}

func (*e2eGuideGenerator) Generate(_ context.Context, input domain.GuideGenerationInput) ([]domain.GeneratedGuide, error) {
	if len(input.Images) < 3 {
		return nil, errors.New("E2E generator requires the initial image and two materials")
	}
	return []domain.GeneratedGuide{{
		Title: "接続確認ガイド",
		Steps: []domain.GeneratedGuideStep{
			{SourceArtifactID: input.Images[0].ArtifactID, Instruction: "最初の画面を確認する"},
			{SourceArtifactID: input.Images[1].ArtifactID, Instruction: "青いボタンを押す"},
		},
	}}, nil
}

func TestServerRuntimeE2E(t *testing.T) {
	databaseURL := os.Getenv("MITE_E2E_DATABASE_URL")
	supabaseURL := os.Getenv("MITE_E2E_SUPABASE_URL")
	supabaseSecret := os.Getenv("MITE_E2E_SUPABASE_SECRET_KEY")
	if databaseURL == "" || supabaseURL == "" || supabaseSecret == "" {
		t.Skip("MITE_E2E_DATABASE_URL and Supabase E2E variables are not set")
	}

	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	cfg := config.Config{
		DatabaseURL:           databaseURL,
		SupabaseURL:           supabaseURL,
		SupabaseSecretKey:     supabaseSecret,
		SupabaseStorageBucket: "mite-artifacts",
		DemoUserToken:         e2eUserToken,
		DemoFamilyToken:       e2eFamilyToken,
		LiveKitURL:            "wss://livekit.invalid",
		LiveKitAPIKey:         "e2e-livekit-key",
		LiveKitAPISecret:      "e2e-livekit-secret",
		AIProvider:            "gemini",
		AIBaseURL:             "https://generativelanguage.googleapis.com/v1beta",
		GeminiAPIKey:          "unused-e2e-key",
		AIModel:               "gemini-3.8-flash",
		AIPromptVersion:       "v2",
		ClientOrigins:         map[string]struct{}{e2eOrigin: {}},
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	runtime, err := newServerRuntime(cfg, logger, pool, &e2eGuideGenerator{})
	if err != nil {
		t.Fatal(err)
	}
	workerContext, cancelWorkers := context.WithCancel(context.Background())
	workerErrors := make(chan error, len(runtime.workers))
	for _, runWorker := range runtime.workers {
		runWorker := runWorker
		go func() { workerErrors <- runWorker(workerContext) }()
	}
	t.Cleanup(func() {
		cancelWorkers()
		deadline := time.After(5 * time.Second)
		for range runtime.workers {
			select {
			case workerErr := <-workerErrors:
				if workerErr != nil && !errors.Is(workerErr, context.Canceled) {
					t.Errorf("worker shutdown error: %v", workerErr)
				}
			case <-deadline:
				t.Error("worker shutdown timed out")
				return
			}
		}
	})

	httpServer := httptest.NewServer(runtime.handler)
	defer httpServer.Close()
	client := &e2eAPIClient{baseURL: httpServer.URL, client: httpServer.Client()}
	keyPrefix := fmt.Sprintf("e2e-%d-", time.Now().UnixNano())

	t.Run("authentication and CORS", func(t *testing.T) {
		response := client.request(t, http.MethodGet, "/v1/support-requests", "", "", nil)
		assertStatus(t, response, http.StatusUnauthorized)
		response = client.request(t, http.MethodGet, "/v1/support-requests", e2eUserToken, "https://invalid.example", nil)
		assertStatus(t, response, http.StatusForbidden)
		response = client.request(t, http.MethodGet, "/v1/support-requests", e2eUserToken, e2eOrigin, nil)
		assertStatus(t, response, http.StatusOK)
		if got := response.Header.Get("Access-Control-Allow-Origin"); got != e2eOrigin {
			t.Fatalf("Access-Control-Allow-Origin = %q", got)
		}
		if got := response.Header.Get("Access-Control-Expose-Headers"); got != "Retry-After" {
			t.Fatalf("Access-Control-Expose-Headers = %q", got)
		}
	})

	websocketURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/v1/events"
	connection, err := websocket.Dial(websocketURL, "", e2eOrigin)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := connection.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := websocket.JSON.Send(connection, map[string]string{"type": "authenticate", "token": e2eFamilyToken}); err != nil {
		t.Fatal(err)
	}
	var authenticated map[string]any
	if err := websocket.JSON.Receive(connection, &authenticated); err != nil {
		t.Fatal(err)
	}
	if authenticated["type"] != "authenticated" {
		t.Fatalf("WebSocket authentication response = %#v", authenticated)
	}

	now := time.Now().UTC().Truncate(time.Second)
	initialJPEG := e2eJPEG(t, color.RGBA{R: 30, G: 90, B: 180, A: 255})
	initialArtifact := client.multipart(t, "/v1/artifacts", e2eUserToken, keyPrefix+"initial", map[string]string{
		"purpose": "REQUEST_SCREENSHOT", "capturedAt": now.Format(time.RFC3339),
	}, initialJPEG, http.StatusCreated)
	initialArtifactID := jsonString(t, initialArtifact.body, "data", "id")
	initialArtifactSHA256 := jsonString(t, initialArtifact.body, "data", "sha256")
	artifactCount, artifactRevision := artifactState(t, pool, initialArtifactSHA256, now)
	if artifactCount != 1 || artifactRevision != 1 {
		t.Fatalf("artifact state after first request = count %d, revision %d; want count 1, revision 1", artifactCount, artifactRevision)
	}
	replayedArtifact := client.multipart(t, "/v1/artifacts", e2eUserToken, keyPrefix+"initial", map[string]string{
		"purpose": "REQUEST_SCREENSHOT", "capturedAt": now.Format(time.RFC3339),
	}, initialJPEG, http.StatusCreated)
	assertIdempotentReplay(t, initialArtifact, replayedArtifact)
	replayedArtifactCount, replayedArtifactRevision := artifactState(t, pool, initialArtifactSHA256, now)
	if replayedArtifactCount != artifactCount || replayedArtifactRevision != artifactRevision {
		t.Fatalf(
			"artifact state changed on replay: first count/revision=%d/%d, replay count/revision=%d/%d",
			artifactCount, artifactRevision, replayedArtifactCount, replayedArtifactRevision,
		)
	}
	content := client.request(t, http.MethodGet, "/v1/artifacts/"+initialArtifactID+"/content", e2eFamilyToken, "", nil)
	assertStatus(t, content, http.StatusOK)
	if content.Header.Get("Content-Type") != "image/jpeg" || content.Header.Get("Cache-Control") != "private, no-store" {
		t.Fatalf("artifact headers = %#v", content.Header)
	}
	if !bytes.Equal(content.rawBody, initialJPEG) {
		t.Fatal("artifact content differs from upload")
	}

	createRequestBody := map[string]any{"initialScreenshotArtifactId": initialArtifactID, "comment": "E2E support request"}
	createdRequest := client.json(t, http.MethodPost, "/v1/support-requests", e2eUserToken, keyPrefix+"request", createRequestBody, http.StatusCreated)
	requestID := jsonString(t, createdRequest.body, "data", "id")
	requestCount, requestRevision := supportRequestState(t, pool, initialArtifactID, "E2E support request")
	if requestCount != 1 || requestRevision != 1 {
		t.Fatalf("support request state after first request = count %d, revision %d; want count 1, revision 1", requestCount, requestRevision)
	}
	replayedRequest := client.json(t, http.MethodPost, "/v1/support-requests", e2eUserToken, keyPrefix+"request", createRequestBody, http.StatusCreated)
	assertIdempotentReplay(t, createdRequest, replayedRequest)
	replayedRequestCount, replayedRequestRevision := supportRequestState(t, pool, initialArtifactID, "E2E support request")
	if replayedRequestCount != requestCount || replayedRequestRevision != requestRevision {
		t.Fatalf(
			"support request state changed on replay: first count/revision=%d/%d, replay count/revision=%d/%d",
			requestCount, requestRevision, replayedRequestCount, replayedRequestRevision,
		)
	}
	var event map[string]any
	if err := websocket.JSON.Receive(connection, &event); err != nil {
		t.Fatal(err)
	}
	if event["type"] != "supportRequest.created" {
		t.Fatalf("WebSocket event = %#v", event)
	}
	client.json(t, http.MethodGet, "/v1/support-requests?status=PENDING", e2eFamilyToken, "", nil, http.StatusOK)
	client.json(t, http.MethodGet, "/v1/support-requests/"+requestID, e2eFamilyToken, "", nil, http.StatusOK)

	called := client.json(t, http.MethodPost, "/v1/support-requests/"+requestID+"/call", e2eFamilyToken, keyPrefix+"call", map[string]any{"expectedRequestRevision": 1}, http.StatusCreated)
	replayedCall := client.json(t, http.MethodPost, "/v1/support-requests/"+requestID+"/call", e2eFamilyToken, keyPrefix+"call", map[string]any{"expectedRequestRevision": 1}, http.StatusCreated)
	assertIdempotentReplay(t, called, replayedCall)
	sessionID := jsonString(t, called.body, "data", "supportSession", "id")
	client.json(t, http.MethodGet, "/v1/support-sessions/"+sessionID, e2eUserToken, "", nil, http.StatusOK)
	client.json(t, http.MethodPost, "/v1/support-sessions/"+sessionID+"/accept", e2eUserToken, keyPrefix+"accept", map[string]any{
		"expectedSessionRevision": 1,
		"consent":                 map[string]any{"audio": true, "screenShare": true, "periodicCapture": true, "textVersion": "v1"},
	}, http.StatusOK)
	client.json(t, http.MethodPost, "/v1/support-sessions/"+sessionID+"/livekit-token", e2eFamilyToken, "", map[string]any{}, http.StatusOK)
	conflict := client.json(t, http.MethodPost, "/v1/support-sessions/"+sessionID+"/resolve", e2eFamilyToken, keyPrefix+"conflict", map[string]any{
		"expectedSessionRevision": 1, "guideDecision": "CREATE",
	}, http.StatusConflict)
	if code := jsonString(t, conflict.body, "error", "code"); code != "REVISION_CONFLICT" {
		t.Fatalf("conflict code = %q", code)
	}
	resolved := client.json(t, http.MethodPost, "/v1/support-sessions/"+sessionID+"/resolve", e2eFamilyToken, keyPrefix+"resolve", map[string]any{
		"expectedSessionRevision": 2, "guideDecision": "CREATE",
	}, http.StatusOK)
	replayedResolve := client.json(t, http.MethodPost, "/v1/support-sessions/"+sessionID+"/resolve", e2eFamilyToken, keyPrefix+"resolve", map[string]any{
		"expectedSessionRevision": 2, "guideDecision": "CREATE",
	}, http.StatusOK)
	assertIdempotentReplay(t, resolved, replayedResolve)

	batchCreated := client.json(t, http.MethodPost, "/v1/support-sessions/"+sessionID+"/guide-material-batches", e2eUserToken, keyPrefix+"batch", map[string]any{
		"expectedSessionRevision": 3,
		"captureIntervalSeconds":  5,
		"capturedFrom":            now.Format(time.RFC3339),
		"capturedTo":              now.Add(5 * time.Second).Format(time.RFC3339),
		"expectedItemCount":       2,
	}, http.StatusCreated)
	batchID := jsonString(t, batchCreated.body, "data", "batch", "id")
	materialOne := client.multipart(t, "/v1/guide-material-batches/"+batchID+"/materials", e2eUserToken, keyPrefix+"material-1", map[string]string{
		"clientCaptureId": "capture-1", "sequence": "1", "capturedAt": now.Format(time.RFC3339),
	}, e2eJPEG(t, color.RGBA{R: 50, G: 160, B: 80, A: 255}), http.StatusCreated)
	materialTwo := client.multipart(t, "/v1/guide-material-batches/"+batchID+"/materials", e2eUserToken, keyPrefix+"material-2", map[string]string{
		"clientCaptureId": "capture-2", "sequence": "2", "capturedAt": now.Add(5 * time.Second).Format(time.RFC3339),
	}, e2eJPEG(t, color.RGBA{R: 180, G: 70, B: 40, A: 255}), http.StatusCreated)
	unusedArtifactID := jsonString(t, materialTwo.body, "data", "material", "artifactId")
	if jsonNumber(t, materialOne.body, "data", "batch", "revision") != 2 || jsonNumber(t, materialTwo.body, "data", "batch", "revision") != 3 {
		t.Fatal("material upload revisions did not increase")
	}
	client.json(t, http.MethodGet, "/v1/guide-material-batches/"+batchID, e2eFamilyToken, "", nil, http.StatusOK)
	completed := client.json(t, http.MethodPost, "/v1/guide-material-batches/"+batchID+"/complete", e2eUserToken, keyPrefix+"complete", map[string]any{
		"expectedBatchRevision": 3, "expectedItemCount": 2,
	}, http.StatusAccepted)
	replayedComplete := client.json(t, http.MethodPost, "/v1/guide-material-batches/"+batchID+"/complete", e2eUserToken, keyPrefix+"complete", map[string]any{
		"expectedBatchRevision": 3, "expectedItemCount": 2,
	}, http.StatusAccepted)
	assertIdempotentReplay(t, completed, replayedComplete)
	jobID := jsonString(t, completed.body, "data", "job", "id")

	var job e2eResponse
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		job = client.json(t, http.MethodGet, "/v1/guide-generation-jobs/"+jobID, e2eFamilyToken, "", nil, http.StatusOK)
		status := jsonString(t, job.body, "data", "status")
		if status == "SUCCEEDED" {
			break
		}
		if status == "FAILED" {
			t.Fatalf("guide job failed: %#v", job.body)
		}
		time.Sleep(100 * time.Millisecond)
	}
	if jsonString(t, job.body, "data", "status") != "SUCCEEDED" {
		t.Fatalf("guide job did not complete: %#v", job.body)
	}
	draftID := jsonString(t, job.body, "data", "guideDraftId")
	draft := client.json(t, http.MethodGet, "/v1/guide-drafts/"+draftID, e2eUserToken, "", nil, http.StatusOK)
	draftData := jsonMap(t, draft.body, "data")
	updatedDraft := client.json(t, http.MethodPatch, "/v1/guide-drafts/"+draftID, e2eFamilyToken, "", map[string]any{
		"expectedRevision": jsonNumber(t, draft.body, "data", "revision"),
		"title":            draftData["title"],
		"steps":            draftData["steps"],
	}, http.StatusOK)
	saved := client.json(t, http.MethodPost, "/v1/guide-drafts/"+draftID+"/save", e2eFamilyToken, keyPrefix+"save", map[string]any{
		"expectedRevision": jsonNumber(t, updatedDraft.body, "data", "revision"),
	}, http.StatusCreated)
	replayedSave := client.json(t, http.MethodPost, "/v1/guide-drafts/"+draftID+"/save", e2eFamilyToken, keyPrefix+"save", map[string]any{
		"expectedRevision": jsonNumber(t, updatedDraft.body, "data", "revision"),
	}, http.StatusCreated)
	assertIdempotentReplay(t, saved, replayedSave)
	guideID := jsonString(t, saved.body, "data", "guide", "id")
	client.json(t, http.MethodGet, "/v1/guides", e2eUserToken, "", nil, http.StatusOK)
	client.json(t, http.MethodGet, "/v1/guides/"+guideID, e2eUserToken, "", nil, http.StatusOK)
	client.json(t, http.MethodGet, "/v1/artifacts/"+unusedArtifactID+"/content", e2eFamilyToken, "", nil, http.StatusNotFound)
	artifactDeleted := false
	cleanupDeadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(cleanupDeadline) {
		var exists bool
		if err := pool.QueryRow(context.Background(), "SELECT EXISTS (SELECT 1 FROM artifacts WHERE id = $1)", unusedArtifactID).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			artifactDeleted = true
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !artifactDeleted {
		t.Fatal("artifact deletion worker did not remove unused material")
	}

	run := client.json(t, http.MethodPost, "/v1/guide-runs", e2eUserToken, keyPrefix+"run", map[string]any{"guideId": guideID}, http.StatusCreated)
	runID := jsonString(t, run.body, "data", "id")
	client.json(t, http.MethodGet, "/v1/guide-runs/"+runID, e2eUserToken, "", nil, http.StatusOK)
	moved := client.json(t, http.MethodPatch, "/v1/guide-runs/"+runID, e2eUserToken, "", map[string]any{
		"expectedRevision": 1, "action": "NEXT",
	}, http.StatusOK)
	client.json(t, http.MethodPatch, "/v1/guide-runs/"+runID, e2eUserToken, "", map[string]any{
		"expectedRevision": 1, "action": "PREVIOUS",
	}, http.StatusConflict)
	client.json(t, http.MethodPost, "/v1/guide-runs/"+runID+"/complete", e2eUserToken, keyPrefix+"run-complete", map[string]any{
		"expectedRevision": jsonNumber(t, moved.body, "data", "revision"),
	}, http.StatusOK)

	secondRun := client.json(t, http.MethodPost, "/v1/guide-runs", e2eUserToken, keyPrefix+"run-support", map[string]any{"guideId": guideID}, http.StatusCreated)
	secondRunID := jsonString(t, secondRun.body, "data", "id")
	secondScreenshot := client.multipart(t, "/v1/artifacts", e2eUserToken, keyPrefix+"second-screenshot", map[string]string{
		"purpose": "REQUEST_SCREENSHOT", "capturedAt": now.Add(time.Minute).Format(time.RFC3339),
	}, initialJPEG, http.StatusCreated)
	secondScreenshotID := jsonString(t, secondScreenshot.body, "data", "id")
	paused := client.json(t, http.MethodPost, "/v1/guide-runs/"+secondRunID+"/support-request", e2eUserToken, keyPrefix+"run-request", map[string]any{
		"expectedRevision": 1, "initialScreenshotArtifactId": secondScreenshotID, "comment": "ガイドから相談",
	}, http.StatusCreated)
	if jsonString(t, paused.body, "data", "guideRun", "status") != "PAUSED_FOR_SUPPORT" {
		t.Fatalf("guide run was not paused: %#v", paused.body)
	}
}

type e2eResponse struct {
	Status  int
	Header  http.Header
	rawBody []byte
	body    map[string]any
}

type e2eAPIClient struct {
	baseURL string
	client  *http.Client
}

func (client *e2eAPIClient) json(t *testing.T, method, path, token, key string, body any, wantStatus int) e2eResponse {
	t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, client.baseURL+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	request.Header.Set("Origin", e2eOrigin)
	if key != "" {
		request.Header.Set("Idempotency-Key", key)
	}
	response := client.do(t, request)
	assertStatus(t, response, wantStatus)
	return response
}

func (client *e2eAPIClient) multipart(t *testing.T, path, token, key string, fields map[string]string, file []byte, wantStatus int) e2eResponse {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for name, value := range fields {
		if err := writer.WriteField(name, value); err != nil {
			t.Fatal(err)
		}
	}
	part, err := writer.CreateFormFile("file", "capture.jpg")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(file); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, client.baseURL+path, &body)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Origin", e2eOrigin)
	request.Header.Set("Idempotency-Key", key)
	response := client.do(t, request)
	assertStatus(t, response, wantStatus)
	return response
}

func (client *e2eAPIClient) request(t *testing.T, method, path, token, origin string, body io.Reader) e2eResponse {
	t.Helper()
	request, err := http.NewRequest(method, client.baseURL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	return client.do(t, request)
}

func (client *e2eAPIClient) do(t *testing.T, request *http.Request) e2eResponse {
	t.Helper()
	response, err := client.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 12*1024*1024))
	if err != nil {
		t.Fatal(err)
	}
	result := e2eResponse{Status: response.StatusCode, Header: response.Header.Clone(), rawBody: body}
	if strings.Contains(response.Header.Get("Content-Type"), "application/json") {
		if err := json.Unmarshal(body, &result.body); err != nil {
			t.Fatalf("decode status %d response: %v; body=%s", response.StatusCode, err, body)
		}
	}
	return result
}

func assertStatus(t *testing.T, response e2eResponse, want int) {
	t.Helper()
	if response.Status != want {
		t.Fatalf("status = %d, want %d; body=%s", response.Status, want, response.rawBody)
	}
}

func assertIdempotentReplay(t *testing.T, first, replay e2eResponse) {
	t.Helper()
	if replay.Status != first.Status {
		t.Fatalf("idempotency replay status = %d, want first status %d", replay.Status, first.Status)
	}
	if !bytes.Equal(replay.rawBody, first.rawBody) {
		t.Fatalf("idempotency replay raw body differs:\nfirst=%q\nreplay=%q", first.rawBody, replay.rawBody)
	}
}

func artifactState(t *testing.T, pool *pgxpool.Pool, sha256 string, capturedAt time.Time) (int, int64) {
	t.Helper()
	var count int
	var revision int64
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*), max(revision)
		FROM artifacts
		WHERE owner_user_id = 'user_demo'
		  AND purpose = 'REQUEST_SCREENSHOT'
		  AND sha256 = $1
		  AND captured_at = $2
	`, sha256, capturedAt).Scan(&count, &revision); err != nil {
		t.Fatal(err)
	}
	return count, revision
}

func supportRequestState(t *testing.T, pool *pgxpool.Pool, artifactID, comment string) (int, int64) {
	t.Helper()
	var count int
	var revision int64
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*), max(revision)
		FROM support_requests
		WHERE user_id = 'user_demo'
		  AND initial_screenshot_artifact_id = $1
		  AND comment = $2
	`, artifactID, comment).Scan(&count, &revision); err != nil {
		t.Fatal(err)
	}
	return count, revision
}

func jsonMap(t *testing.T, value map[string]any, path ...string) map[string]any {
	t.Helper()
	current := value
	for index, name := range path {
		next, ok := current[name].(map[string]any)
		if !ok {
			t.Fatalf("JSON path %v is not an object in %#v", path[:index+1], value)
		}
		current = next
	}
	return current
}

func jsonString(t *testing.T, value map[string]any, path ...string) string {
	t.Helper()
	parent := jsonMap(t, value, path[:len(path)-1]...)
	result, ok := parent[path[len(path)-1]].(string)
	if !ok || result == "" {
		t.Fatalf("JSON path %v is not a non-empty string in %#v", path, value)
	}
	return result
}

func jsonNumber(t *testing.T, value map[string]any, path ...string) int64 {
	t.Helper()
	parent := jsonMap(t, value, path[:len(path)-1]...)
	result, ok := parent[path[len(path)-1]].(float64)
	if !ok {
		t.Fatalf("JSON path %v is not a number in %#v", path, value)
	}
	return int64(result)
}

func e2eJPEG(t *testing.T, fill color.RGBA) []byte {
	t.Helper()
	value := image.NewRGBA(image.Rect(0, 0, 32, 32))
	for y := 0; y < 32; y++ {
		for x := 0; x < 32; x++ {
			value.SetRGBA(x, y, fill)
		}
	}
	var encoded bytes.Buffer
	if err := jpeg.Encode(&encoded, value, &jpeg.Options{Quality: 80}); err != nil {
		t.Fatal(err)
	}
	return encoded.Bytes()
}
