-- New accepts explain that support ends when all guides are saved.
-- Preserve v1-v3 consent records and already persisted session revisions.
ALTER TABLE public.support_sessions
    DROP CONSTRAINT support_sessions_consent_check,
    ADD CONSTRAINT support_sessions_consent_check CHECK (
        consent IS NULL OR consent IN (
            '{"audio": true, "screenShare": true, "periodicCapture": true, "textVersion": "v1"}'::jsonb,
            '{"audio": true, "screenShare": true, "periodicCapture": true, "textVersion": "v2"}'::jsonb,
            '{"audio": true, "screenShare": true, "periodicCapture": true, "textVersion": "v3"}'::jsonb,
            '{"audio": true, "screenShare": true, "periodicCapture": true, "textVersion": "v4"}'::jsonb
        )
    );
