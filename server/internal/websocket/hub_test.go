package websocket

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	xwebsocket "golang.org/x/net/websocket"

	"github.com/kakuraccho/mite/server/internal/domain"
)

type fakeAuthenticator map[string]domain.Actor

func (a fakeAuthenticator) AuthenticateToken(token string) (domain.Actor, error) {
	actor, ok := a[token]
	if !ok {
		return domain.Actor{}, domain.NewError(domain.CodeUnauthenticated, "bad token")
	}
	return actor, nil
}

func TestHubAuthenticatesAndPublishesOnlyToPair(t *testing.T) {
	hub := NewHub(fakeAuthenticator{"token": {ID: "user_1", Role: domain.RoleUser}}, map[string]struct{}{"http://allowed.example": {}})
	server := httptest.NewServer(hub.Handler())
	defer server.Close()
	conn := dialWebSocket(t, server.URL, "http://allowed.example")
	defer conn.Close()
	if err := xwebsocket.JSON.Send(conn, map[string]string{"type": "authenticate", "token": "token"}); err != nil {
		t.Fatal(err)
	}
	var authenticated map[string]string
	if err := xwebsocket.JSON.Receive(conn, &authenticated); err != nil {
		t.Fatal(err)
	}
	if authenticated["type"] != "authenticated" {
		t.Fatalf("message = %v", authenticated)
	}
	event := domain.Event{EventID: "event_1", Type: domain.EventSupportSessionUpdated, EntityID: "session_1", Revision: 2, OccurredAt: time.Now(), Data: []byte(`{"id":"session_1"}`), Audience: domain.UserPair{UserID: "user_1", FamilyID: "family_1"}}
	if err := hub.Publish(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	var received domain.Event
	if err := xwebsocket.JSON.Receive(conn, &received); err != nil {
		t.Fatal(err)
	}
	if received.EventID != event.EventID || string(received.Data) != string(event.Data) {
		t.Fatalf("event = %+v", received)
	}

	other := domain.Event{EventID: "event_2", Type: domain.EventSupportSessionUpdated, EntityID: "session_2", Revision: 1, Data: []byte(`{}`), Audience: domain.UserPair{UserID: "user_2", FamilyID: "family_2"}}
	if err := hub.Publish(context.Background(), other); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(50 * time.Millisecond))
	if err := xwebsocket.JSON.Receive(conn, &received); err == nil {
		t.Fatal("unexpected cross-pair event")
	}
}

func TestHubRejectsUnknownOrigin(t *testing.T) {
	hub := NewHub(fakeAuthenticator{}, map[string]struct{}{"http://allowed.example": {}})
	server := httptest.NewServer(hub.Handler())
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http")
	for _, origin := range []string{"http://denied.example", "http://allowed.example.evil"} {
		config, err := xwebsocket.NewConfig(url, origin)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := xwebsocket.DialConfig(config); err == nil {
			t.Fatalf("origin %q was accepted", origin)
		}
	}
}

func TestHubClosesWhenAuthenticationTimesOut(t *testing.T) {
	hub := NewHub(fakeAuthenticator{}, map[string]struct{}{"http://allowed.example": {}})
	hub.authTimeout = 30 * time.Millisecond
	server := httptest.NewServer(hub.Handler())
	defer server.Close()
	conn := dialWebSocket(t, server.URL, "http://allowed.example")
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	var received any
	if err := xwebsocket.JSON.Receive(conn, &received); err == nil {
		t.Fatal("connection remained open without authentication")
	}
}

func TestHubRejectsMalformedAuthentication(t *testing.T) {
	hub := NewHub(fakeAuthenticator{"token": {ID: "user_1", Role: domain.RoleUser}}, map[string]struct{}{"http://allowed.example": {}})
	server := httptest.NewServer(hub.Handler())
	defer server.Close()
	conn := dialWebSocket(t, server.URL, "http://allowed.example")
	defer conn.Close()
	if err := xwebsocket.JSON.Send(conn, map[string]string{"type": "authenticate", "token": "token", "extra": "not allowed"}); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	var received any
	if err := xwebsocket.JSON.Receive(conn, &received); err == nil {
		t.Fatal("malformed authentication was accepted")
	}
}

func TestHubClosesForInvalidAuthenticationToken(t *testing.T) {
	hub := NewHub(fakeAuthenticator{}, map[string]struct{}{"http://allowed.example": {}})
	server := httptest.NewServer(hub.Handler())
	defer server.Close()
	conn := dialWebSocket(t, server.URL, "http://allowed.example")
	defer conn.Close()
	if err := xwebsocket.JSON.Send(conn, map[string]string{"type": "authenticate", "token": "invalid"}); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	var received any
	if err := xwebsocket.JSON.Receive(conn, &received); err == nil {
		t.Fatal("invalid token was authenticated")
	}
}

func dialWebSocket(t *testing.T, serverURL, origin string) *xwebsocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(serverURL, "http")
	config, err := xwebsocket.NewConfig(url, origin)
	if err != nil {
		t.Fatal(err)
	}
	connection, err := xwebsocket.DialConfig(config)
	if err != nil {
		t.Fatal(err)
	}
	return connection
}
