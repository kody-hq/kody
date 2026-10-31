-- Execution contexts: machines a person registers so Kody can run code on
-- them. These tables are inert: no route, capability, or job reads or writes
-- them yet, and the `execution-contexts` feature flag (off) gates the feature
-- that will. Purely additive, so an older Worker ignores them.
--
-- `org_id` is the owning org (the registrant's personal org unless the
-- machine is registered to an org). `operator_user_id` is the person who
-- registered it and keeps control of the machine. `all_members` shares the
-- context with everyone in the owning org; other shares are `grants` rows
-- with resource_type `execution_context`.

CREATE TABLE execution_contexts (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	operator_user_id TEXT NOT NULL,
	all_members INTEGER NOT NULL DEFAULT 0 CHECK (all_members IN (0, 1)),
	name TEXT NOT NULL,
	public_key_jwk TEXT NOT NULL,
	thumbprint TEXT NOT NULL,
	created_at TEXT NOT NULL,
	revoked_at TEXT,
	revoked_reason TEXT,
	last_seen_at TEXT,
	client_name TEXT,
	client_version TEXT,
	capabilities_json TEXT,
	grant_json TEXT,
	grant_version INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX execution_contexts_org_name ON execution_contexts (org_id, name);
CREATE UNIQUE INDEX execution_contexts_thumbprint ON execution_contexts (thumbprint);
CREATE INDEX execution_contexts_operator ON execution_contexts (operator_user_id);

-- Every non-operator person who uses a context, per org they use it in.
CREATE TABLE execution_context_opt_ins (
	context_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (context_id, user_id, org_id)
);

CREATE INDEX execution_context_opt_ins_user ON execution_context_opt_ins (user_id);
CREATE INDEX execution_context_opt_ins_org_user ON execution_context_opt_ins (org_id, user_id);

-- A context attached to another org (the credential_org_grants pattern,
-- 0116). The context stays in its owning org. `narrowing_json` can only
-- narrow what the context allows, for runs bound to this org.
CREATE TABLE execution_context_org_attachments (
	context_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	attached_by_user_id TEXT NOT NULL,
	all_members INTEGER NOT NULL DEFAULT 0 CHECK (all_members IN (0, 1)),
	narrowing_json TEXT,
	created_at TEXT NOT NULL,
	PRIMARY KEY (context_id, org_id)
);

CREATE INDEX execution_context_org_attachments_org ON execution_context_org_attachments (org_id);
CREATE INDEX execution_context_org_attachments_attached_by ON execution_context_org_attachments (attached_by_user_id);

-- One ordered chain per person per org. `version` is bumped in the same
-- batch that rewrites the entries, so a stale write can be refused.
CREATE TABLE execution_context_chains (
	org_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	strict INTEGER NOT NULL DEFAULT 0 CHECK (strict IN (0, 1)),
	version INTEGER NOT NULL DEFAULT 0,
	updated_at TEXT NOT NULL,
	updated_by_kind TEXT NOT NULL CHECK (updated_by_kind IN ('user', 'agent')),
	updated_by_label TEXT,
	PRIMARY KEY (org_id, user_id)
);

CREATE INDEX execution_context_chains_user ON execution_context_chains (user_id);

-- A null context_id is the Kody cloud entry. Each context, and the cloud
-- entry, appears at most once per chain (SQLite treats nulls as distinct in
-- a unique index, so the cloud entry has its own partial index).
CREATE TABLE execution_context_chain_entries (
	org_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	position INTEGER NOT NULL CHECK (position >= 0),
	context_id TEXT,
	PRIMARY KEY (org_id, user_id, position)
);

CREATE UNIQUE INDEX execution_context_chain_entries_context_once
	ON execution_context_chain_entries (org_id, user_id, context_id);
CREATE UNIQUE INDEX execution_context_chain_entries_cloud_once
	ON execution_context_chain_entries (org_id, user_id)
	WHERE context_id IS NULL;
CREATE INDEX execution_context_chain_entries_context ON execution_context_chain_entries (context_id);
CREATE INDEX execution_context_chain_entries_user ON execution_context_chain_entries (user_id);

-- Short-lived registration challenges, consumed with DELETE ... RETURNING.
CREATE TABLE execution_context_registration_challenges (
	challenge_hash TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	expires_at TEXT NOT NULL
);

CREATE INDEX execution_context_registration_challenges_user ON execution_context_registration_challenges (user_id);
CREATE INDEX execution_context_registration_challenges_expires ON execution_context_registration_challenges (expires_at);
