-- Per-provider-event ledger for deliverability side effects (recipient
-- cooldowns, rejecting-provider holds, verification hard-bounce
-- suppression). Provider-event insert is idempotent, so a queue retry after
-- a crash between that insert and the side effects sees a duplicate; this
-- pending/claimed/applied marker lets the retry apply them exactly once,
-- and keeps two concurrent deliveries of one event from both applying.

CREATE TABLE email_deliverability_effects (
	provider_event_id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	claimed_at TEXT,
	applied_at TEXT
);

CREATE INDEX idx_email_deliverability_effects_user_id
	ON email_deliverability_effects(user_id);

-- Events already processed before this ledger existed had their side
-- effects applied; mark them so a late redelivery does not count twice.
INSERT OR IGNORE INTO email_deliverability_effects (
	provider_event_id, user_id, created_at, claimed_at, applied_at
)
SELECT provider_event_id, user_id, created_at, created_at, created_at
FROM email_outbound_failure_tracking;
