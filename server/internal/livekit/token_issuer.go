package livekit

import (
	"context"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
)

type TokenRequest struct {
	RoomName            string
	ParticipantIdentity string
	Role                domain.Role
	ExpiresAt           time.Time
}

type Token struct {
	ServerURL string
	Value     string
	ExpiresAt time.Time
}

// TokenIssuer is the LiveKit server SDK boundary.
type TokenIssuer interface {
	Issue(context.Context, TokenRequest) (Token, error)
}
