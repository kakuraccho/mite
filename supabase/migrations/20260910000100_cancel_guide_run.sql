-- A cancelled run ends this attempt without recording the guide as completed.
ALTER TABLE guide_runs DROP CONSTRAINT guide_runs_status_check;
ALTER TABLE guide_runs ADD CONSTRAINT guide_runs_status_check
    CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'PAUSED_FOR_SUPPORT'));

ALTER TABLE guide_runs DROP CONSTRAINT guide_runs_check1;
ALTER TABLE guide_runs ADD CONSTRAINT guide_runs_check1 CHECK (
    (status IN ('IN_PROGRESS', 'CANCELLED')
        AND support_request_id IS NULL AND completed_at IS NULL AND paused_at IS NULL)
    OR (status = 'COMPLETED'
        AND support_request_id IS NULL AND completed_at IS NOT NULL AND paused_at IS NULL)
    OR (status = 'PAUSED_FOR_SUPPORT'
        AND support_request_id IS NOT NULL AND completed_at IS NULL AND paused_at IS NOT NULL)
);
