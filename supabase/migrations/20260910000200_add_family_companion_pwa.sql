ALTER TABLE support_requests
    DROP CONSTRAINT support_requests_status_check;

ALTER TABLE support_requests
    ADD CONSTRAINT support_requests_status_check
    CHECK (status IN ('PENDING', 'IN_SUPPORT', 'RESOLVED', 'CANCELLED')),
    ADD COLUMN acknowledged_at timestamptz,
    ADD COLUMN acknowledgement_kind text,
    ADD COLUMN estimated_support_at timestamptz,
    ADD CONSTRAINT support_requests_acknowledgement_check CHECK (
        (
            acknowledged_at IS NULL
            AND acknowledgement_kind IS NULL
            AND estimated_support_at IS NULL
        )
        OR (
            acknowledged_at IS NOT NULL
            AND acknowledgement_kind IN ('NOW', 'UNKNOWN')
            AND estimated_support_at IS NULL
        )
        OR (
            acknowledged_at IS NOT NULL
            AND acknowledgement_kind = 'SCHEDULED'
            AND estimated_support_at IS NOT NULL
        )
    ),
    ADD CONSTRAINT support_requests_cancelled_session_check CHECK (
        status <> 'CANCELLED' OR support_session_id IS NULL
    );

CREATE TABLE user_presences (
    user_id text PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
    connected_since timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    connection_epoch bigint NOT NULL CHECK (connection_epoch >= 1),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    CHECK (connected_since <= last_seen_at),
    CHECK (created_at <= updated_at),
    CHECK (last_seen_at <= updated_at)
);

CREATE TABLE push_subscriptions (
    id text PRIMARY KEY CHECK (char_length(id) > 0),
    family_id text NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    endpoint text NOT NULL UNIQUE CHECK (
        char_length(endpoint) BETWEEN 1 AND 2048
        AND endpoint LIKE 'https://%'
    ),
    p256dh text NOT NULL CHECK (char_length(p256dh) BETWEEN 1 AND 256),
    auth text NOT NULL CHECK (char_length(auth) BETWEEN 1 AND 256),
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
    CHECK (created_at <= updated_at)
);

CREATE INDEX push_subscriptions_family_id_idx
    ON push_subscriptions (family_id, created_at);

CREATE TABLE support_request_presence_notifications (
    support_request_id text NOT NULL REFERENCES support_requests (id) ON DELETE RESTRICT,
    connection_epoch bigint NOT NULL CHECK (connection_epoch >= 0),
    created_at timestamptz NOT NULL,
    PRIMARY KEY (support_request_id, connection_epoch)
);
