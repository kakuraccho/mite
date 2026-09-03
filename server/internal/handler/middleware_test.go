package handler

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kakuraccho/mite/server/internal/config"
)

func TestRouterCORSAndAuthentication(t *testing.T) {
	t.Parallel()
	var logOutput bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logOutput, nil))
	cfg := config.Config{
		DemoUserToken:   "user-secret",
		DemoFamilyToken: "family-secret",
		ClientOrigins: map[string]struct{}{
			"mite-user://app": {},
		},
	}
	var protected http.Handler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	protected = NewAuthenticator(cfg.DemoUserToken, cfg.DemoFamilyToken).Middleware(protected)
	protected = CORS(cfg.ClientOrigins)(protected)
	protected = AccessLog(logger)(protected)
	protected = Recover(logger)(protected)
	protected = RequestID(protected)

	t.Run("allowed preflight", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodOptions, "/v1/support-requests", nil)
		request.Header.Set("Origin", "mite-user://app")
		response := httptest.NewRecorder()
		protected.ServeHTTP(response, request)
		if response.Code != http.StatusNoContent {
			t.Fatalf("status = %d, want %d", response.Code, http.StatusNoContent)
		}
		if got := response.Header().Get("Access-Control-Allow-Origin"); got != "mite-user://app" {
			t.Fatalf("Allow-Origin = %q", got)
		}
		if got := response.Header().Get("Access-Control-Expose-Headers"); got != "Retry-After" {
			t.Fatalf("Expose-Headers = %q, want Retry-After", got)
		}
	})

	t.Run("allowed error exposes retry after", func(t *testing.T) {
		retryHandler := CORS(cfg.ClientOrigins)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			WriteError(w, r, idempotencyInProgressError())
		}))
		request := httptest.NewRequest(http.MethodPost, "/v1/support-requests", nil)
		request.Header.Set("Origin", "mite-user://app")
		response := httptest.NewRecorder()
		retryHandler.ServeHTTP(response, request)
		if response.Code != http.StatusConflict {
			t.Fatalf("status = %d, want %d", response.Code, http.StatusConflict)
		}
		if got := response.Header().Get("Retry-After"); got != "1" {
			t.Fatalf("Retry-After = %q, want 1", got)
		}
		if got := response.Header().Get("Access-Control-Expose-Headers"); got != "Retry-After" {
			t.Fatalf("Expose-Headers = %q, want Retry-After", got)
		}
	})

	t.Run("disallowed origin", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/v1/support-requests", nil)
		request.Header.Set("Origin", "https://evil.example")
		response := httptest.NewRecorder()
		protected.ServeHTTP(response, request)
		if response.Code != http.StatusForbidden {
			t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
		}
		if !strings.Contains(response.Body.String(), `"code":"FORBIDDEN"`) {
			t.Fatalf("body = %s", response.Body.String())
		}
	})

	t.Run("missing token", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/v1/support-requests", nil)
		response := httptest.NewRecorder()
		protected.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want %d", response.Code, http.StatusUnauthorized)
		}
		if response.Header().Get(requestIDHeader) == "" {
			t.Fatal("request ID header is empty")
		}
	})

	if strings.Contains(logOutput.String(), "user-secret") || strings.Contains(logOutput.String(), "family-secret") {
		t.Fatal("log contains an authentication token")
	}
}

func TestWriteErrorSetsRetryAfter(t *testing.T) {
	t.Parallel()
	request := httptest.NewRequest(http.MethodPost, "/v1/support-requests", nil)
	request = request.WithContext(contextWithRequestID(request, "req_test"))
	response := httptest.NewRecorder()
	WriteError(response, request, idempotencyInProgressError())
	if response.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusConflict)
	}
	if got := response.Header().Get("Retry-After"); got != "1" {
		t.Fatalf("Retry-After = %q, want 1", got)
	}
}
