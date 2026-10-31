import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { ensureUserStorageBucketsTestSchema } from '#worker/storage-buckets/test-schema.ts'
import { ensureSecretBucketsTestSchema } from '#worker/secrets-test-schema.ts'
import { ensureSavedPackageInternetVisibleColumn } from '#worker/package-registry/internet-visible-column-test-schema.ts'
import { ensureSoftDeleteTestColumns } from '#worker/soft-delete/test-schema.ts'
import { ensureFollowTables } from '#worker/follow/repo.ts'
import { communityForksDeleteCascadeStatements } from './community-forks-delete-cascade.ts'

/**
 * Community flow workers-unit schema. Adds the community tables and the
 * profile columns on top of the shared `users` schema.
 */
export async function ensureCommunityFlowSchema(db: D1Database) {
	await ensureUsersTestSchema({
		db,
		columns: ['bio', 'avatar_key', 'profile_visibility'],
	})
	await ensureUserStorageBucketsTestSchema(db)
	await ensureSecretBucketsTestSchema(db)
	const statements = [
		`CREATE TABLE IF NOT EXISTS saved_packages (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			description TEXT NOT NULL,
			tags_json TEXT NOT NULL DEFAULT '[]',
			search_text TEXT,
			source_id TEXT NOT NULL,
			has_app INTEGER NOT NULL DEFAULT 0 CHECK (has_app IN (0, 1)),
			has_skills INTEGER NOT NULL DEFAULT 0 CHECK (has_skills IN (0, 1)),
			hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
			is_private INTEGER NOT NULL DEFAULT 1 CHECK (is_private IN (0, 1)),
			is_internet_visible INTEGER NOT NULL DEFAULT 0,
			locked_at TEXT,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_packages_user_kody_id
			ON saved_packages(user_id, kody_id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_packages_user_name
			ON saved_packages(user_id, name)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_packages_source_id
			ON saved_packages(source_id)`,
		`CREATE TABLE IF NOT EXISTS saved_package_search_index_debt (
			package_id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			generation INTEGER NOT NULL DEFAULT 0,
			embed_text TEXT NOT NULL,
			last_error TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS idx_saved_package_search_index_debt_user_id
			ON saved_package_search_index_debt(user_id)`,
		`CREATE TABLE IF NOT EXISTS entity_sources (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			entity_kind TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			repo_id TEXT NOT NULL,
			published_commit TEXT,
			indexed_commit TEXT,
			manifest_path TEXT NOT NULL DEFAULT 'package.json',
			source_root TEXT NOT NULL DEFAULT '/',
			last_external_check_at TEXT,
			external_check_until TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_sources_user_entity
			ON entity_sources(user_id, entity_kind, entity_id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_sources_repo_id
			ON entity_sources(repo_id)`,
		`CREATE TABLE IF NOT EXISTS community_listings (
			id TEXT PRIMARY KEY NOT NULL,
			owner_user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL,
			tags_json TEXT NOT NULL DEFAULT '[]',
			category TEXT NOT NULL DEFAULT 'other' CHECK (
				category IN (
					'integrations',
					'examples',
					'productivity',
					'apps',
					'utilities',
					'other'
				)
			),
			search_text TEXT,
			readme_content TEXT,
			license TEXT NOT NULL,
			package_version TEXT,
			pinned_commit TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'delisted')),
			featured_at TEXT,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			published_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_community_listings_owner_package
			ON community_listings(owner_user_id, package_id)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_community_listings_owner_kody_id_active
			ON community_listings(owner_user_id, kody_id) WHERE status = 'active'`,
		`CREATE TABLE IF NOT EXISTS package_kody_id_redirects (
			user_id TEXT NOT NULL,
			old_kody_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			PRIMARY KEY (user_id, old_kody_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_package_kody_id_redirects_package_id
			ON package_kody_id_redirects(package_id)`,
		`CREATE TABLE IF NOT EXISTS package_slug_redirects (
			user_id TEXT NOT NULL,
			old_slug TEXT NOT NULL,
			package_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			PRIMARY KEY (user_id, old_slug)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_package_slug_redirects_package_id
			ON package_slug_redirects(package_id)`,
		`CREATE TABLE IF NOT EXISTS community_forks (
			id TEXT PRIMARY KEY NOT NULL,
			listing_id TEXT, upstream_owner_id TEXT, upstream_package_id TEXT,
			forker_user_id TEXT NOT NULL,
			origin_commit TEXT NOT NULL,
			forked_package_id TEXT NOT NULL,
			forked_source_id TEXT NOT NULL,
			target_kody_id TEXT NOT NULL,
			listing_name TEXT,
			listing_kody_id TEXT,
			adopted_at TEXT,
			adoption_note TEXT,
			actor TEXT CHECK (actor IS NULL OR actor IN ('human', 'agent')),
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
		`CREATE TABLE IF NOT EXISTS community_fork_claims (
			owner_id TEXT NOT NULL,
			listing_id TEXT NOT NULL,
			claim_id TEXT NOT NULL,
			requested_kody_id TEXT,
			started_at TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			PRIMARY KEY (owner_id, listing_id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_community_forks_forked_package_id
			ON community_forks(forked_package_id)`,
		`CREATE INDEX IF NOT EXISTS idx_community_forks_listing_id
			ON community_forks(listing_id)`,
		...communityForksDeleteCascadeStatements,
		`CREATE TABLE IF NOT EXISTS community_ratings (
			id TEXT PRIMARY KEY NOT NULL,
			listing_id TEXT NOT NULL,
			user_id TEXT NOT NULL,
			stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
			adaptation_effort INTEGER NOT NULL CHECK (adaptation_effort BETWEEN 1 AND 5),
			note TEXT,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_community_ratings_listing_user
			ON community_ratings(listing_id, user_id)`,
		`CREATE TABLE IF NOT EXISTS community_reports (
			id TEXT PRIMARY KEY NOT NULL,
			listing_id TEXT NOT NULL,
			listing_name TEXT NOT NULL,
			listing_owner_user_id TEXT NOT NULL,
			reporter_user_id TEXT NOT NULL,
			reason TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
			resolved_by_user_id TEXT,
			resolved_at TEXT,
			resolution_note TEXT,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
		`CREATE TABLE IF NOT EXISTS community_bans (
			user_id TEXT PRIMARY KEY NOT NULL,
			banned_by_user_id TEXT NOT NULL,
			reason TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
		`CREATE TABLE IF NOT EXISTS community_activity_events (
			id TEXT PRIMARY KEY NOT NULL,
			actor_user_id TEXT NOT NULL,
			event_type TEXT NOT NULL CHECK (event_type IN ('listing_published', 'listing_updated')),
			listing_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_community_activity_events_actor_created
			ON community_activity_events(actor_user_id, created_at)`,
		`CREATE INDEX IF NOT EXISTS idx_community_activity_events_listing_id
			ON community_activity_events(listing_id)`,
		`CREATE TABLE IF NOT EXISTS jobs (
			id TEXT PRIMARY KEY NOT NULL,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			source_id TEXT NOT NULL,
			published_commit TEXT,
			repo_check_policy_json TEXT,
			storage_id TEXT NOT NULL,
			params_json TEXT,
			schedule_json TEXT NOT NULL,
			timezone TEXT NOT NULL,
			enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
			kill_switch_enabled INTEGER NOT NULL DEFAULT 0 CHECK (kill_switch_enabled IN (0, 1)),
			caller_context_json TEXT NOT NULL,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			last_run_at TEXT,
			last_run_status TEXT,
			next_run_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS webhook_endpoints (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			webhook_name TEXT NOT NULL,
			url_secret_hash TEXT NOT NULL DEFAULT '',
			enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
			instance_label TEXT,
			created_at TEXT NOT NULL,
			rotated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS published_bundle_artifacts (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			source_id TEXT NOT NULL,
			published_commit TEXT NOT NULL,
			artifact_kind TEXT NOT NULL,
			artifact_name TEXT,
			entry_point TEXT NOT NULL,
			kv_key TEXT NOT NULL,
			dependencies_json TEXT NOT NULL DEFAULT '[]',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
	]
	for (const statement of statements) {
		await db.prepare(statement).run()
	}

	// Best-effort ALTER for persisted worker DBs that already created the older
	// IF NOT EXISTS saved_packages table without the visibility column.
	try {
		await db
			.prepare(
				`ALTER TABLE saved_packages ADD COLUMN is_private INTEGER NOT NULL DEFAULT 1`,
			)
			.run()
	} catch {
		// Column already present on newer schemas.
	}
	await ensureSavedPackageInternetVisibleColumn(db)
	try {
		await db
			.prepare(`ALTER TABLE saved_packages ADD COLUMN locked_at TEXT`)
			.run()
	} catch {
		// Column already present.
	}
	try {
		await db
			.prepare(
				`ALTER TABLE community_listings ADD COLUMN category TEXT NOT NULL DEFAULT 'other'`,
			)
			.run()
	} catch {
		// Column already present.
	}
	try {
		await db
			.prepare(`ALTER TABLE community_listings ADD COLUMN package_version TEXT`)
			.run()
	} catch {
		// Column already present.
	}
	await ensureSoftDeleteTestColumns(db)
	await ensureFollowTables(db)
}
