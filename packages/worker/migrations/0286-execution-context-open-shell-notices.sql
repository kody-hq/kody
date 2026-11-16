-- A third notice kind: the machine still gives every run of its operator an
-- unrestricted shell with no package list. SQLite cannot change a CHECK, so
-- the table is rebuilt with the same rows.
CREATE TABLE execution_context_notices_next (
	context_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('elevation', 'misconfigured', 'open_shell')),
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

INSERT INTO execution_context_notices_next (
	context_id, org_id, kind, subject_user_id, fingerprint, detail_json,
	raised_at, updated_at, dismissed_fingerprint, dismissed_at,
	delivered_execute_fingerprint, delivered_search_fingerprint
)
SELECT
	context_id, org_id, kind, subject_user_id, fingerprint, detail_json,
	raised_at, updated_at, dismissed_fingerprint, dismissed_at,
	delivered_execute_fingerprint, delivered_search_fingerprint
FROM execution_context_notices;

DROP TABLE execution_context_notices;

ALTER TABLE execution_context_notices_next RENAME TO execution_context_notices;

CREATE INDEX execution_context_notices_subject
	ON execution_context_notices (subject_user_id, org_id);

-- Existing machines with host commands on and no package list for the shell
-- get the notice now, for their operator.
INSERT OR IGNORE INTO execution_context_notices (
	context_id, org_id, kind, subject_user_id, fingerprint, detail_json,
	raised_at, updated_at
)
SELECT
	c.id,
	c.org_id,
	'open_shell',
	c.operator_user_id,
	'open-shell',
	'{}',
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM execution_contexts c
WHERE c.revoked_at IS NULL
	AND json_extract(c.grant_json, '$.commands.enabled') = 1
	AND NOT EXISTS (
		SELECT 1 FROM machine_capabilities m
		WHERE m.context_id = c.id AND m.kind = 'shell' AND m.name = 'shell'
			AND m.removed_at IS NULL AND m.allowed_packages_json != '[]'
	);
