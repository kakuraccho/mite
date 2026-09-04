package service

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"github.com/kakuraccho/mite/server/internal/domain"
)

type recordingPublisher struct {
	events []domain.Event
	err    error
}

func (p *recordingPublisher) Publish(_ context.Context, event domain.Event) error {
	p.events = append(p.events, event)
	return p.err
}

func TestCommitAndPublishPublishesOnlyAfterSuccessfulCommit(t *testing.T) {
	t.Parallel()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	event := domain.Event{EventID: "evt_1", Type: domain.EventSupportRequestCreated, EntityID: "req_1", Revision: 1}

	t.Run("commit fails", func(t *testing.T) {
		publisher := &recordingPublisher{}
		wantErr := errors.New("rollback")
		err := CommitAndPublish(context.Background(), logger, publisher, func(context.Context) ([]domain.Event, error) {
			return []domain.Event{event}, wantErr
		})
		if !errors.Is(err, wantErr) {
			t.Fatalf("CommitAndPublish() error = %v, want %v", err, wantErr)
		}
		if len(publisher.events) != 0 {
			t.Fatalf("published %d events after failed commit", len(publisher.events))
		}
	})

	t.Run("publish fails after commit", func(t *testing.T) {
		publisher := &recordingPublisher{err: errors.New("disconnected")}
		err := CommitAndPublish(context.Background(), logger, publisher, func(context.Context) ([]domain.Event, error) {
			return []domain.Event{event}, nil
		})
		if err != nil {
			t.Fatalf("CommitAndPublish() error = %v", err)
		}
		if len(publisher.events) != 1 {
			t.Fatalf("published %d events, want 1", len(publisher.events))
		}
	})
}
