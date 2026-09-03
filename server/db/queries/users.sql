-- name: GetUserByID :one
SELECT id, role, display_name
FROM users
WHERE id = $1;

-- name: GetUserPairByActorID :one
SELECT user_id, family_id
FROM user_pairs
WHERE user_id = $1 OR family_id = $1
LIMIT 1;

-- name: LockUserByID :one
SELECT id, role, display_name
FROM users
WHERE id = $1
FOR UPDATE;
