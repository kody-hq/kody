-- Execution contexts are shared through `grants` like packages, so the
-- `resource_type` CHECK gains 'execution_context'. SQLite cannot alter a
-- CHECK, so this rebuilds the table the way 0110 did: copy into
-- grants_next, swap, recreate grants_live_subject and grants_subject. Ids,
-- rows, and columns are unchanged and grant_permissions is untouched.
--
-- No access_epoch bump: no grant row changes and none uses the new type yet,
-- so every compiled access snapshot stays correct.
--
-- One-way: an older Worker keeps working against the wider CHECK, but a
-- rollback cannot narrow it again. Fix forward (Path B in
-- docs/contributing/rollback.md).
--
-- Fails closed (nothing applies) when the copy does not match the original
-- row for row.

DROP TABLE IF EXISTS __migration_assertions;
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

DROP TABLE IF EXISTS __grants_rebuild_counts;
CREATE TABLE __grants_rebuild_counts (
	phase TEXT PRIMARY KEY NOT NULL CHECK (phase IN ('before', 'after')),
	grants INTEGER NOT NULL,
	live_grants INTEGER NOT NULL,
	grant_permissions INTEGER NOT NULL
);

INSERT INTO __grants_rebuild_counts
SELECT 'before',
	(SELECT COUNT(*) FROM grants),
	(SELECT COUNT(*) FROM grants WHERE deleted_at IS NULL),
	(SELECT COUNT(*) FROM grant_permissions);

CREATE TABLE grants_next (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	resource_type TEXT NOT NULL CHECK (
		resource_type IN (
			'package',
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
	subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'team')),
	subject_id TEXT NOT NULL,
	preset TEXT CHECK (preset IN ('use', 'contribute', 'manage')),
	created_by_user_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	deleted_at TEXT
);

INSERT INTO grants_next (
	id, org_id, resource_type, resource_id, subject_type, subject_id,
	preset, created_by_user_id, created_at, updated_at, deleted_at
)
SELECT id, org_id, resource_type, resource_id, subject_type, subject_id,
	preset, created_by_user_id, created_at, updated_at, deleted_at
FROM grants;

-- Row-for-row equality in both directions before the swap.
INSERT INTO __migration_assertions (message)
SELECT 'grants_next is missing a grants row; aborting 0190.'
WHERE EXISTS (
	SELECT id, org_id, resource_type, resource_id, subject_type, subject_id,
		preset, created_by_user_id, created_at, updated_at, deleted_at
	FROM grants
	EXCEPT
	SELECT id, org_id, resource_type, resource_id, subject_type, subject_id,
		preset, created_by_user_id, created_at, updated_at, deleted_at
	FROM grants_next
);

INSERT INTO __migration_assertions (message)
SELECT 'grants_next has a row grants does not; aborting 0190.'
WHERE EXISTS (
	SELECT id, org_id, resource_type, resource_id, subject_type, subject_id,
		preset, created_by_user_id, created_at, updated_at, deleted_at
	FROM grants_next
	EXCEPT
	SELECT id, org_id, resource_type, resource_id, subject_type, subject_id,
		preset, created_by_user_id, created_at, updated_at, deleted_at
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

INSERT INTO __grants_rebuild_counts
SELECT 'after',
	(SELECT COUNT(*) FROM grants),
	(SELECT COUNT(*) FROM grants WHERE deleted_at IS NULL),
	(SELECT COUNT(*) FROM grant_permissions);

INSERT INTO __migration_assertions (message)
SELECT 'grant counts changed in 0190; aborting.'
FROM __grants_rebuild_counts before_counts
JOIN __grants_rebuild_counts after_counts
	ON before_counts.phase = 'before' AND after_counts.phase = 'after'
WHERE before_counts.grants != after_counts.grants
	OR before_counts.live_grants != after_counts.live_grants
	OR before_counts.grant_permissions != after_counts.grant_permissions;

DROP TABLE __grants_rebuild_counts;
DROP TABLE __migration_assertions;
