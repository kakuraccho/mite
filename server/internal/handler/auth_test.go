package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kakuraccho/mite/server/internal/domain"
)

func TestAuthenticator(t *testing.T) {
	t.Parallel()
	authenticator := NewAuthenticator("user-secret", "family-secret")
	tests := []struct {
		name   string
		header string
		role   domain.Role
		ok     bool
	}{
		{name: "user", header: "Bearer user-secret", role: domain.RoleUser, ok: true},
		{name: "family", header: "Bearer family-secret", role: domain.RoleFamily, ok: true},
		{name: "missing", header: "", ok: false},
		{name: "wrong scheme", header: "Basic user-secret", ok: false},
		{name: "unknown", header: "Bearer unknown", ok: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			actor, err := authenticator.Authenticate(test.header)
			if (err == nil) != test.ok {
				t.Fatalf("Authenticate() error = %v, want ok %v", err, test.ok)
			}
			if test.ok && actor.Role != test.role {
				t.Fatalf("role = %s, want %s", actor.Role, test.role)
			}
		})
	}
}

func TestAuthenticatorMiddlewareStoresActor(t *testing.T) {
	t.Parallel()
	authenticator := NewAuthenticator("user-secret", "family-secret")
	var actor domain.Actor
	handler := authenticator.Middleware(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		actor, _ = ActorFromContext(request.Context())
	}))
	request := httptest.NewRequest(http.MethodGet, "/v1/support-requests", nil)
	request.Header.Set("Authorization", "Bearer user-secret")
	request = request.WithContext(context.WithValue(request.Context(), requestIDContextKey, "req_test"))
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if actor.ID != "user_demo" || actor.Role != domain.RoleUser {
		t.Fatalf("actor = %#v", actor)
	}
}
