CREATE TABLE users (
    id text PRIMARY KEY CHECK (char_length(id) > 0),
    role text NOT NULL CHECK (role IN ('USER', 'FAMILY')),
    display_name text NOT NULL CHECK (
        char_length(display_name) BETWEEN 1 AND 40
        AND btrim(display_name) <> ''
    )
);

CREATE TABLE user_pairs (
    user_id text NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    family_id text NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    PRIMARY KEY (user_id, family_id),
    CHECK (user_id <> family_id)
);

CREATE TABLE artifacts (
    id text PRIMARY KEY CHECK (char_length(id) > 0),
    owner_user_id text NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    purpose text NOT NULL CHECK (purpose IN ('REQUEST_SCREENSHOT', 'GUIDE_MATERIAL', 'GUIDE_STEP')),
    mime_type text NOT NULL CHECK (mime_type = 'image/jpeg'),
    storage_key text NOT NULL UNIQUE CHECK (char_length(storage_key) > 0),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
    width integer NOT NULL CHECK (width >= 1),
    height integer NOT NULL CHECK (height >= 1),
    captured_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    CHECK (updated_at >= created_at)
);

CREATE TABLE support_requests (
    id text PRIMARY KEY CHECK (char_length(id) > 0),
    user_id text NOT NULL,
    family_id text NOT NULL,
    initial_screenshot_artifact_id text NOT NULL REFERENCES artifacts (id) ON DELETE RESTRICT,
    comment text NOT NULL DEFAULT '' CHECK (char_length(comment) <= 500),
    status text NOT NULL CHECK (status IN ('PENDING', 'IN_SUPPORT', 'RESOLVED')),
    support_session_id text,
    guide_context jsonb,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    FOREIGN KEY (user_id, family_id) REFERENCES user_pairs (user_id, family_id) ON DELETE RESTRICT,
    CHECK (updated_at >= created_at),
    CHECK (
        guide_context IS NULL
        OR (
            jsonb_typeof(guide_context) = 'object'
            AND guide_context ?& ARRAY[
                'guideRunId',
                'guideId',
                'guideVersionNumber',
                'stepNumber',
                'guideTitle',
                'stepInstruction',
                'stepArtifactId'
            ]
            AND guide_context - ARRAY[
                'guideRunId',
                'guideId',
                'guideVersionNumber',
                'stepNumber',
                'guideTitle',
                'stepInstruction',
                'stepArtifactId'
            ] = '{}'::jsonb
            AND jsonb_typeof(guide_context -> 'guideRunId') = 'string'
            AND char_length(guide_context ->> 'guideRunId') > 0
            AND jsonb_typeof(guide_context -> 'guideId') = 'string'
            AND char_length(guide_context ->> 'guideId') > 0
            AND jsonb_typeof(guide_context -> 'guideVersionNumber') = 'number'
            AND (guide_context ->> 'guideVersionNumber') ~ '^[1-9][0-9]*$'
            AND jsonb_typeof(guide_context -> 'stepNumber') = 'number'
            AND (guide_context ->> 'stepNumber') ~ '^[1-9][0-9]*$'
            AND jsonb_typeof(guide_context -> 'guideTitle') = 'string'
            AND char_length(guide_context ->> 'guideTitle') BETWEEN 1 AND 40
            AND btrim(guide_context ->> 'guideTitle') <> ''
            AND jsonb_typeof(guide_context -> 'stepInstruction') = 'string'
            AND char_length(guide_context ->> 'stepInstruction') BETWEEN 1 AND 120
            AND btrim(guide_context ->> 'stepInstruction') <> ''
            AND jsonb_typeof(guide_context -> 'stepArtifactId') = 'string'
            AND char_length(guide_context ->> 'stepArtifactId') > 0
        )
    )
);

CREATE UNIQUE INDEX support_requests_support_session_id_key
    ON support_requests (support_session_id)
    WHERE support_session_id IS NOT NULL;

CREATE UNIQUE INDEX support_requests_one_active_per_user_key
    ON support_requests (user_id)
    WHERE status IN ('PENDING', 'IN_SUPPORT');

CREATE TABLE support_sessions (
    id text PRIMARY KEY CHECK (char_length(id) > 0),
    support_request_id text NOT NULL UNIQUE REFERENCES support_requests (id) ON DELETE RESTRICT,
    user_id text NOT NULL,
    family_id text NOT NULL,
    livekit_room_name text NOT NULL UNIQUE CHECK (char_length(livekit_room_name) > 0),
    status text NOT NULL CHECK (status IN ('RINGING', 'ACTIVE', 'GENERATING_GUIDE', 'REVIEWING_GUIDE', 'ENDED')),
    guide_decision text CHECK (guide_decision IN ('CREATE', 'SKIP')),
    guide_material_batch_id text,
    guide_generation_job_id text,
    guide_draft_id text,
    guide_id text,
    consent jsonb,
    consented_at timestamptz,
    started_at timestamptz,
    ended_at timestamptz,
    end_reason text CHECK (end_reason IN ('GUIDE_SKIPPED', 'GUIDE_SAVED', 'GUIDE_CANCELLED', 'NO_MATERIALS')),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    FOREIGN KEY (user_id, family_id) REFERENCES user_pairs (user_id, family_id) ON DELETE RESTRICT,
    CHECK (updated_at >= created_at),
    CHECK (consent IS NULL OR consent = '{"audio": true, "screenShare": true, "periodicCapture": true, "textVersion": "v1"}'::jsonb),
    CHECK (started_at IS NULL OR consented_at IS NULL OR started_at >= consented_at),
    CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at),
    CHECK (
        (status = 'RINGING'
            AND consent IS NULL
            AND consented_at IS NULL
            AND started_at IS NULL
            AND guide_decision IS NULL
            AND guide_material_batch_id IS NULL
            AND guide_generation_job_id IS NULL
            AND guide_draft_id IS NULL
            AND guide_id IS NULL
            AND ended_at IS NULL
            AND end_reason IS NULL)
        OR
        (status = 'ACTIVE'
            AND consent IS NOT NULL
            AND consented_at IS NOT NULL
            AND started_at IS NOT NULL
            AND guide_decision IS NULL
            AND guide_material_batch_id IS NULL
            AND guide_generation_job_id IS NULL
            AND guide_draft_id IS NULL
            AND guide_id IS NULL
            AND ended_at IS NULL
            AND end_reason IS NULL)
        OR
        (status = 'GENERATING_GUIDE'
            AND consent IS NOT NULL
            AND consented_at IS NOT NULL
            AND started_at IS NOT NULL
            AND guide_decision = 'CREATE'
            AND guide_draft_id IS NULL
            AND guide_id IS NULL
            AND ended_at IS NULL
            AND end_reason IS NULL)
        OR
        (status = 'REVIEWING_GUIDE'
            AND consent IS NOT NULL
            AND consented_at IS NOT NULL
            AND started_at IS NOT NULL
            AND guide_decision = 'CREATE'
            AND guide_draft_id IS NOT NULL
            AND guide_id IS NULL
            AND ended_at IS NULL
            AND end_reason IS NULL)
        OR
        (status = 'ENDED'
            AND consent IS NOT NULL
            AND consented_at IS NOT NULL
            AND started_at IS NOT NULL
            AND ended_at IS NOT NULL
            AND end_reason IS NOT NULL
            AND (
                (end_reason = 'GUIDE_SKIPPED'
                    AND guide_decision = 'SKIP'
                    AND guide_material_batch_id IS NULL
                    AND guide_generation_job_id IS NULL
                    AND guide_draft_id IS NULL
                    AND guide_id IS NULL)
                OR
                (end_reason = 'GUIDE_SAVED'
                    AND guide_decision = 'CREATE'
                    AND guide_material_batch_id IS NULL
                    AND guide_generation_job_id IS NULL
                    AND guide_draft_id IS NOT NULL
                    AND guide_id IS NOT NULL)
                OR
                (end_reason IN ('GUIDE_CANCELLED', 'NO_MATERIALS')
                    AND guide_decision = 'CREATE'
                    AND guide_material_batch_id IS NULL
                    AND guide_generation_job_id IS NULL
                    AND guide_draft_id IS NULL
                    AND guide_id IS NULL)
            ))
    )
);

CREATE UNIQUE INDEX support_sessions_one_active_per_user_key
    ON support_sessions (user_id)
    WHERE status <> 'ENDED';

ALTER TABLE support_requests
    ADD CONSTRAINT support_requests_support_session_id_fkey
    FOREIGN KEY (support_session_id) REFERENCES support_sessions (id) ON DELETE RESTRICT;

CREATE TABLE guide_material_batches (
    id text PRIMARY KEY CHECK (char_length(id) > 0),
    support_session_id text NOT NULL UNIQUE REFERENCES support_sessions (id) ON DELETE RESTRICT,
    status text NOT NULL CHECK (status IN ('UPLOADING', 'COMPLETED')),
    capture_interval_seconds integer NOT NULL CHECK (capture_interval_seconds = 5),
    expected_item_count integer NOT NULL CHECK (expected_item_count BETWEEN 1 AND 360),
    received_item_count integer NOT NULL DEFAULT 0 CHECK (received_item_count BETWEEN 0 AND 360),
    captured_from timestamptz NOT NULL,
    captured_to timestamptz NOT NULL,
    completed_at timestamptz,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    CHECK (received_item_count <= expected_item_count),
    CHECK (captured_from <= captured_to),
    CHECK (updated_at >= created_at),
    CHECK (
        (status = 'UPLOADING' AND completed_at IS NULL)
        OR (status = 'COMPLETED' AND completed_at IS NOT NULL)
    )
);

ALTER TABLE support_sessions
    ADD CONSTRAINT support_sessions_guide_material_batch_id_fkey
    FOREIGN KEY (guide_material_batch_id) REFERENCES guide_material_batches (id) ON DELETE RESTRICT;

CREATE TABLE guide_materials (
    id text PRIMARY KEY CHECK (char_length(id) > 0),
    batch_id text NOT NULL REFERENCES guide_material_batches (id) ON DELETE RESTRICT,
    client_capture_id text NOT NULL CHECK (char_length(client_capture_id) > 0),
    artifact_id text NOT NULL UNIQUE REFERENCES artifacts (id) ON DELETE RESTRICT,
    sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 360),
    captured_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL,
    UNIQUE (batch_id, client_capture_id),
    UNIQUE (batch_id, sequence)
);

CREATE TABLE guide_generation_jobs (
    id text PRIMARY KEY CHECK (char_length(id) > 0),
    batch_id text NOT NULL UNIQUE REFERENCES guide_material_batches (id) ON DELETE RESTRICT,
    status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
    attempt integer NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 3),
    guide_draft_id text,
    error_code text CHECK (error_code IN (
        'AI_TIMEOUT',
        'AI_UNAVAILABLE',
        'AI_REFUSAL',
        'AI_INCOMPLETE_RESPONSE',
        'AI_INVALID_OUTPUT',
        'AI_INPUT_UNAVAILABLE',
        'WORKER_RESTARTED'
    )),
    created_at timestamptz NOT NULL,
    started_at timestamptz,
    finished_at timestamptz,
    updated_at timestamptz NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    CHECK (updated_at >= created_at),
    CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at),
    CHECK (
        (status = 'QUEUED'
            AND attempt BETWEEN 0 AND 2
            AND started_at IS NULL
            AND finished_at IS NULL
            AND error_code IS NULL
            AND guide_draft_id IS NULL)
        OR
        (status = 'RUNNING'
            AND attempt BETWEEN 1 AND 3
            AND started_at IS NOT NULL
            AND finished_at IS NULL
            AND error_code IS NULL
            AND guide_draft_id IS NULL)
        OR
        (status = 'SUCCEEDED'
            AND attempt BETWEEN 1 AND 3
            AND started_at IS NOT NULL
            AND finished_at IS NOT NULL
            AND error_code IS NULL
            AND guide_draft_id IS NOT NULL)
        OR
        (status = 'FAILED'
            AND attempt BETWEEN 1 AND 3
            AND started_at IS NOT NULL
            AND finished_at IS NOT NULL
            AND error_code IS NOT NULL
            AND guide_draft_id IS NULL)
    )
);

ALTER TABLE support_sessions
    ADD CONSTRAINT support_sessions_guide_generation_job_id_fkey
    FOREIGN KEY (guide_generation_job_id) REFERENCES guide_generation_jobs (id) ON DELETE RESTRICT;

CREATE TABLE guide_drafts (
    id text PRIMARY KEY CHECK (char_length(id) > 0),
    support_session_id text NOT NULL UNIQUE REFERENCES support_sessions (id) ON DELETE RESTRICT,
    title text NOT NULL CHECK (
        char_length(title) BETWEEN 1 AND 40
        AND btrim(title) <> ''
    ),
    steps jsonb NOT NULL CHECK (
        jsonb_typeof(steps) = 'array'
        AND jsonb_array_length(steps) BETWEEN 1 AND 8
    ),
    status text NOT NULL CHECK (status IN ('EDITING', 'SAVED')),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    CHECK (updated_at >= created_at)
);

ALTER TABLE support_sessions
    ADD CONSTRAINT support_sessions_guide_draft_id_fkey
    FOREIGN KEY (guide_draft_id) REFERENCES guide_drafts (id) ON DELETE RESTRICT;

ALTER TABLE guide_generation_jobs
    ADD CONSTRAINT guide_generation_jobs_guide_draft_id_fkey
    FOREIGN KEY (guide_draft_id) REFERENCES guide_drafts (id) ON DELETE RESTRICT;

CREATE TABLE guides (
    id text PRIMARY KEY CHECK (char_length(id) > 0),
    user_id text NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    title text NOT NULL CHECK (
        char_length(title) BETWEEN 1 AND 40
        AND btrim(title) <> ''
    ),
    current_version_number integer NOT NULL DEFAULT 1 CHECK (current_version_number >= 1),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision = 1),
    CHECK (updated_at >= created_at)
);

CREATE TABLE guide_versions (
    guide_id text NOT NULL REFERENCES guides (id) ON DELETE RESTRICT,
    version_number integer NOT NULL CHECK (version_number >= 1),
    title text NOT NULL CHECK (
        char_length(title) BETWEEN 1 AND 40
        AND btrim(title) <> ''
    ),
    created_by text NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (guide_id, version_number)
);

CREATE TABLE guide_version_steps (
    guide_id text NOT NULL,
    version_number integer NOT NULL,
    position integer NOT NULL CHECK (position BETWEEN 1 AND 8),
    artifact_id text NOT NULL REFERENCES artifacts (id) ON DELETE RESTRICT,
    instruction text NOT NULL CHECK (
        char_length(instruction) BETWEEN 1 AND 120
        AND btrim(instruction) <> ''
    ),
    PRIMARY KEY (guide_id, version_number, position),
    FOREIGN KEY (guide_id, version_number)
        REFERENCES guide_versions (guide_id, version_number) ON DELETE RESTRICT
);

ALTER TABLE support_sessions
    ADD CONSTRAINT support_sessions_guide_id_fkey
    FOREIGN KEY (guide_id) REFERENCES guides (id) ON DELETE RESTRICT;

CREATE TABLE guide_runs (
    id text PRIMARY KEY CHECK (char_length(id) > 0),
    guide_id text NOT NULL,
    guide_version_number integer NOT NULL,
    user_id text NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    status text NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'PAUSED_FOR_SUPPORT')),
    current_step_number integer NOT NULL CHECK (current_step_number BETWEEN 1 AND 8),
    support_request_id text,
    started_at timestamptz NOT NULL,
    completed_at timestamptz,
    paused_at timestamptz,
    updated_at timestamptz NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    FOREIGN KEY (guide_id, guide_version_number)
        REFERENCES guide_versions (guide_id, version_number) ON DELETE RESTRICT,
    CHECK (updated_at >= started_at),
    CHECK (
        (status = 'IN_PROGRESS'
            AND support_request_id IS NULL
            AND completed_at IS NULL
            AND paused_at IS NULL)
        OR
        (status = 'COMPLETED'
            AND support_request_id IS NULL
            AND completed_at IS NOT NULL
            AND paused_at IS NULL)
        OR
        (status = 'PAUSED_FOR_SUPPORT'
            AND support_request_id IS NOT NULL
            AND completed_at IS NULL
            AND paused_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX guide_runs_support_request_id_key
    ON guide_runs (support_request_id)
    WHERE support_request_id IS NOT NULL;

ALTER TABLE guide_runs
    ADD CONSTRAINT guide_runs_support_request_id_fkey
    FOREIGN KEY (support_request_id) REFERENCES support_requests (id) ON DELETE RESTRICT;

CREATE TABLE idempotency_records (
    actor_id text NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    method text NOT NULL CHECK (method = 'POST'),
    path text NOT NULL CHECK (char_length(path) > 0),
    key text NOT NULL CHECK (
        char_length(key) BETWEEN 1 AND 128
        AND key ~ '^[ -~]+$'
    ),
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    status text NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED')),
    resource_id text,
    response_status integer CHECK (response_status BETWEEN 100 AND 599),
    response_body jsonb,
    lease_expires_at timestamptz,
    created_at timestamptz NOT NULL,
    completed_at timestamptz,
    expires_at timestamptz,
    PRIMARY KEY (actor_id, method, path, key),
    CHECK (
        (status = 'IN_PROGRESS'
            AND response_status IS NULL
            AND response_body IS NULL
            AND lease_expires_at IS NOT NULL
            AND completed_at IS NULL
            AND expires_at IS NULL)
        OR
        (status = 'COMPLETED'
            AND response_status IS NOT NULL
            AND response_body IS NOT NULL
            AND lease_expires_at IS NULL
            AND completed_at IS NOT NULL
            AND expires_at IS NOT NULL
            AND expires_at = completed_at + interval '24 hours')
    )
);

CREATE INDEX idempotency_records_expires_at_idx
    ON idempotency_records (expires_at)
    WHERE status = 'COMPLETED';

CREATE INDEX idempotency_records_stale_lease_idx
    ON idempotency_records (lease_expires_at)
    WHERE status = 'IN_PROGRESS';

CREATE TABLE artifact_deletion_tasks (
    id text PRIMARY KEY CHECK (char_length(id) > 0),
    artifact_id text,
    storage_key text NOT NULL UNIQUE CHECK (char_length(storage_key) > 0),
    status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING')),
    attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    next_attempt_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL
);

CREATE INDEX artifact_deletion_tasks_next_attempt_at_idx
    ON artifact_deletion_tasks (next_attempt_at);

INSERT INTO users (id, role, display_name)
VALUES
    ('user_demo', 'USER', '利用者'),
    ('family_demo', 'FAMILY', '家族')
ON CONFLICT (id) DO UPDATE
SET
    role = EXCLUDED.role,
    display_name = EXCLUDED.display_name;

INSERT INTO user_pairs (user_id, family_id)
VALUES ('user_demo', 'family_demo')
ON CONFLICT (user_id, family_id) DO NOTHING;
