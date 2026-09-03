package service

import (
	"context"
	"log/slog"

	"github.com/kakuraccho/mite/server/internal/domain"
)

type EventPublisher interface {
	Publish(context.Context, domain.Event) error
}

// CommitAndPublish executes commitWork first and publishes only the events
// returned by a successful commit. Notification failures never undo committed
// business state; clients converge through the REST API.
func CommitAndPublish(
	ctx context.Context,
	logger *slog.Logger,
	publisher EventPublisher,
	commitWork func(context.Context) ([]domain.Event, error),
) error {
	events, err := commitWork(ctx)
	if err != nil {
		return err
	}
	for _, event := range events {
		if err := publisher.Publish(ctx, event); err != nil {
			logger.WarnContext(ctx, "event delivery failed",
				"eventId", event.EventID,
				"eventType", event.Type,
				"entityId", event.EntityID,
				"revision", event.Revision,
			)
		}
	}
	return nil
}
