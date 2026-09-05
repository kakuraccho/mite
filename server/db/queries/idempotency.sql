-- name: GetIdempotencyRecord :one
SELECT
    actor_id,
    method,
    path,
    key,
    request_hash,
    status,
    resource_id,
    response_status,
    response_body,
    lease_expires_at,
    created_at,
    completed_at,
    expires_at
FROM idempotency_records
WHERE actor_id = $1
  AND method = $2
  AND path = $3
  AND key = $4;

-- name: LockIdempotencyRecord :one
SELECT
    actor_id,
    method,
    path,
    key,
    request_hash,
    status,
    resource_id,
    response_status,
    response_body,
    lease_expires_at,
    created_at,
    completed_at,
    expires_at
FROM idempotency_records
WHERE actor_id = $1
  AND method = $2
  AND path = $3
  AND key = $4
FOR UPDATE;

-- name: CreateIdempotencyRecord :one
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
    $1,
    $2,
    $3,
    $4,
    $5,
    'IN_PROGRESS',
    $6,
    $7,
    $8
)
RETURNING *;

-- name: TakeOverExpiredIdempotencyLease :one
UPDATE idempotency_records
SET
    lease_expires_at = sqlc.arg(new_lease_expires_at),
    resource_id = COALESCE(resource_id, sqlc.narg(resource_id))
WHERE actor_id = sqlc.arg(actor_id)
  AND method = sqlc.arg(method)
  AND path = sqlc.arg(path)
  AND key = sqlc.arg(key)
  AND status = 'IN_PROGRESS'
  AND lease_expires_at <= sqlc.arg(now)
RETURNING *;

-- name: ReleaseIdempotencyLease :exec
UPDATE idempotency_records
SET lease_expires_at = sqlc.arg(released_at)
WHERE actor_id = sqlc.arg(actor_id)
  AND method = sqlc.arg(method)
  AND path = sqlc.arg(path)
  AND key = sqlc.arg(key)
  AND status = 'IN_PROGRESS';

-- name: CompleteIdempotencyRecord :one
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

-- name: ListExpiredIdempotencyRecords :many
SELECT
    actor_id,
    method,
    path,
    key,
    resource_id
FROM idempotency_records
WHERE (status = 'COMPLETED' AND expires_at <= $1)
   OR (status = 'IN_PROGRESS' AND created_at <= $1 - interval '24 hours')
ORDER BY created_at
LIMIT $2;

-- name: DeleteIdempotencyRecord :execrows
DELETE FROM idempotency_records
WHERE actor_id = $1
  AND method = $2
  AND path = $3
  AND key = $4;
