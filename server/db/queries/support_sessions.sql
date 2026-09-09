-- name: SessionGetSupportRequest :one
SELECT *
FROM support_requests
WHERE id = $1;

-- name: SessionLockSupportRequest :one
SELECT *
FROM support_requests
WHERE id = $1
FOR UPDATE;

-- name: SessionGetSupportSession :one
SELECT *
FROM support_sessions
WHERE id = $1;

-- name: SessionLockSupportSession :one
SELECT *
FROM support_sessions
WHERE id = $1
FOR UPDATE;

-- name: SessionCreateSupportSession :one
INSERT INTO support_sessions (
    id,
    support_request_id,
    user_id,
    family_id,
    livekit_room_name,
    status,
    created_at,
    updated_at,
    revision
) VALUES ($1, $2, $3, $4, $5, 'RINGING', $6, $6, 1)
RETURNING *;

-- name: SessionAttachToSupportRequest :one
UPDATE support_requests
SET
    support_session_id = $2,
    updated_at = $3,
    revision = revision + 1
WHERE id = $1
RETURNING *;

-- name: SessionActivateSupportRequest :one
UPDATE support_requests
SET
    status = 'IN_SUPPORT',
    updated_at = $2,
    revision = revision + 1
WHERE id = $1
RETURNING *;

-- name: SessionActivateSupportSession :one
UPDATE support_sessions
SET
    status = 'ACTIVE',
    consent = $2,
    consented_at = $3,
    started_at = $3,
    updated_at = $3,
    revision = revision + 1
WHERE id = $1
RETURNING *;

-- name: SessionResolveSupportRequest :one
UPDATE support_requests
SET
    status = 'RESOLVED',
    updated_at = $2,
    revision = revision + 1
WHERE id = $1
RETURNING *;

-- name: SessionResolveWithGuide :one
UPDATE support_sessions
SET
    status = 'GENERATING_GUIDE',
    guide_decision = 'CREATE',
    updated_at = $2,
    revision = revision + 1
WHERE id = $1
RETURNING *;

-- name: SessionResolveWithoutGuide :one
UPDATE support_sessions
SET
    status = 'ENDED',
    guide_decision = 'SKIP',
    ended_at = $2,
    end_reason = 'GUIDE_SKIPPED',
    updated_at = $2,
    revision = revision + 1
WHERE id = $1
RETURNING *;

-- name: SessionGetGenerationJobStatus :one
SELECT status
FROM guide_generation_jobs
WHERE id = $1;

-- name: SessionListCleanupArtifacts :many
SELECT a.id, a.storage_key
FROM guide_materials AS gm
JOIN artifacts AS a ON a.id = gm.artifact_id
WHERE gm.batch_id = $1
ORDER BY gm.sequence;

-- name: SessionQueueArtifactDeletion :exec
INSERT INTO artifact_deletion_tasks (
    id,
    artifact_id,
    storage_key,
    status,
    attempt,
    next_attempt_at,
    created_at
) VALUES ($1, $2, $3, 'PENDING', 0, $4, $4)
ON CONFLICT (storage_key) DO NOTHING;

-- name: SessionEndWithoutGuide :one
UPDATE support_sessions
SET
    status = 'ENDED',
    guide_material_batch_id = NULL,
    guide_generation_job_id = NULL,
    guide_draft_id = NULL,
    guide_id = NULL,
    ended_at = $2,
    end_reason = $3,
    updated_at = $2,
    revision = revision + 1
WHERE id = $1
RETURNING *;

-- name: SessionDeleteGenerationJob :exec
DELETE FROM guide_generation_jobs
WHERE id = $1;

-- name: SessionDeleteGuideMaterials :exec
DELETE FROM guide_materials
WHERE batch_id = $1;

-- name: SessionDeleteGuideMaterialBatch :exec
DELETE FROM guide_material_batches
WHERE id = $1;

-- name: SessionDeleteGuideDraft :exec
DELETE FROM guide_drafts
WHERE id = $1;

-- name: SessionCreateIdempotencyRecord :execrows
INSERT INTO idempotency_records (
    actor_id,
    method,
    path,
    key,
    request_hash,
    status,
    lease_expires_at,
    created_at
) VALUES ($1, 'POST', $2, $3, $4, 'IN_PROGRESS', $5, $6)
ON CONFLICT (actor_id, method, path, key) DO NOTHING;

-- name: SessionCompleteIdempotencyRecord :one
UPDATE idempotency_records
SET
    status = 'COMPLETED',
    response_status = sqlc.arg(response_status),
    response_body = sqlc.arg(response_body),
    lease_expires_at = NULL,
    completed_at = sqlc.arg(completed_at)::timestamptz,
    expires_at = sqlc.arg(completed_at)::timestamptz + interval '24 hours'
WHERE actor_id = sqlc.arg(actor_id)
  AND method = sqlc.arg(method)
  AND path = sqlc.arg(path)
  AND key = sqlc.arg(key)
  AND status = 'IN_PROGRESS'
RETURNING *;

-- name: SessionEndSavedGuide :one
UPDATE support_sessions
SET status = 'ENDED', ended_at = $2, end_reason = 'GUIDE_SAVED',
    updated_at = $2, revision = revision + 1
WHERE id = $1
RETURNING *;
