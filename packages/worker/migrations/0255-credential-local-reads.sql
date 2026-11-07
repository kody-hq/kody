-- Local reads (ADR 0096): a person turns on reading a secret's value on
-- their own machine with the Kody CLI. Off unless a row says enabled = 1.
-- last_read_at backs the "last local read" badge and is kept for good.
CREATE TABLE credential_local_read_settings (
	credential_id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
	updated_by_user_id TEXT,
	updated_at TEXT NOT NULL,
	last_read_at TEXT
);

CREATE INDEX idx_credential_local_read_settings_org
	ON credential_local_read_settings (org_id);

-- Every local read, allowed or refused. Never the value. Pruned after 90 days.
CREATE TABLE credential_local_read_events (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	credential_id TEXT NOT NULL,
	actor_user_id TEXT,
	actor_username TEXT,
	token_id TEXT,
	token_name TEXT,
	profile_id TEXT,
	profile_name TEXT,
	command TEXT NOT NULL CHECK (command IN ('run', 'get')),
	ip TEXT,
	outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'refused')),
	refusal_reason TEXT,
	created_at TEXT NOT NULL
);

CREATE INDEX idx_credential_local_read_events_credential_time
	ON credential_local_read_events (credential_id, created_at DESC);

CREATE INDEX idx_credential_local_read_events_time
	ON credential_local_read_events (created_at);
