-- auth.md `service_auth` agent registrations (ADR 0091). `POST /agent/identity`
-- inserts a pending row bound to the agent-supplied email; the signed-in person
-- whose verified email matches claims it on `/agent/claim` by typing the code
-- the agent showed them; the agent polls `/oauth/token` with the claim grant
-- and the claimed row is consumed exactly once for a `kody_at_` token. Only
-- SHA-256 hashes of the claim token, the claim attempt token, and the user code
-- are stored. `user_id` is the claiming person (null until a decision). Rows
-- live up to a day and are purged a day after they expire.
CREATE TABLE agent_registrations (
	id TEXT PRIMARY KEY NOT NULL,
	claim_token_hash TEXT NOT NULL UNIQUE,
	claim_email TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending'
		CHECK (status IN ('pending', 'claimed', 'denied', 'consumed')),
	attempt_id TEXT NOT NULL,
	attempt_token_hash TEXT NOT NULL UNIQUE,
	user_code_hash TEXT NOT NULL,
	attempt_expires_at INTEGER NOT NULL,
	interval_seconds INTEGER NOT NULL,
	last_polled_at INTEGER,
	idle_ttl_seconds INTEGER NOT NULL,
	max_lifetime_seconds INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	user_id TEXT,
	org_id TEXT,
	claimed_at INTEGER,
	consumed_at INTEGER
);

CREATE INDEX agent_registrations_expires_idx
	ON agent_registrations (expires_at);
CREATE INDEX agent_registrations_user_idx
	ON agent_registrations (user_id);
