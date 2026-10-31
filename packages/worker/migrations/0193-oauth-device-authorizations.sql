-- OAuth 2.0 Device Authorization Grant (RFC 8628) requests for Kody's own
-- authorization server (ADR 0082). `POST /oauth/device_authorization` inserts
-- a pending row; the signed-in person approves or denies it on `/device`; the
-- device polls `/oauth/token` and the approved row is consumed exactly once.
-- Only the SHA-256 of the device_code is stored. `user_id` is the approving
-- person (null until a decision). Rows live about ten minutes and are purged a
-- day after they expire.
CREATE TABLE oauth_device_authorizations (
	id TEXT PRIMARY KEY NOT NULL,
	device_code_hash TEXT NOT NULL UNIQUE,
	user_code TEXT NOT NULL UNIQUE,
	client_id TEXT NOT NULL,
	scope TEXT NOT NULL,
	resource TEXT NOT NULL,
	requested_org_slug TEXT,
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
	interval_seconds INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	last_polled_at INTEGER,
	user_id TEXT,
	org_id TEXT,
	decided_at INTEGER,
	consumed_at INTEGER
);

CREATE INDEX oauth_device_authorizations_expires_idx
	ON oauth_device_authorizations (expires_at);
CREATE INDEX oauth_device_authorizations_user_idx
	ON oauth_device_authorizations (user_id);
