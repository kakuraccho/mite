package handler

import (
	"context"

	"github.com/kakuraccho/mite/server/internal/domain"
)

type contextKey int

const (
	requestIDContextKey contextKey = iota
	actorContextKey
)

func RequestIDFromContext(ctx context.Context) string {
	requestID, _ := ctx.Value(requestIDContextKey).(string)
	return requestID
}

func ActorFromContext(ctx context.Context) (domain.Actor, bool) {
	actor, ok := ctx.Value(actorContextKey).(domain.Actor)
	return actor, ok
}
