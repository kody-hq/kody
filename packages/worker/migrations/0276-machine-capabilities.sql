-- Machine access (execution context capability grants): each power a machine
-- offers (the shell, a named command, a set of local network destinations, a
-- host folder) is a named capability on its context. People, teams and
-- profiles are granted Use on it through `grants`, like a credential, and
-- `allowed_packages_json` is its package list ('[]' means no packages are
-- approved yet).
--
-- The machine defines a capability (kind, name, the summary it advertises);
-- Kody stores who may use it. `org_id` and `operator_user_id` mirror the
-- context row, which never changes either, so org and account deletion can
-- sweep these rows.
CREATE TABLE machine_capabilities (
	id TEXT PRIMARY KEY NOT NULL,
	context_id TEXT NOT NULL,
	org_id TEXT NOT NULL,
	operator_user_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('shell', 'command', 'lan', 'fs')),
	name TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	summary_json TEXT NOT NULL DEFAULT '{}',
	allowed_packages_json TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	-- Set when the machine stops offering it. Grants are soft-deleted then.
	removed_at TEXT
);

CREATE UNIQUE INDEX machine_capabilities_context_kind_name
	ON machine_capabilities (context_id, kind, name);

CREATE INDEX machine_capabilities_org ON machine_capabilities (org_id);

-- `grants.resource_type` gains 'machine_capability'. SQLite cannot alter a
-- CHECK, so this rebuilds the table the way 0264 did. Ids, rows and columns
-- are unchanged and grant_permissions is untouched. No access_epoch bump: no
-- grant row changes and none uses the new type yet.
--
-- One-way: an older Worker keeps working against the wider CHECK, but a
-- rollback cannot narrow it again. Fix forward.
CREATE TABLE __migration_assertions (message TEXT NOT NULL CHECK (0));
CREATE TABLE grants_next (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	resource_type TEXT NOT NULL CHECK (
		resource_type IN (
			'package',
			'file',
			'app',
			'job',
			'credential',
			'memory',
			'email',
			'org',
			'execution_context',
			'machine_capability'
		)
	),
	resource_id TEXT NOT NULL,
	subject_type TEXT NOT NULL CHECK (
		subject_type IN ('user', 'team', 'org', 'profile')
	),
	subject_id TEXT NOT NULL,
	preset TEXT CHECK (preset IN ('read', 'use', 'contribute', 'manage')),
	created_by_user_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT,
	origin TEXT NOT NULL DEFAULT 'manual'
		CHECK (origin IN ('manual', 'created')),
	expires_at TEXT,
	allow_unmappable_credential_changes INTEGER NOT NULL DEFAULT 0,
	CHECK (subject_type != 'org' OR subject_id = org_id)
);

INSERT INTO grants_next (
	id, org_id, resource_type, resource_id, subject_type, subject_id,
	preset, created_by_user_id, created_at, updated_at, deleted_at, origin,
	expires_at, allow_unmappable_credential_changes
)
SELECT id, org_id, resource_type, resource_id, subject_type, subject_id,
	preset, created_by_user_id, created_at, updated_at, deleted_at, origin,
	expires_at, allow_unmappable_credential_changes
FROM grants;

INSERT INTO __migration_assertions (message)
SELECT 'grants_next does not match grants; aborting 0276.'
WHERE EXISTS (
	SELECT id, org_id, resource_type, resource_id, subject_type, subject_id,
		preset, created_by_user_id, created_at, updated_at, deleted_at, origin,
		expires_at, allow_unmappable_credential_changes
	FROM grants
	EXCEPT
	SELECT id, org_id, resource_type, resource_id, subject_type, subject_id,
		preset, created_by_user_id, created_at, updated_at, deleted_at, origin,
		expires_at, allow_unmappable_credential_changes
	FROM grants_next
) OR EXISTS (
	SELECT id, org_id, resource_type, resource_id, subject_type, subject_id,
		preset, created_by_user_id, created_at, updated_at, deleted_at, origin,
		expires_at, allow_unmappable_credential_changes
	FROM grants_next
	EXCEPT
	SELECT id, org_id, resource_type, resource_id, subject_type, subject_id,
		preset, created_by_user_id, created_at, updated_at, deleted_at, origin,
		expires_at, allow_unmappable_credential_changes
	FROM grants
);

DROP TABLE grants;
ALTER TABLE grants_next RENAME TO grants;

CREATE UNIQUE INDEX grants_live_subject ON grants (
	resource_type,
	resource_id,
	subject_type,
	subject_id
) WHERE deleted_at IS NULL;

CREATE INDEX grants_subject ON grants (subject_type, subject_id)
	WHERE deleted_at IS NULL;


DROP TABLE __migration_assertions;
