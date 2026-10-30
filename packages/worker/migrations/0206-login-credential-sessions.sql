-- Login credential sessions (ADR 0068, 2026-10-29): the session token a
-- `login` credential's exchange returned, encrypted with its own purpose so
-- the ciphertext is never interchangeable with `secret_entries` values. One
-- row per credential. `revision` is the credential revision the session was
-- minted for, so any edit to the value, exchange, hosts, or inject strands it.
-- `lease_id` / `lease_expires_at` let one exchange run at a time across
-- isolates; a crashed holder's lease lapses after `lease_expires_at`.
CREATE TABLE login_credential_sessions (
	credential_id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	revision TEXT,
	session_id TEXT,
	session_encrypted TEXT,
	expires_at INTEGER,
	lease_id TEXT,
	lease_expires_at INTEGER,
	updated_at TEXT NOT NULL
);

CREATE INDEX login_credential_sessions_user_id
	ON login_credential_sessions (user_id);
