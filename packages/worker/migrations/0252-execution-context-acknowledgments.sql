-- What a person acknowledged a shared execution context runs as (ADR 0097):
-- the box login and the excess access it had over them at that moment.
-- Required before their first run there; a new login or a new excess entry
-- needs a new acknowledgment, a removed entry does not.
CREATE TABLE execution_context_acknowledgments (
	context_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	principal_key TEXT NOT NULL,
	entries_json TEXT NOT NULL,
	acknowledged_at TEXT NOT NULL,
	PRIMARY KEY (context_id, org_id, user_id)
);

CREATE INDEX execution_context_acknowledgments_user
	ON execution_context_acknowledgments (user_id, org_id);
