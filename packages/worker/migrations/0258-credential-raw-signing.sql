-- Raw RSA signing (ADR 0099): the owner of a signing credential lets code
-- sign any string with it. Off unless a row says enabled = 1.
CREATE TABLE credential_raw_signing_settings (
	credential_id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
	updated_by_user_id TEXT,
	updated_at TEXT NOT NULL,
	last_signed_at TEXT
);

CREATE INDEX idx_credential_raw_signing_settings_org
	ON credential_raw_signing_settings (org_id);

-- Every raw signature, made or refused. Never the key, message, or
-- signature. Pruned after 90 days.
CREATE TABLE credential_raw_signing_events (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	credential_id TEXT NOT NULL,
	actor_user_id TEXT,
	actor_username TEXT,
	token_id TEXT,
	via TEXT,
	profile_id TEXT,
	package_id TEXT,
	message_bytes INTEGER,
	outcome TEXT NOT NULL CHECK (outcome IN ('signed', 'refused')),
	refusal_reason TEXT,
	created_at TEXT NOT NULL
);

CREATE INDEX idx_credential_raw_signing_events_credential_time
	ON credential_raw_signing_events (credential_id, created_at DESC);

CREATE INDEX idx_credential_raw_signing_events_time
	ON credential_raw_signing_events (created_at);
