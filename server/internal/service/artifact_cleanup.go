package service

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/kakuraccho/mite/server/internal/domain"
	"github.com/kakuraccho/mite/server/internal/repository"
)

const defaultCleanupBatchSize = 100

type ArtifactCleanupResult struct {
	ScheduledArtifacts   int
	DeletedIdempotencies int
}

// ScheduleArtifactCleanup atomically makes stale images unavailable through
// the content API before asynchronous Storage deletion starts. It also removes
// expired idempotency records and reserves deletion of abandoned upload keys.
func (s *ArtifactSupportService) ScheduleArtifactCleanup(
	ctx context.Context,
	batchSize int,
) (ArtifactCleanupResult, error) {
	if batchSize <= 0 {
		batchSize = defaultCleanupBatchSize
	}
	now := s.now().UTC()
	result := ArtifactCleanupResult{}
	err := s.store.WithinTransaction(ctx, func(tx repository.ArtifactSupportTx) error {
		artifacts, err := tx.ListStaleRequestArtifacts(ctx, now.Add(-24*time.Hour), batchSize)
		if err != nil {
			return err
		}
		for index := range artifacts {
			artifact := artifacts[index]
			referenced, err := tx.ArtifactHasReferences(ctx, artifact.ID)
			if err != nil {
				return err
			}
			deletionReserved, err := tx.HasArtifactDeletionTask(ctx, artifact.StorageKey)
			if err != nil {
				return err
			}
			if referenced || deletionReserved {
				continue
			}
			taskID, err := s.newID("artifact_delete")
			if err != nil {
				return internalError("ArtifactDeletionTask IDを生成できない", err)
			}
			artifactID := artifact.ID
			if err := tx.CreateArtifactDeletionTask(ctx, domain.ArtifactDeletionTask{
				ID: taskID, ArtifactID: &artifactID, StorageKey: artifact.StorageKey,
				Status: domain.ArtifactDeletionPending, NextAttemptAt: now, CreatedAt: now,
			}); err != nil {
				return err
			}
			result.ScheduledArtifacts++
		}

		records, err := tx.ListExpiredIdempotency(ctx, now, batchSize)
		if err != nil {
			return err
		}
		for _, record := range records {
			if record.Status == domain.IdempotencyInProgress && record.ResourceID != nil && isArtifactUploadPath(record.Scope.Path) {
				taskID, err := s.newID("artifact_delete")
				if err != nil {
					return internalError("ArtifactDeletionTask IDを生成できない", err)
				}
				if err := tx.CreateArtifactDeletionTask(ctx, domain.ArtifactDeletionTask{
					ID: taskID, ArtifactID: nil,
					StorageKey: domain.ArtifactStorageKey(record.Scope.ActorID, *record.ResourceID),
					Status:     domain.ArtifactDeletionPending, NextAttemptAt: now, CreatedAt: now,
				}); err != nil {
					return err
				}
				result.ScheduledArtifacts++
			}
			if err := tx.DeleteIdempotency(ctx, record.Scope); err != nil {
				return err
			}
			result.DeletedIdempotencies++
		}
		return nil
	})
	if err != nil {
		return ArtifactCleanupResult{}, normalizeRepositoryError(err)
	}
	return result, nil
}

func (s *ArtifactSupportService) RecoverArtifactDeletionTasks(ctx context.Context) (int64, error) {
	var recovered int64
	err := s.store.WithinTransaction(ctx, func(tx repository.ArtifactSupportTx) error {
		var err error
		recovered, err = tx.ResetRunningArtifactDeletionTasks(ctx)
		return err
	})
	if err != nil {
		return 0, normalizeRepositoryError(err)
	}
	return recovered, nil
}

// ProcessNextArtifactDeletion deletes at most one object. Storage 404 is
// normalized to success by the Storage implementation. Other failures are
// persisted for exponential retry.
func (s *ArtifactSupportService) ProcessNextArtifactDeletion(ctx context.Context) (bool, error) {
	now := s.now().UTC()
	var task domain.ArtifactDeletionTask
	found := false
	err := s.store.WithinTransaction(ctx, func(tx repository.ArtifactSupportTx) error {
		candidate, exists, err := tx.LockNextArtifactDeletionTask(ctx, now)
		if err != nil || !exists {
			return err
		}
		candidate, marked, err := tx.MarkArtifactDeletionTaskRunning(ctx, candidate.ID)
		if err != nil {
			return err
		}
		if !marked {
			return internalError("ArtifactDeletionTaskをRUNNINGへ変更できない", nil)
		}
		task = candidate
		found = true
		return nil
	})
	if err != nil {
		return false, normalizeRepositoryError(err)
	}
	if !found {
		return false, nil
	}

	if err := s.storage.Delete(ctx, task.StorageKey); err != nil {
		nextAttemptAt := s.now().UTC().Add(deletionRetryDelay(task.Attempt))
		retryErr := s.store.WithinTransaction(ctx, func(tx repository.ArtifactSupportTx) error {
			return tx.RetryArtifactDeletionTask(ctx, task.ID, nextAttemptAt)
		})
		if retryErr != nil {
			return true, normalizeRepositoryError(retryErr)
		}
		return true, domain.WrapError(domain.CodeExternalServiceUnavailable, "画像を削除できない", err)
	}

	err = s.store.WithinTransaction(ctx, func(tx repository.ArtifactSupportTx) error {
		if task.ArtifactID != nil {
			_, err := tx.DeleteArtifactIfUnreferenced(ctx, *task.ArtifactID)
			if err != nil {
				return err
			}
		}
		return tx.DeleteArtifactDeletionTask(ctx, task.ID)
	})
	if err != nil {
		// Storageの削除は完了しているため、タスクをPENDINGへ戻してDB側の
		// 後処理を再実行する。Storage 404は次回も成功として扱われる。
		nextAttemptAt := s.now().UTC().Add(deletionRetryDelay(task.Attempt))
		_ = s.store.WithinTransaction(ctx, func(tx repository.ArtifactSupportTx) error {
			return tx.RetryArtifactDeletionTask(ctx, task.ID, nextAttemptAt)
		})
		return true, normalizeRepositoryError(err)
	}
	return true, nil
}

func isArtifactUploadPath(path string) bool {
	if path == createArtifactPath {
		return true
	}
	return strings.HasPrefix(path, "/v1/guide-material-batches/") && strings.HasSuffix(path, "/materials")
}

func deletionRetryDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > 12 {
		attempt = 12
	}
	delay := time.Second * time.Duration(1<<(attempt-1))
	if delay > time.Hour {
		return time.Hour
	}
	return delay
}

func (r ArtifactCleanupResult) String() string {
	return fmt.Sprintf("scheduled=%d deletedIdempotencies=%d", r.ScheduledArtifacts, r.DeletedIdempotencies)
}
