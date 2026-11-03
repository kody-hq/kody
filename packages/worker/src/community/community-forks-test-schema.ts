/**
 * Current `community_forks` table (migrations through 0218). Test-local
 * schemas use this instead of their own copy, so a column change is one
 * edit here. `community-forks-test-schema.node.test.ts` fails when it
 * drifts from the migrations.
 */
export const communityForksTableSql = `CREATE TABLE IF NOT EXISTS community_forks (
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
)`
