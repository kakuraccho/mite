package handler

import (
	"io"
	"log/slog"
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
	router := NewRouterWithEvents(cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), nil, hub.Handler())
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
