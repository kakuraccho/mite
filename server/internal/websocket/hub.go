package websocket

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"time"

	xwebsocket "golang.org/x/net/websocket"

	"github.com/kakuraccho/mite/server/internal/domain"
)

const (
	authenticateTimeout = 5 * time.Second
	writeTimeout        = 5 * time.Second
)

type Authenticator interface {
	AuthenticateToken(string) (domain.Actor, error)
}

type Hub struct {
	authenticator  Authenticator
	allowedOrigins map[string]struct{}
	authTimeout    time.Duration
	mu             sync.RWMutex
	connections    map[*connection]struct{}
}

func NewHub(authenticator Authenticator, allowedOrigins map[string]struct{}) *Hub {
	origins := make(map[string]struct{}, len(allowedOrigins))
	for origin := range allowedOrigins {
		origins[origin] = struct{}{}
	}
	return &Hub{authenticator: authenticator, allowedOrigins: origins, authTimeout: authenticateTimeout, connections: make(map[*connection]struct{})}
}

func (h *Hub) Handler() http.Handler {
	return xwebsocket.Server{Handshake: h.handshake, Handler: h.handleConnection}
}

func (h *Hub) Publish(_ context.Context, event domain.Event) error {
	h.mu.RLock()
	targets := make([]*connection, 0, len(h.connections))
	for connection := range h.connections {
		if event.Audience.Contains(connection.actor) {
			targets = append(targets, connection)
		}
	}
	h.mu.RUnlock()
	var firstErr error
	for _, target := range targets {
		if err := target.send(event); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			h.remove(target)
			_ = target.socket.Close()
		}
	}
	return firstErr
}

func (h *Hub) handshake(_ *xwebsocket.Config, request *http.Request) error {
	origin := request.Header.Get("Origin")
	if origin == "" {
		return xwebsocket.ErrBadWebSocketOrigin
	}
	if _, allowed := h.allowedOrigins[origin]; !allowed {
		return xwebsocket.ErrBadWebSocketOrigin
	}
	return nil
}

func (h *Hub) handleConnection(socket *xwebsocket.Conn) {
	if h.authenticator == nil {
		_ = socket.Close()
		return
	}
	_ = socket.SetReadDeadline(time.Now().Add(h.authTimeout))
	var raw []byte
	if err := xwebsocket.Message.Receive(socket, &raw); err != nil {
		_ = socket.Close()
		return
	}
	var message authenticateMessage
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	decodeErr := decoder.Decode(&message)
	var trailing any
	trailingErr := decoder.Decode(&trailing)
	if decodeErr != nil || trailingErr != io.EOF || message.Type != "authenticate" || message.Token == "" {
		_ = socket.Close()
		return
	}
	actor, err := h.authenticator.AuthenticateToken(message.Token)
	if err != nil {
		_ = socket.Close()
		return
	}
	_ = socket.SetReadDeadline(time.Time{})
	current := &connection{socket: socket, actor: actor}
	// Subscribe before acknowledging readiness, and hold the write lock so
	// concurrent events cannot overtake the authenticated response.
	current.mu.Lock()
	h.add(current)
	err = current.sendLocked(authenticatedMessage{Type: "authenticated"})
	if err != nil {
		h.remove(current)
		_ = socket.Close()
	}
	current.mu.Unlock()
	if err != nil {
		return
	}
	defer h.remove(current)
	for {
		var ignored []byte
		if err := xwebsocket.Message.Receive(socket, &ignored); err != nil {
			return
		}
	}
}

func (h *Hub) add(connection *connection) {
	h.mu.Lock()
	h.connections[connection] = struct{}{}
	h.mu.Unlock()
}
func (h *Hub) remove(connection *connection) {
	h.mu.Lock()
	delete(h.connections, connection)
	h.mu.Unlock()
}

type connection struct {
	socket *xwebsocket.Conn
	actor  domain.Actor
	mu     sync.Mutex
}

func (c *connection) send(value any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sendLocked(value)
}

// sendLocked requires c.mu to be held.
func (c *connection) sendLocked(value any) error {
	if err := c.socket.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
		return err
	}
	return xwebsocket.JSON.Send(c.socket, value)
}

type authenticateMessage struct {
	Type  string `json:"type"`
	Token string `json:"token"`
}
type authenticatedMessage struct {
	Type string `json:"type"`
}
