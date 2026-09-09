-- Keep historical consent and batch intervals unchanged; new accepts use v2/10s.
-- Only replace the three checks affected by the new in-call saved state and consent.
DO $$
DECLARE item record;
BEGIN
    FOR item IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.support_sessions'::regclass AND contype = 'c'
          AND (pg_get_constraintdef(oid) LIKE '%RINGING%'
            OR pg_get_constraintdef(oid) LIKE '%textVersion%')
    LOOP
        EXECUTE format('ALTER TABLE public.support_sessions DROP CONSTRAINT %I', item.conname);
    END LOOP;
END $$;

ALTER TABLE support_sessions
    ADD CONSTRAINT support_sessions_status_check
        CHECK (status IN ('RINGING', 'ACTIVE', 'GENERATING_GUIDE', 'REVIEWING_GUIDE', 'GUIDE_SAVED', 'ENDED')),
    ADD CONSTRAINT support_sessions_consent_check CHECK (
        consent IS NULL OR consent IN (
            '{"audio": true, "screenShare": true, "periodicCapture": true, "textVersion": "v1"}'::jsonb,
            '{"audio": true, "screenShare": true, "periodicCapture": true, "textVersion": "v2"}'::jsonb
        )
    ),
    ADD CONSTRAINT support_sessions_state_check CHECK (
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
        (status = 'GUIDE_SAVED'
            AND consent IS NOT NULL
            AND consented_at IS NOT NULL
            AND started_at IS NOT NULL
            AND guide_decision = 'CREATE'
            AND guide_material_batch_id IS NULL
            AND guide_generation_job_id IS NULL
            AND guide_draft_id IS NOT NULL
            AND guide_id IS NOT NULL
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
    );

ALTER TABLE guide_material_batches
    DROP CONSTRAINT guide_material_batches_capture_interval_seconds_check,
    ADD CONSTRAINT guide_material_batches_capture_interval_seconds_check
        CHECK (capture_interval_seconds IN (5, 10));
