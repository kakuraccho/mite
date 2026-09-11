-- name: InsertArtifactSupportIdempotencyRecordIfAbsent :execrows
INSERT INTO idempotency_records (
    actor_id,
    method,
    path,
    key,
    request_hash,
    status,
    resource_id,
    lease_expires_at,
    created_at
) VALUES (
    sqlc.arg(actor_id),
    sqlc.arg(method),
    sqlc.arg(path),
    sqlc.arg(key),
    sqlc.arg(request_hash),
    'IN_PROGRESS',
    sqlc.narg(resource_id),
    sqlc.arg(lease_expires_at),
    sqlc.arg(created_at)
)
ON CONFLICT (actor_id, method, path, key) DO NOTHING;

-- name: CompleteArtifactSupportIdempotencyRecord :one
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

-- name: CreateRequestArtifact :one
INSERT INTO artifacts (
    id,
    owner_user_id,
    purpose,
    mime_type,
    storage_key,
    sha256,
    byte_size,
    width,
    height,
    captured_at,
    created_at,
    updated_at,
    revision
) VALUES (
    sqlc.arg(id),
    sqlc.arg(owner_user_id),
    sqlc.arg(purpose),
    sqlc.arg(mime_type),
    sqlc.arg(storage_key),
    sqlc.arg(sha256),
    sqlc.arg(byte_size),
    sqlc.arg(width),
    sqlc.arg(height),
    sqlc.arg(captured_at),
    sqlc.arg(created_at),
    sqlc.arg(updated_at),
    1
)
RETURNING *;

-- name: GetAvailableArtifactByID :one
SELECT a.*
FROM artifacts AS a
WHERE a.id = $1
  AND NOT EXISTS (
      SELECT 1
      FROM artifact_deletion_tasks AS deletion
      WHERE deletion.storage_key = a.storage_key
  );

-- name: LockAvailableArtifactByID :one
SELECT a.*
FROM artifacts AS a
WHERE a.id = $1
FOR UPDATE;

-- name: HasArtifactDeletionTask :one
SELECT EXISTS (
    SELECT 1
    FROM artifact_deletion_tasks
    WHERE storage_key = $1
);

-- name: ArtifactHasReferences :one
SELECT
    EXISTS (
        SELECT 1
        FROM support_requests
        WHERE initial_screenshot_artifact_id = $1
    )
    OR EXISTS (
        SELECT 1
        FROM guide_materials
        WHERE artifact_id = $1
    )
    OR EXISTS (
        SELECT 1
        FROM guide_version_steps
        WHERE artifact_id = $1
    ) AS has_references;

-- name: CreateRegularSupportRequest :one
INSERT INTO support_requests (
    id,
    user_id,
    family_id,
    initial_screenshot_artifact_id,
    comment,
    status,
    support_session_id,
    guide_context,
    created_at,
    updated_at,
    revision
) VALUES (
    sqlc.arg(id),
    sqlc.arg(user_id),
    sqlc.arg(family_id),
    sqlc.arg(initial_screenshot_artifact_id),
    sqlc.arg(comment),
    'PENDING',
    NULL,
    NULL,
    sqlc.arg(created_at),
    sqlc.arg(updated_at),
    1
)
RETURNING *;

-- name: GetSupportRequestByID :one
SELECT *
FROM support_requests
WHERE id = $1;

-- name: LockArtifactSupportRequestByID :one
SELECT *
FROM support_requests
WHERE id = $1
FOR UPDATE;

-- name: UpdateSupportRequestAcknowledgement :one
UPDATE support_requests
SET
    acknowledged_at = sqlc.arg(acknowledged_at),
    acknowledgement_kind = sqlc.arg(acknowledgement_kind),
    estimated_support_at = sqlc.narg(estimated_support_at),
    updated_at = sqlc.arg(updated_at),
    revision = revision + 1
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: CancelPendingSupportRequest :one
UPDATE support_requests
SET
    status = 'CANCELLED',
    updated_at = sqlc.arg(updated_at),
    revision = revision + 1
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: ListSupportRequestsForPair :many
SELECT *
FROM support_requests
WHERE user_id = sqlc.arg(user_id)
  AND family_id = sqlc.arg(family_id)
  AND (
      sqlc.narg(status)::text IS NULL
      OR status = sqlc.narg(status)::text
  )
ORDER BY created_at DESC, id DESC
LIMIT 20;

-- name: HasActiveSupportRequestForUser :one
SELECT EXISTS (
    SELECT 1
    FROM support_requests
    WHERE user_id = $1
      AND status IN ('PENDING', 'IN_SUPPORT')
);

-- name: HasOpenSupportSessionForUser :one
SELECT EXISTS (
    SELECT 1
    FROM support_sessions
    WHERE user_id = $1
      AND status <> 'ENDED'
);

-- name: ListStaleUnreferencedRequestArtifactsForUpdate :many
SELECT a.*
FROM artifacts AS a
WHERE a.purpose = 'REQUEST_SCREENSHOT'
  AND a.created_at <= sqlc.arg(created_before)
  AND NOT EXISTS (
      SELECT 1
      FROM support_requests AS request
      WHERE request.initial_screenshot_artifact_id = a.id
  )
  AND NOT EXISTS (
      SELECT 1
      FROM artifact_deletion_tasks AS deletion
      WHERE deletion.storage_key = a.storage_key
  )
ORDER BY a.created_at, a.id
LIMIT sqlc.arg(batch_limit)
FOR UPDATE SKIP LOCKED;

-- name: ListExpiredArtifactSupportIdempotencyRecordsForUpdate :many
SELECT
    actor_id,
    method,
    path,
    key,
    status,
    resource_id
FROM idempotency_records
WHERE (status = 'COMPLETED' AND expires_at <= sqlc.arg(now))
   OR (status = 'IN_PROGRESS' AND created_at <= sqlc.arg(now) - interval '24 hours')
ORDER BY created_at
LIMIT sqlc.arg(batch_limit)
FOR UPDATE SKIP LOCKED;

-- name: DeleteArtifactSupportIdempotencyRecord :execrows
DELETE FROM idempotency_records
WHERE actor_id = sqlc.arg(actor_id)
  AND method = sqlc.arg(method)
  AND path = sqlc.arg(path)
  AND key = sqlc.arg(key);

-- name: DeleteArtifactIfUnreferenced :execrows
DELETE FROM artifacts AS artifact
WHERE artifact.id = $1;
