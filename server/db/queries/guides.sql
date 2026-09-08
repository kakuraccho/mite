-- name: TryLockGuideIdempotencyScope :one
SELECT pg_try_advisory_xact_lock(
    hashtextextended(
        sqlc.arg(actor_id)::text || chr(31) ||
        sqlc.arg(method)::text || chr(31) ||
        sqlc.arg(path)::text || chr(31) ||
        sqlc.arg(key)::text,
        0
    )
) AS locked;

-- name: CompleteGuideIdempotencyRecord :one
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

-- name: GetGuideSupportSession :one
SELECT *
FROM support_sessions
WHERE id = $1;

-- name: LockGuideSupportSession :one
SELECT *
FROM support_sessions
WHERE id = $1
FOR UPDATE;

-- name: CreateGuideMaterialBatchRow :one
INSERT INTO guide_material_batches (
    id,
    support_session_id,
    status,
    capture_interval_seconds,
    expected_item_count,
    received_item_count,
    captured_from,
    captured_to,
    completed_at,
    created_at,
    updated_at,
    revision
) VALUES (
    sqlc.arg(id),
    sqlc.arg(support_session_id),
    'UPLOADING',
    sqlc.arg(capture_interval_seconds),
    sqlc.arg(expected_item_count),
    0,
    sqlc.arg(captured_from),
    sqlc.arg(captured_to),
    NULL,
    sqlc.arg(created_at),
    sqlc.arg(created_at),
    1
)
RETURNING *;

-- name: AttachGuideMaterialBatchToSession :one
UPDATE support_sessions
SET
    guide_material_batch_id = sqlc.arg(batch_id),
    updated_at = sqlc.arg(updated_at),
    revision = revision + 1
WHERE id = sqlc.arg(session_id)
RETURNING *;

-- name: GetGuideMaterialBatchRow :one
SELECT *
FROM guide_material_batches
WHERE id = $1;

-- name: LockGuideMaterialBatchRow :one
SELECT *
FROM guide_material_batches
WHERE id = $1
FOR UPDATE;

-- name: ListGuideMaterialRows :many
SELECT *
FROM guide_materials
WHERE batch_id = $1
ORDER BY sequence;

-- name: GetGuideMaterialByCaptureID :one
SELECT gm.*, a.sha256 AS artifact_sha256
FROM guide_materials gm
JOIN artifacts a ON a.id = gm.artifact_id
WHERE gm.batch_id = sqlc.arg(batch_id)
  AND gm.client_capture_id = sqlc.arg(client_capture_id);

-- name: GetGuideMaterialBySequence :one
SELECT gm.*, a.sha256 AS artifact_sha256
FROM guide_materials gm
JOIN artifacts a ON a.id = gm.artifact_id
WHERE gm.batch_id = sqlc.arg(batch_id)
  AND gm.sequence = sqlc.arg(sequence);

-- name: CreateGuideArtifactRow :one
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
    'image/jpeg',
    sqlc.arg(storage_key),
    sqlc.arg(sha256),
    sqlc.arg(byte_size),
    sqlc.arg(width),
    sqlc.arg(height),
    sqlc.arg(captured_at),
    sqlc.arg(created_at),
    sqlc.arg(created_at),
    1
)
RETURNING *;

-- name: GetGuideArtifactRow :one
SELECT a.*
FROM artifacts a
WHERE a.id = $1
  AND NOT EXISTS (
      SELECT 1
      FROM artifact_deletion_tasks task
      WHERE task.artifact_id = a.id
  );

-- name: CreateGuideMaterialRow :one
INSERT INTO guide_materials (
    id,
    batch_id,
    client_capture_id,
    artifact_id,
    sequence,
    captured_at,
    created_at
) VALUES (
    sqlc.arg(id),
    sqlc.arg(batch_id),
    sqlc.arg(client_capture_id),
    sqlc.arg(artifact_id),
    sqlc.arg(sequence),
    sqlc.arg(captured_at),
    sqlc.arg(created_at)
)
RETURNING *;

-- name: IncrementGuideMaterialBatch :one
UPDATE guide_material_batches
SET
    received_item_count = received_item_count + 1,
    updated_at = sqlc.arg(updated_at),
    revision = revision + 1
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: CreateGuideArtifactDeletionTask :exec
INSERT INTO artifact_deletion_tasks (
    id,
    artifact_id,
    storage_key,
    status,
    attempt,
    next_attempt_at,
    created_at
) VALUES (
    sqlc.arg(id),
    sqlc.narg(artifact_id),
    sqlc.arg(storage_key),
    'PENDING',
    0,
    sqlc.arg(created_at),
    sqlc.arg(created_at)
)
ON CONFLICT (storage_key) DO NOTHING;

-- name: CountGuideMaterialRows :one
SELECT count(*)::integer
FROM guide_materials
WHERE batch_id = $1;

-- name: GetGuideMaterialManifest :one
SELECT
    count(*)::integer AS material_count,
    count(DISTINCT client_capture_id)::integer AS capture_id_count,
    min(sequence)::integer AS min_sequence,
    max(sequence)::integer AS max_sequence,
    count(DISTINCT sequence)::integer AS sequence_count,
    min(captured_at)::timestamptz AS min_captured_at,
    max(captured_at)::timestamptz AS max_captured_at
FROM guide_materials
WHERE batch_id = $1;

-- name: CompleteGuideMaterialBatchRow :one
UPDATE guide_material_batches
SET
    status = 'COMPLETED',
    completed_at = sqlc.arg(completed_at),
    updated_at = sqlc.arg(completed_at),
    revision = revision + 1
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: CreateGuideGenerationJobRow :one
INSERT INTO guide_generation_jobs (
    id,
    batch_id,
    status,
    attempt,
    guide_draft_id,
    error_code,
    created_at,
    started_at,
    finished_at,
    updated_at,
    revision
) VALUES (
    sqlc.arg(id),
    sqlc.arg(batch_id),
    'QUEUED',
    0,
    NULL,
    NULL,
    sqlc.arg(created_at),
    NULL,
    NULL,
    sqlc.arg(created_at),
    1
)
RETURNING *;

-- name: AttachGuideGenerationJobToSession :one
UPDATE support_sessions
SET
    guide_generation_job_id = sqlc.arg(job_id),
    updated_at = sqlc.arg(updated_at),
    revision = revision + 1
WHERE id = sqlc.arg(session_id)
RETURNING *;

-- name: GetGuideGenerationJobRow :one
SELECT *
FROM guide_generation_jobs
WHERE id = $1;

-- name: LockGuideGenerationJobRow :one
SELECT *
FROM guide_generation_jobs
WHERE id = $1
FOR UPDATE;

-- name: GetGuideSessionByJobID :one
SELECT ss.*
FROM support_sessions ss
JOIN guide_material_batches batch ON batch.support_session_id = ss.id
JOIN guide_generation_jobs job ON job.batch_id = batch.id
WHERE job.id = $1;

-- name: RetryGuideGenerationJobRow :one
UPDATE guide_generation_jobs
SET
    status = 'QUEUED',
    error_code = NULL,
    started_at = NULL,
    finished_at = NULL,
    updated_at = sqlc.arg(updated_at),
    revision = revision + 1
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: RecoverGuideGenerationJobs :many
UPDATE guide_generation_jobs
SET
	status = CASE WHEN attempt < 3 THEN 'QUEUED' ELSE 'FAILED' END,
	started_at = CASE WHEN attempt < 3 THEN NULL::timestamptz ELSE started_at END,
	finished_at = CASE WHEN attempt < 3 THEN NULL::timestamptz ELSE sqlc.arg(recovered_at)::timestamptz END,
	error_code = CASE WHEN attempt < 3 THEN NULL ELSE 'WORKER_RESTARTED' END,
	updated_at = sqlc.arg(recovered_at)::timestamptz,
    revision = revision + 1
WHERE status = 'RUNNING'
RETURNING *;

-- name: ClaimGuideGenerationJob :one
WITH candidate AS (
    SELECT id
    FROM guide_generation_jobs
    WHERE status = 'QUEUED'
    ORDER BY created_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT 1
)
UPDATE guide_generation_jobs job
SET
    status = 'RUNNING',
    attempt = job.attempt + 1,
    started_at = sqlc.arg(started_at),
    finished_at = NULL,
    error_code = NULL,
    updated_at = sqlc.arg(started_at),
    revision = job.revision + 1
FROM candidate
WHERE job.id = candidate.id
RETURNING job.*;

-- name: GetGuideGenerationContext :one
SELECT
    job.id AS job_id,
    job.batch_id,
    job.revision AS job_revision,
    batch.support_session_id,
    session.support_request_id,
    session.user_id,
    session.family_id,
    request.comment,
    request.initial_screenshot_artifact_id,
    initial_artifact.storage_key AS initial_storage_key,
    initial_artifact.captured_at AS initial_captured_at
FROM guide_generation_jobs job
JOIN guide_material_batches batch ON batch.id = job.batch_id
JOIN support_sessions session ON session.id = batch.support_session_id
JOIN support_requests request ON request.id = session.support_request_id
JOIN artifacts initial_artifact ON initial_artifact.id = request.initial_screenshot_artifact_id
WHERE job.id = $1;

-- name: ListGuideGenerationMaterials :many
SELECT
    material.artifact_id,
    material.sequence,
    material.captured_at,
    artifact.storage_key
FROM guide_materials material
JOIN artifacts artifact ON artifact.id = material.artifact_id
WHERE material.batch_id = $1
ORDER BY material.captured_at, material.sequence;

-- name: CreateGuideDraftRow :one
INSERT INTO guide_drafts (
    id,
    support_session_id,
    title,
    steps,
    status,
    revision,
    created_at,
    updated_at
) VALUES (
    sqlc.arg(id),
    sqlc.arg(support_session_id),
    sqlc.arg(title),
    sqlc.arg(steps),
    'EDITING',
    1,
    sqlc.arg(created_at),
    sqlc.arg(created_at)
)
RETURNING *;

-- name: SucceedGuideGenerationJob :one
UPDATE guide_generation_jobs
SET
    status = 'SUCCEEDED',
    guide_draft_id = sqlc.arg(guide_draft_id),
    error_code = NULL,
    finished_at = sqlc.arg(finished_at),
    updated_at = sqlc.arg(finished_at),
    revision = revision + 1
WHERE id = sqlc.arg(id)
  AND status = 'RUNNING'
  AND revision = sqlc.arg(expected_revision)
RETURNING *;

-- name: FailGuideGenerationJob :one
UPDATE guide_generation_jobs
SET
    status = 'FAILED',
    guide_draft_id = NULL,
    error_code = sqlc.arg(error_code),
    finished_at = sqlc.arg(finished_at),
    updated_at = sqlc.arg(finished_at),
    revision = revision + 1
WHERE id = sqlc.arg(id)
  AND status = 'RUNNING'
  AND revision = sqlc.arg(expected_revision)
RETURNING *;

-- name: ReviewGuideDraftInSession :one
UPDATE support_sessions
SET
    status = 'REVIEWING_GUIDE',
    guide_draft_id = sqlc.arg(guide_draft_id),
    updated_at = sqlc.arg(updated_at),
    revision = revision + 1
WHERE id = sqlc.arg(session_id)
  AND status = 'GENERATING_GUIDE'
RETURNING *;

-- name: GetGuideDraftRow :one
SELECT *
FROM guide_drafts
WHERE id = $1;

-- name: LockGuideDraftRow :one
SELECT *
FROM guide_drafts
WHERE id = $1
FOR UPDATE;

-- name: GetGuideSessionByDraftID :one
SELECT *
FROM support_sessions
WHERE guide_draft_id = $1;

-- name: ListAllowedGuideDraftArtifacts :many
SELECT a.id
FROM artifacts a
JOIN support_sessions session ON session.id = sqlc.arg(session_id)
JOIN support_requests request ON request.id = session.support_request_id
WHERE a.id = request.initial_screenshot_artifact_id
  AND a.owner_user_id = session.user_id
  AND a.purpose = 'REQUEST_SCREENSHOT'
  AND NOT EXISTS (
      SELECT 1 FROM artifact_deletion_tasks task WHERE task.artifact_id = a.id
  )
UNION
SELECT a.id
FROM artifacts a
JOIN guide_materials material ON material.artifact_id = a.id
JOIN guide_material_batches batch ON batch.id = material.batch_id
JOIN support_sessions session ON session.id = batch.support_session_id
WHERE batch.support_session_id = sqlc.arg(session_id)
  AND a.owner_user_id = session.user_id
  AND a.purpose = 'GUIDE_MATERIAL'
  AND NOT EXISTS (
      SELECT 1 FROM artifact_deletion_tasks task WHERE task.artifact_id = a.id
  );

-- name: UpdateGuideDraftRow :one
UPDATE guide_drafts
SET
    title = sqlc.arg(title),
    steps = sqlc.arg(steps),
    updated_at = sqlc.arg(updated_at),
    revision = revision + 1
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: CreateGuideRow :one
INSERT INTO guides (
    id,
    user_id,
    title,
    current_version_number,
    created_at,
    updated_at,
    revision
) VALUES (
    sqlc.arg(id),
    sqlc.arg(user_id),
    sqlc.arg(title),
    1,
    sqlc.arg(created_at),
    sqlc.arg(created_at),
    1
)
RETURNING *;

-- name: CreateGuideVersionRow :one
INSERT INTO guide_versions (
    guide_id,
    version_number,
    title,
    created_by,
    created_at
) VALUES (
    sqlc.arg(guide_id),
    1,
    sqlc.arg(title),
    sqlc.arg(created_by),
    sqlc.arg(created_at)
)
RETURNING *;

-- name: CreateGuideVersionStepRow :one
INSERT INTO guide_version_steps (
    guide_id,
    version_number,
    position,
    artifact_id,
    instruction
) VALUES (
    sqlc.arg(guide_id),
    1,
    sqlc.arg(position),
    sqlc.arg(artifact_id),
    sqlc.arg(instruction)
)
RETURNING *;

-- name: PromoteGuideArtifact :one
UPDATE artifacts
SET
    purpose = 'GUIDE_STEP',
    updated_at = sqlc.arg(updated_at),
    revision = revision + 1
WHERE id = sqlc.arg(id)
  AND purpose = 'GUIDE_MATERIAL'
RETURNING *;

-- name: ListUnusedGuideArtifacts :many
SELECT a.id, a.storage_key
FROM artifacts a
JOIN guide_materials material ON material.artifact_id = a.id
JOIN guide_material_batches batch ON batch.id = material.batch_id
WHERE batch.support_session_id = sqlc.arg(session_id)
  AND NOT (a.id = ANY(sqlc.arg(used_artifact_ids)::text[]));

-- name: SaveGuideDraftRow :one
UPDATE guide_drafts
SET
    status = 'SAVED',
    updated_at = sqlc.arg(updated_at),
    revision = revision + 1
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: SaveGuideInSession :one
UPDATE support_sessions
SET
    status = 'GUIDE_SAVED',
    guide_material_batch_id = NULL,
    guide_generation_job_id = NULL,
    guide_id = sqlc.arg(guide_id),
    updated_at = sqlc.arg(updated_at),
    revision = revision + 1
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: DeleteGuideGenerationJobByID :exec
DELETE FROM guide_generation_jobs
WHERE id = $1;

-- name: DeleteGuideMaterialsByBatchID :exec
DELETE FROM guide_materials
WHERE batch_id = $1;

-- name: DeleteGuideMaterialBatchByID :exec
DELETE FROM guide_material_batches
WHERE id = $1;

-- name: ListGuideRows :many
SELECT
    guide.*,
    step.artifact_id AS representative_artifact_id
FROM guides guide
JOIN guide_version_steps step
  ON step.guide_id = guide.id
 AND step.version_number = guide.current_version_number
 AND step.position = 1
WHERE guide.user_id = $1
ORDER BY guide.updated_at DESC, guide.id DESC;

-- name: GetGuideRow :one
SELECT
    guide.*,
    version.title AS version_title,
    version.created_by,
    version.created_at AS version_created_at,
    first_step.artifact_id AS representative_artifact_id
FROM guides guide
JOIN guide_versions version
  ON version.guide_id = guide.id
 AND version.version_number = guide.current_version_number
JOIN guide_version_steps first_step
  ON first_step.guide_id = guide.id
 AND first_step.version_number = guide.current_version_number
 AND first_step.position = 1
WHERE guide.id = $1;

-- name: ListGuideVersionSteps :many
SELECT *
FROM guide_version_steps
WHERE guide_id = sqlc.arg(guide_id)
  AND version_number = sqlc.arg(version_number)
ORDER BY position;

-- name: CreateGuideRunRow :one
INSERT INTO guide_runs (
    id,
    guide_id,
    guide_version_number,
    user_id,
    status,
    current_step_number,
    support_request_id,
    started_at,
    completed_at,
    paused_at,
    updated_at,
    revision
) VALUES (
    sqlc.arg(id),
    sqlc.arg(guide_id),
    sqlc.arg(guide_version_number),
    sqlc.arg(user_id),
    'IN_PROGRESS',
    1,
    NULL,
    sqlc.arg(started_at),
    NULL,
    NULL,
    sqlc.arg(started_at),
    1
)
RETURNING *;

-- name: GetGuideRunRow :one
SELECT *
FROM guide_runs
WHERE id = $1;

-- name: LockGuideRunRow :one
SELECT *
FROM guide_runs
WHERE id = $1
FOR UPDATE;

-- name: GetGuideVersionStepCount :one
SELECT count(*)::integer
FROM guide_version_steps
WHERE guide_id = sqlc.arg(guide_id)
  AND version_number = sqlc.arg(version_number);

-- name: MoveGuideRunRow :one
UPDATE guide_runs
SET
    current_step_number = sqlc.arg(current_step_number),
    updated_at = sqlc.arg(updated_at),
    revision = revision + 1
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: CompleteGuideRunRow :one
UPDATE guide_runs
SET
    status = 'COMPLETED',
    completed_at = sqlc.arg(completed_at),
    updated_at = sqlc.arg(completed_at),
    revision = revision + 1
WHERE id = sqlc.arg(id)
RETURNING *;

-- name: LockGuideRunOwner :one
SELECT *
FROM users
WHERE id = $1
FOR UPDATE;

-- name: HasActiveGuideSupportFlow :one
SELECT (
    EXISTS (
        SELECT 1 FROM support_requests request
        WHERE request.user_id = sqlc.arg(owner_user_id)
          AND request.status IN ('PENDING', 'IN_SUPPORT')
    ) OR EXISTS (
        SELECT 1 FROM support_sessions session
        WHERE session.user_id = sqlc.arg(owner_user_id)
          AND session.status <> 'ENDED'
    )
)::boolean AS active;

-- name: GetGuideContextStep :one
SELECT
    guide.title AS guide_title,
    step.instruction,
    step.artifact_id
FROM guides guide
JOIN guide_version_steps step
  ON step.guide_id = guide.id
 AND step.version_number = sqlc.arg(version_number)
 AND step.position = sqlc.arg(step_number)
WHERE guide.id = sqlc.arg(guide_id)
  AND guide.user_id = sqlc.arg(user_id);

-- name: CreateGuideSupportRequest :one
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
    sqlc.arg(guide_context),
    sqlc.arg(created_at),
    sqlc.arg(created_at),
    1
)
RETURNING *;

-- name: PauseGuideRunForSupport :one
UPDATE guide_runs
SET
    status = 'PAUSED_FOR_SUPPORT',
    support_request_id = sqlc.arg(support_request_id),
    paused_at = sqlc.arg(paused_at),
    updated_at = sqlc.arg(paused_at),
    revision = revision + 1
WHERE id = sqlc.arg(id)
RETURNING *;
