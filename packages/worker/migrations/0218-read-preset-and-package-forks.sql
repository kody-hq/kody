-- Read preset and private package forks (2026-10-31).
--
-- 1. `grants.preset` and `org_invite_links.preset` accept `read` (package:read
--    only). SQLite cannot alter a CHECK, so both tables are rebuilt with every
--    column in its existing order, the way 0214 rebuilt grants. Ids, rows and
--    grant_permissions are unchanged. `invites.preset` has no CHECK.
-- 2. `community_forks` can record a fork of a private package someone may
--    read: `listing_id` becomes nullable and `upstream_owner_id` /
--    `upstream_package_id` name the source package. Exactly one of the two
--    origins is set. Existing rows keep their listing. The delete-cascade
--    triggers from 0061 are dropped and recreated around the swap so the
--    rename never sees a trigger naming a missing table.
--
-- One-way: an older Worker never writes `read` or a package fork and ignores
-- the new columns. Fix forward (Path B in docs/contributing/rollback.md).
--
-- Fails closed (nothing applies) when a copy does not match its original row
-- for row.

DROP TABLE IF EXISTS __migration_assertions;
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

DROP TABLE IF EXISTS __read_preset_rebuild_counts;
CREATE TABLE __read_preset_rebuild_counts (
	phase TEXT PRIMARY KEY NOT NULL CHECK (phase IN ('before', 'after')),
	grants INTEGER NOT NULL,
	grant_permissions INTEGER NOT NULL,
	invite_links INTEGER NOT NULL,
	community_forks INTEGER NOT NULL
);

INSERT INTO __read_preset_rebuild_counts
SELECT 'before',
	(SELECT COUNT(*) FROM grants),
	(SELECT COUNT(*) FROM grant_permissions),
	(SELECT COUNT(*) FROM org_invite_links),
	(SELECT COUNT(*) FROM community_forks);

-- grants -------------------------------------------------------------------

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
	CHECK (subject_type != 'org' OR subject_id = org_id)
);

INSERT INTO grants_next (
	id, org_id, resource_type, resource_id, subject_type, subject_id,
	preset, created_by_user_id, created_at, updated_at, deleted_at, origin,
	expires_at
)
SELECT id, org_id, resource_type, resource_id, subject_type, subject_id,
	preset, created_by_user_id, created_at, updated_at, deleted_at, origin,
	expires_at
FROM grants;

INSERT INTO __migration_assertions (message)
SELECT 'grants_next does not match grants; aborting 0218.'
WHERE EXISTS (
	SELECT id, org_id, resource_type, resource_id, subject_type, subject_id,
		preset, created_by_user_id, created_at, updated_at, deleted_at, origin,
		expires_at
	FROM grants
	EXCEPT
	SELECT id, org_id, resource_type, resource_id, subject_type, subject_id,
		preset, created_by_user_id, created_at, updated_at, deleted_at, origin,
		expires_at
	FROM grants_next
) OR EXISTS (
	SELECT id, org_id, resource_type, resource_id, subject_type, subject_id,
		preset, created_by_user_id, created_at, updated_at, deleted_at, origin,
		expires_at
	FROM grants_next
	EXCEPT
	SELECT id, org_id, resource_type, resource_id, subject_type, subject_id,
		preset, created_by_user_id, created_at, updated_at, deleted_at, origin,
		expires_at
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

-- org_invite_links ---------------------------------------------------------

CREATE TABLE org_invite_links_next (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	token_hash TEXT NOT NULL UNIQUE,
	kind TEXT NOT NULL DEFAULT 'membership'
		CHECK (kind IN ('membership', 'team', 'resource')),
	role TEXT CHECK (role IS NULL OR role IN ('member', 'billing')),
	team_id TEXT,
	resource_type TEXT CHECK (resource_type IS NULL OR resource_type = 'package'),
	resource_id TEXT,
	preset TEXT CHECK (
		preset IS NULL OR preset IN ('read', 'use', 'contribute', 'manage')
	),
	allowed_email_domains_json TEXT,
	max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
	use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
	status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
	created_by_user_id TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	revoked_at TEXT,
	label TEXT,
	last_used_at TEXT,
	team_ids_json TEXT,
	CHECK (
		(kind = 'membership' AND role IS NOT NULL AND team_id IS NULL
			AND resource_type IS NULL AND resource_id IS NULL AND preset IS NULL)
		OR (kind = 'team' AND role = 'member' AND team_id IS NOT NULL
			AND resource_type IS NULL AND resource_id IS NULL AND preset IS NULL)
		OR (kind = 'resource' AND role IS NULL AND team_id IS NULL
			AND resource_type IS NOT NULL AND resource_id IS NOT NULL
			AND preset IS NOT NULL)
	)
);

INSERT INTO org_invite_links_next (
	id, org_id, token_hash, kind, role, team_id, resource_type, resource_id,
	preset, allowed_email_domains_json, max_uses, use_count, status,
	created_by_user_id, expires_at, created_at, revoked_at, label,
	last_used_at, team_ids_json
)
SELECT id, org_id, token_hash, kind, role, team_id, resource_type, resource_id,
	preset, allowed_email_domains_json, max_uses, use_count, status,
	created_by_user_id, expires_at, created_at, revoked_at, label,
	last_used_at, team_ids_json
FROM org_invite_links;

INSERT INTO __migration_assertions (message)
SELECT 'org_invite_links_next does not match org_invite_links; aborting 0218.'
WHERE EXISTS (
	SELECT id, org_id, token_hash, kind, role, team_id, resource_type,
		resource_id, preset, allowed_email_domains_json, max_uses, use_count,
		status, created_by_user_id, expires_at, created_at, revoked_at, label,
		last_used_at, team_ids_json
	FROM org_invite_links
	EXCEPT
	SELECT id, org_id, token_hash, kind, role, team_id, resource_type,
		resource_id, preset, allowed_email_domains_json, max_uses, use_count,
		status, created_by_user_id, expires_at, created_at, revoked_at, label,
		last_used_at, team_ids_json
	FROM org_invite_links_next
);

DROP INDEX IF EXISTS org_invite_links_org_status_idx;
DROP INDEX IF EXISTS org_invite_links_resource_idx;
DROP INDEX IF EXISTS org_invite_links_team_idx;
DROP TABLE org_invite_links;
ALTER TABLE org_invite_links_next RENAME TO org_invite_links;

CREATE INDEX org_invite_links_org_status_idx
	ON org_invite_links (org_id, status, expires_at);

CREATE INDEX org_invite_links_resource_idx
	ON org_invite_links (org_id, resource_type, resource_id, status);

CREATE INDEX org_invite_links_team_idx
	ON org_invite_links (org_id, team_id, status);

-- community_forks ----------------------------------------------------------

DROP TRIGGER IF EXISTS community_forks_delete_on_saved_package_delete;
DROP TRIGGER IF EXISTS community_forks_delete_on_entity_source_delete;

CREATE TABLE community_forks_next (
	id TEXT PRIMARY KEY NOT NULL,
	listing_id TEXT,
	forker_user_id TEXT NOT NULL,
	origin_commit TEXT NOT NULL,
	forked_package_id TEXT NOT NULL,
	forked_source_id TEXT NOT NULL,
	target_kody_id TEXT NOT NULL,
	listing_name TEXT,
	listing_kody_id TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	adopted_at TEXT,
	adoption_note TEXT,
	actor TEXT CHECK (actor IS NULL OR actor IN ('human', 'agent')),
	upstream_owner_id TEXT,
	upstream_package_id TEXT,
	CHECK ((upstream_package_id IS NULL) = (upstream_owner_id IS NULL)),
	CHECK ((listing_id IS NULL) <> (upstream_package_id IS NULL))
);

INSERT INTO community_forks_next (
	id, listing_id, forker_user_id, origin_commit, forked_package_id,
	forked_source_id, target_kody_id, listing_name, listing_kody_id,
	created_at, adopted_at, adoption_note, actor
)
SELECT id, listing_id, forker_user_id, origin_commit, forked_package_id,
	forked_source_id, target_kody_id, listing_name, listing_kody_id,
	created_at, adopted_at, adoption_note, actor
FROM community_forks;

INSERT INTO __migration_assertions (message)
SELECT 'community_forks_next does not match community_forks; aborting 0218.'
WHERE EXISTS (
	SELECT id, listing_id, forker_user_id, origin_commit, forked_package_id,
		forked_source_id, target_kody_id, listing_name, listing_kody_id,
		created_at, adopted_at, adoption_note, actor
	FROM community_forks
	EXCEPT
	SELECT id, listing_id, forker_user_id, origin_commit, forked_package_id,
		forked_source_id, target_kody_id, listing_name, listing_kody_id,
		created_at, adopted_at, adoption_note, actor
	FROM community_forks_next
);

DROP INDEX IF EXISTS idx_community_forks_listing_id;
DROP INDEX IF EXISTS idx_community_forks_forker_listing;
DROP INDEX IF EXISTS idx_community_forks_forked_package_id;
DROP TABLE community_forks;
ALTER TABLE community_forks_next RENAME TO community_forks;

CREATE INDEX idx_community_forks_listing_id
	ON community_forks(listing_id);
CREATE INDEX idx_community_forks_forker_listing
	ON community_forks(forker_user_id, listing_id);
CREATE INDEX idx_community_forks_forked_package_id
	ON community_forks(forked_package_id);
CREATE INDEX idx_community_forks_upstream_package
	ON community_forks(upstream_package_id, forker_user_id)
	WHERE upstream_package_id IS NOT NULL;

CREATE TRIGGER community_forks_delete_on_saved_package_delete
AFTER DELETE ON saved_packages
BEGIN
	DELETE FROM community_forks
	WHERE forker_user_id = OLD.user_id
		AND (
			forked_package_id = OLD.id
			OR forked_source_id = OLD.source_id
		);
END;

CREATE TRIGGER community_forks_delete_on_entity_source_delete
AFTER DELETE ON entity_sources
BEGIN
	DELETE FROM community_forks
	WHERE forked_source_id = OLD.id
		AND forker_user_id = OLD.user_id;
END;

-- counts -------------------------------------------------------------------

INSERT INTO __read_preset_rebuild_counts
SELECT 'after',
	(SELECT COUNT(*) FROM grants),
	(SELECT COUNT(*) FROM grant_permissions),
	(SELECT COUNT(*) FROM org_invite_links),
	(SELECT COUNT(*) FROM community_forks);

INSERT INTO __migration_assertions (message)
SELECT 'row counts changed in 0218; aborting.'
FROM __read_preset_rebuild_counts before_counts
JOIN __read_preset_rebuild_counts after_counts
	ON before_counts.phase = 'before' AND after_counts.phase = 'after'
WHERE before_counts.grants != after_counts.grants
	OR before_counts.grant_permissions != after_counts.grant_permissions
	OR before_counts.invite_links != after_counts.invite_links
	OR before_counts.community_forks != after_counts.community_forks;

DROP TABLE __read_preset_rebuild_counts;
DROP TABLE __migration_assertions;
