package handler

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	xwebsocket "golang.org/x/net/websocket"

	"github.com/kakuraccho/mite/server/internal/config"
	mitewebsocket "github.com/kakuraccho/mite/server/internal/websocket"
)

func TestNewRouterWithEventsUsesMessageAuthentication(t *testing.T) {
	cfg := config.Config{DemoUserToken: "user-token", DemoFamilyToken: "family-token", ClientOrigins: map[string]struct{}{"http://allowed.example": {}}}
	hub := mitewebsocket.NewHub(NewAuthenticator(cfg.DemoUserToken, cfg.DemoFamilyToken), cfg.ClientOrigins)
	router := NewRouterWithEvents(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), API{}, hub.Handler())
	server := httptest.NewServer(router)
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/events"
	connection, err := xwebsocket.Dial(url, "", "http://allowed.example")
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := xwebsocket.JSON.Send(connection, map[string]string{"type": "authenticate", "token": "user-token"}); err != nil {
		t.Fatal(err)
	}
	var response map[string]string
	if err := xwebsocket.JSON.Receive(connection, &response); err != nil {
		t.Fatal(err)
	}
	if response["type"] != "authenticated" {
		t.Fatalf("response=%v", response)
	}
}

func TestNewRouterWithEventsKeepsRESTMiddlewareSeparate(t *testing.T) {
	t.Parallel()
	cfg := config.Config{
		DemoUserToken: "user-token", DemoFamilyToken: "family-token",
		ClientOrigins: map[string]struct{}{"http://127.0.0.1:5173": {}},
	}
	for _, method := range []string{http.MethodGet, http.MethodOptions} {
		for _, origin := range []string{"http://127.0.0.1:5173", "http://denied.example"} {
			t.Run(method+"/"+origin, func(t *testing.T) {
				called := false
				events := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					called = true
					if r.URL.Path != "/v1/events" || r.Header.Get("Origin") != origin {
						t.Error("event request changed before reaching the WebSocket handler")
					}
					w.WriteHeader(http.StatusTeapot)
				})
				router := NewRouterWithEvents(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), API{}, events)
				request := httptest.NewRequest(method, "/v1/events", nil)
				request.Header.Set("Origin", origin)
				if method == http.MethodOptions {
					request.Header.Set("Access-Control-Request-Method", "GET")
				}
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)
				if !called || response.Code != http.StatusTeapot {
					t.Fatalf("events called = %v, status = %d", called, response.Code)
				}
				for name := range response.Header() {
					if strings.HasPrefix(strings.ToLower(name), "access-control-") {
						t.Errorf("WebSocket endpoint received REST CORS header %s", name)
					}
				}
			})
		}
	}
}
