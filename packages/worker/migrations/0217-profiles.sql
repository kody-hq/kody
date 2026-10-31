-- Profiles: scoped agent identities a person creates in an org (ADR 0092).
-- A profile's access is a snapshot of `grants` rows with subject_type
-- 'profile', capped at run time by its parent chain and its acting user's live
-- access. These tables are inert until profile authorization lands: no
-- credential binds to a profile yet, and the `profiles` feature flag (off)
-- gates every surface that writes them. Purely additive, so an older Worker
-- ignores them.
--
-- `owner_kind` is 'person' only in v1; the CHECK widens when org-owned bot
-- profiles land, and `acting_user_id` is nullable for that case but required
-- for 'person'. `acting_user_id` is inherited by children and never changes.
-- `parent_profile_id` is NULL for a top-level profile; `depth` is 1 for a
-- top-level profile and at most 5. `revoked_at` is terminal, and `expires_at`
-- only shortens. A revoked or expired profile disables its whole subtree by
-- chain lookup; child rows are never rewritten.

CREATE TABLE profiles (
	id TEXT PRIMARY KEY NOT NULL,
	org_id TEXT NOT NULL,
	owner_kind TEXT NOT NULL DEFAULT 'person' CHECK (owner_kind IN ('person')),
	acting_user_id TEXT,
	parent_profile_id TEXT REFERENCES profiles (id),
	name TEXT NOT NULL,
	depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 5),
	expires_at TEXT,
	revoked_at TEXT,
	revoked_by_user_id TEXT,
	created_by_user_id TEXT NOT NULL,
	created_by_profile_id TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	CHECK (owner_kind <> 'person' OR acting_user_id IS NOT NULL),
	CHECK ((parent_profile_id IS NULL) = (depth = 1))
);

CREATE UNIQUE INDEX profiles_name_per_parent ON profiles (
	org_id,
	acting_user_id,
	COALESCE(parent_profile_id, ''),
	name
);
CREATE INDEX profiles_acting_user ON profiles (org_id, acting_user_id);
CREATE INDEX profiles_parent ON profiles (parent_profile_id);
CREATE INDEX profiles_purge ON profiles (revoked_at, expires_at);
