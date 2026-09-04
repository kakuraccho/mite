package worker

import (
	"context"
	"log/slog"
	"time"

	"github.com/kakuraccho/mite/server/internal/service"
)

const artifactMaintenanceInterval = time.Minute

type ArtifactDeletionWorker struct {
	service *service.ArtifactSupportService
	logger  *slog.Logger
}

func NewArtifactDeletionWorker(service *service.ArtifactSupportService, logger *slog.Logger) *ArtifactDeletionWorker {
	if logger == nil {
		logger = slog.Default()
	}
	return &ArtifactDeletionWorker{service: service, logger: logger}
}

// Run restores interrupted tasks once at startup, then continuously reserves
// stale objects and drains persistent deletion tasks until the context ends.
func (w *ArtifactDeletionWorker) Run(ctx context.Context) error {
	if _, err := w.service.RecoverArtifactDeletionTasks(ctx); err != nil {
		return err
	}
	maintenance := time.NewTicker(artifactMaintenanceInterval)
	deletions := time.NewTicker(time.Second)
	defer maintenance.Stop()
	defer deletions.Stop()

	if err := w.runMaintenance(ctx); err != nil {
		w.logger.WarnContext(ctx, "artifact maintenance failed", "errorCode", "ARTIFACT_MAINTENANCE_FAILED")
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-maintenance.C:
			if err := w.runMaintenance(ctx); err != nil {
				w.logger.WarnContext(ctx, "artifact maintenance failed", "errorCode", "ARTIFACT_MAINTENANCE_FAILED")
			}
		case <-deletions.C:
			if _, err := w.service.ProcessNextArtifactDeletion(ctx); err != nil {
				w.logger.WarnContext(ctx, "artifact deletion failed", "errorCode", "ARTIFACT_DELETE_FAILED")
			}
		}
	}
}

func (w *ArtifactDeletionWorker) runMaintenance(ctx context.Context) error {
	_, err := w.service.ScheduleArtifactCleanup(ctx, 0)
	return err
}
