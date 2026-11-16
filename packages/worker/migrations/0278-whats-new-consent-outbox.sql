-- What's New in Kody consent and subscriber changes waiting to reach admin
-- package subscribers (`whats_new.consent.changed`). A row is written with the
-- change and deleted once every subscriber handled it, so a failed queue send
-- or delivery is retried by the next change instead of being lost.
CREATE TABLE whats_new_consent_outbox (
	id TEXT PRIMARY KEY,
	-- users.stable_user_id, or newsletter_signups.stable_id for an address
	-- with no account.
	recipient_id TEXT NOT NULL,
	-- NULL when the account has made no choice (a newly verified account).
	opted_in INTEGER CHECK (opted_in IN (0, 1)),
	source TEXT,
	occurred_at TEXT NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL
);

CREATE INDEX idx_whats_new_consent_outbox_created_at
	ON whats_new_consent_outbox(created_at);
