-- Per-message delivery cursor for mailbox lifecycle events. A failure event
-- can wait on an MX lookup while a newer delivered event for the same message
-- clears recipient cooldowns and rejecting-provider holds; the failure's hold
-- writes are guarded on this cursor still naming that event, so the older
-- failure cannot re-arm them. Additive; dropping it restores the old behavior.

CREATE TABLE email_mailbox_delivery_cursors (
	provider_message_id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	last_status TEXT NOT NULL,
	last_status_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE INDEX idx_email_mailbox_delivery_cursors_user_id
	ON email_mailbox_delivery_cursors(user_id);
