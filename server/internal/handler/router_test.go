package handler

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/kakuraccho/mite/server/internal/config"
	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/generated"
)

func TestNewRouterCORSPreflight(t *testing.T) {
	t.Parallel()
	cfg := config.Config{
		DemoUserToken: "user-token", DemoFamilyToken: "family-token",
		ClientOrigins: map[string]struct{}{"http://127.0.0.1:5173": {}, "mite-user://app": {}},
	}
	router := NewRouter(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), API{})
	for _, test := range []struct {
		name   string
		origin string
		status int
	}{
		{"development origin", "http://127.0.0.1:5173", http.StatusNoContent},
		{"packaged origin", "mite-user://app", http.StatusNoContent},
		{"unknown origin", "https://denied.example", http.StatusForbidden},
		{"different port", "http://127.0.0.1:5174", http.StatusForbidden},
		{"origin prefix", "http://127.0.0.1:5173.evil.example", http.StatusForbidden},
		{"wildcard origin", "*", http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodOptions, "/v1/artifacts", nil)
			request.Header.Set("Origin", test.origin)
			request.Header.Set("Access-Control-Request-Method", "POST")
			request.Header.Set("Access-Control-Request-Headers", "authorization,content-type,idempotency-key")
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d", response.Code, test.status)
			}
			if test.status == http.StatusForbidden {
				for name := range response.Header() {
					if strings.HasPrefix(strings.ToLower(name), "access-control-") {
						t.Errorf("disallowed origin received CORS header %s", name)
					}
				}
				return
			}
			if got := response.Header().Get("Access-Control-Allow-Origin"); got != test.origin {
				t.Errorf("Allow-Origin = %q, want %q", got, test.origin)
			}
			for header, values := range map[string][]string{
				"Access-Control-Allow-Methods":  {"POST"},
				"Access-Control-Allow-Headers":  {"Authorization", "Content-Type", "Idempotency-Key"},
				"Access-Control-Expose-Headers": {"Retry-After"},
				"Vary":                          {"Origin"},
			} {
				for _, value := range values {
					found := false
					for _, item := range strings.Split(response.Header().Get(header), ",") {
						found = found || strings.EqualFold(strings.TrimSpace(item), value)
					}
					if !found {
						t.Errorf("%s = %q, missing %q", header, response.Header().Get(header), value)
					}
				}
			}
			if response.Body.Len() != 0 {
				t.Errorf("preflight body = %q, want empty", response.Body.String())
			}
		})
	}
}

func TestNewRouterRESTAuthenticationAndCORS(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name   string
		token  string
		role   domain.Role
		err    error
		status int
	}{
		{name: "user", token: "user-token", role: domain.RoleUser, status: http.StatusOK},
		{name: "family", token: "family-token", role: domain.RoleFamily, status: http.StatusOK},
		{name: "missing token", status: http.StatusUnauthorized},
		{name: "invalid token", token: "invalid", status: http.StatusUnauthorized},
		{name: "retry after", token: "user-token", role: domain.RoleUser, err: idempotencyInProgressError(), status: http.StatusConflict},
	} {
		t.Run(test.name, func(t *testing.T) {
			cfg := config.Config{
				DemoUserToken: "user-token", DemoFamilyToken: "family-token",
				ClientOrigins: map[string]struct{}{"http://127.0.0.1:5173": {}},
			}
			api := &routerTestAPI{err: test.err}
			router := NewRouter(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), api)
			request := httptest.NewRequest(http.MethodGet, "/v1/support-requests", nil)
			request.Header.Set("Origin", "http://127.0.0.1:5173")
			if test.token != "" {
				request.Header.Set("Authorization", "Bearer "+test.token)
			}
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d", response.Code, test.status)
			}
			if got := response.Header().Get("Access-Control-Allow-Origin"); got != "http://127.0.0.1:5173" {
				t.Errorf("Allow-Origin = %q", got)
			}
			if got := response.Header().Get("Access-Control-Expose-Headers"); got != "Retry-After" {
				t.Errorf("Expose-Headers = %q, want Retry-After", got)
			}
			if test.status == http.StatusUnauthorized {
				if api.called {
					t.Fatal("unauthenticated request reached the API")
				}
			} else if !api.called || api.actor.Role != test.role {
				t.Errorf("API called = %v, actor = %+v, want role %s", api.called, api.actor, test.role)
			}
			if test.err != nil && response.Header().Get("Retry-After") != "1" {
				t.Errorf("Retry-After = %q, want 1", response.Header().Get("Retry-After"))
			}
		})
	}
}

type routerTestAPI struct {
	generated.StrictServerInterface
	called bool
	actor  domain.Actor
	err    error
}

func (a *routerTestAPI) ListSupportRequests(ctx context.Context, _ generated.ListSupportRequestsRequestObject) (generated.ListSupportRequestsResponseObject, error) {
	a.called = true
	a.actor, _ = ActorFromContext(ctx)
	if a.err != nil {
		return newRawErrorResponse(ctx, a.err), nil
	}
	var response generated.ListSupportRequests200JSONResponse
	response.Data.Items = []generated.SupportRequest{}
	return response, nil
}
