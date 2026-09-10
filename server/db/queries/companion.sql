-- name: CompanionGetUserPresence :one
SELECT *
FROM user_presences
WHERE user_id = $1;

-- name: CompanionLockUserPresence :one
SELECT *
FROM user_presences
WHERE user_id = $1
FOR UPDATE;

-- name: CompanionCreateUserPresence :one
INSERT INTO user_presences (
    user_id,
    connected_since,
    last_seen_at,
    connection_epoch,
    created_at,
    updated_at,
    revision
) VALUES ($1, $2, $2, 1, $2, $2, 1)
RETURNING *;

-- name: CompanionUpdateUserPresence :one
UPDATE user_presences
SET
    connected_since = sqlc.arg(connected_since),
    last_seen_at = sqlc.arg(last_seen_at),
    connection_epoch = sqlc.arg(connection_epoch),
    updated_at = sqlc.arg(updated_at),
    revision = revision + 1
WHERE user_id = sqlc.arg(user_id)
RETURNING *;

-- name: CompanionGetPendingSupportRequest :one
SELECT *
FROM support_requests
WHERE user_id = $1
  AND status = 'PENDING'
  AND support_session_id IS NULL
ORDER BY created_at DESC, id DESC
LIMIT 1;

-- name: CompanionReservePresenceNotification :execrows
INSERT INTO support_request_presence_notifications (
    support_request_id,
    connection_epoch,
    created_at
) VALUES ($1, $2, $3)
ON CONFLICT (support_request_id, connection_epoch) DO NOTHING;

-- name: CompanionCurrentPresenceEpoch :one
SELECT connection_epoch
FROM user_presences
WHERE user_id = $1;

-- name: CompanionUpsertPushSubscription :one
INSERT INTO push_subscriptions (
    id,
    family_id,
    endpoint,
    p256dh,
    auth,
    created_at,
    updated_at,
    revision
) VALUES ($1, $2, $3, $4, $5, $6, $6, 1)
ON CONFLICT (endpoint) DO UPDATE
SET
    p256dh = EXCLUDED.p256dh,
    auth = EXCLUDED.auth,
    updated_at = EXCLUDED.updated_at,
    revision = push_subscriptions.revision + 1
WHERE push_subscriptions.family_id = EXCLUDED.family_id
RETURNING *;

-- name: CompanionDeletePushSubscription :execrows
DELETE FROM push_subscriptions
WHERE family_id = $1
  AND endpoint = $2;

-- name: CompanionDeletePushSubscriptionByID :exec
DELETE FROM push_subscriptions
WHERE id = $1;

-- name: CompanionListPushSubscriptions :many
SELECT *
FROM push_subscriptions
WHERE family_id = $1
ORDER BY created_at, id;
