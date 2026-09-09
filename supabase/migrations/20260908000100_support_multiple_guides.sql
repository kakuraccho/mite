-- Preserve existing drafts as the first guide in their support session.
ALTER TABLE guide_drafts
    DROP CONSTRAINT guide_drafts_support_session_id_key,
    ADD COLUMN position integer NOT NULL DEFAULT 1 CHECK (position >= 1),
    ADD COLUMN guide_id text UNIQUE REFERENCES guides (id) ON DELETE RESTRICT;

UPDATE guide_drafts draft
SET guide_id = session.guide_id
FROM support_sessions session
WHERE session.guide_draft_id = draft.id AND draft.status = 'SAVED';

ALTER TABLE guide_drafts
    ADD CONSTRAINT guide_drafts_session_position_key UNIQUE (support_session_id, position),
    ADD CONSTRAINT guide_drafts_saved_guide_check CHECK (
        (status = 'EDITING' AND guide_id IS NULL)
        OR (status = 'SAVED' AND guide_id IS NOT NULL)
    );
