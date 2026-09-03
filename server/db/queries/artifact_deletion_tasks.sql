-- name: CreateArtifactDeletionTask :one
INSERT INTO artifact_deletion_tasks (
    id,
    artifact_id,
    storage_key,
    status,
    attempt,
    next_attempt_at,
    created_at
) VALUES (
    $1,
    $2,
    $3,
    'PENDING',
    0,
    $4,
    $5
)
ON CONFLICT (storage_key) DO UPDATE
SET storage_key = EXCLUDED.storage_key
RETURNING *;

-- name: ResetRunningArtifactDeletionTasks :execrows
UPDATE artifact_deletion_tasks
SET status = 'PENDING'
WHERE status = 'RUNNING';

-- name: LockNextArtifactDeletionTask :one
SELECT id, artifact_id, storage_key, status, attempt, next_attempt_at, created_at
FROM artifact_deletion_tasks
WHERE status = 'PENDING'
  AND next_attempt_at <= $1
ORDER BY next_attempt_at, created_at
LIMIT 1
FOR UPDATE SKIP LOCKED;

-- name: MarkArtifactDeletionTaskRunning :one
UPDATE artifact_deletion_tasks
SET
    status = 'RUNNING',
    attempt = attempt + 1
WHERE id = $1
  AND status = 'PENDING'
RETURNING *;

-- name: RetryArtifactDeletionTask :one
UPDATE artifact_deletion_tasks
SET
    status = 'PENDING',
    next_attempt_at = $2
WHERE id = $1
  AND status = 'RUNNING'
RETURNING *;

-- name: DeleteArtifactDeletionTask :execrows
DELETE FROM artifact_deletion_tasks
WHERE id = $1;
