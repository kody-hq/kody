-- Add org-owned files to the existing grant resource family. Preserve all
-- grants and permission rows while rebuilding SQLite's resource_type CHECK.
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
			'execution_context'
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
SELECT 'grants_next does not match grants; aborting 0262.'
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
