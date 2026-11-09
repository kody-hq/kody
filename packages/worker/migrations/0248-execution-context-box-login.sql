-- The box login (ADR 0096): who the machine is logged in as, so Kody can
-- warn grantees when the box can do more than they can. NULL login_kind
-- means not yet recorded (a context registered before this column); Kody
-- treats it as the operator person until the daemon's next login check.
ALTER TABLE execution_contexts ADD COLUMN login_kind TEXT CHECK (login_kind IN ('person', 'profile'));
ALTER TABLE execution_contexts ADD COLUMN login_user_id TEXT;
ALTER TABLE execution_contexts ADD COLUMN login_profile_id TEXT;
ALTER TABLE execution_contexts ADD COLUMN login_token_id TEXT;
ALTER TABLE execution_contexts ADD COLUMN login_checked_at TEXT;
-- The team the operator says the box is for (misconfiguration checks only).
ALTER TABLE execution_contexts ADD COLUMN team_id TEXT;

-- The team a person-owned agent profile is for. Confers nothing.
ALTER TABLE profiles ADD COLUMN assigned_team_id TEXT;

-- Current excess-access and misconfiguration state per context and subject.
-- A notification is a move to a new fingerprint; delivered_* record which
-- fingerprint the execute and search payloads already carried.
CREATE TABLE execution_context_notices (
	context_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('elevation', 'misconfigured')),
	-- '' for a context-level notice (misconfigured).
	subject_user_id TEXT NOT NULL DEFAULT '',
	fingerprint TEXT NOT NULL,
	detail_json TEXT NOT NULL,
	raised_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	dismissed_fingerprint TEXT,
	dismissed_at TEXT,
	delivered_execute_fingerprint TEXT,
	delivered_search_fingerprint TEXT,
	PRIMARY KEY (context_id, org_id, kind, subject_user_id)
);

CREATE INDEX execution_context_notices_subject
	ON execution_context_notices (subject_user_id, org_id);
