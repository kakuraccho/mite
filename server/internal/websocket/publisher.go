package websocket

import (
	"context"

	"github.com/kakuraccho/mite/server/internal/domain"
)

// Publisher broadcasts committed state snapshots to the fixed user-family pair.
type Publisher interface {
	Publish(context.Context, domain.Event) error
}

type NopPublisher struct{}

func (NopPublisher) Publish(context.Context, domain.Event) error {
	return nil
}
