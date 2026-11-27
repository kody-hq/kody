-- Caller-chosen idempotency keys for newsletter sends
-- (`adminWhatsNewEmailSend` idempotency_key). A key is reserved before the
-- daily counter or Cloudflare is touched. A retry of a sent key returns the
-- stored result instead of sending again; a retry of an attempt that never
-- finished (pending, or lost in transport) is refused as outcome unknown.
-- Failed attempts that never reached Cloudflare may be retried. Rows expire
-- with the 90-day system send retention.
CREATE TABLE system_email_send_keys (
	kind TEXT NOT NULL,
	idempotency_key TEXT NOT NULL,
	recipient TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('pending', 'sent', 'failed', 'unknown')),
	sender TEXT,
	provider_message_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (kind, idempotency_key)
);

CREATE INDEX idx_system_email_send_keys_updated_at
	ON system_email_send_keys(updated_at);
