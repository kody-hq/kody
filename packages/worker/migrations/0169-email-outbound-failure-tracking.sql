-- Per-provider-event ledger for consecutive-failure pause counting.
-- Provider-event insert is already idempotent; this table is a separate
-- pending/applied marker so a queue retry after a mid-flight tracking
-- crash can still apply the count exactly once.

CREATE TABLE email_outbound_failure_tracking (
	provider_event_id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	delivery_status TEXT NOT NULL,
	created_at TEXT NOT NULL,
	applied_at TEXT
);

CREATE INDEX idx_email_outbound_failure_tracking_user_id
	ON email_outbound_failure_tracking(user_id);

CREATE INDEX idx_email_outbound_failure_tracking_pending
	ON email_outbound_failure_tracking(created_at)
	WHERE applied_at IS NULL;
