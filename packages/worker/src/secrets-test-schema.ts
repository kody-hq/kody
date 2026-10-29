/**
 * Workers-unit D1 does not apply migrations. Suites that call packageGet
 * (which lists package-scoped secret metadata) need these tables. Keep this
 * helper aligned with `packages/worker/migrations` (including
 * `secret_entries.kind` from 0117) so tests do not hand-copy DDL (#3523).
 * Production assigns credential ids with an insert trigger (migration 0110); a
 * column default gives inserts and upserts the same ids here.
 */
export async function ensureSecretBucketsTestSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS secret_buckets (
				id TEXT PRIMARY KEY NOT NULL,
				user_id TEXT NOT NULL,
				scope TEXT NOT NULL CHECK (scope IN ('session', 'package', 'user')),
				binding_key TEXT NOT NULL,
				expires_at TEXT,
				deleted_at TEXT,
				created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				UNIQUE(user_id, scope, binding_key)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS secret_entries (
				id TEXT UNIQUE DEFAULT (lower(hex(randomblob(16)))),
				bucket_id TEXT NOT NULL,
				name TEXT NOT NULL,
				description TEXT NOT NULL DEFAULT '',
				encrypted_value TEXT NOT NULL,
				kind TEXT NOT NULL DEFAULT 'secret',
				inject_json TEXT NOT NULL DEFAULT '{"kind":"header","name":"Authorization","format":"Bearer {value}"}',
				config_json TEXT,
				allowed_hosts TEXT NOT NULL DEFAULT '[]',
				allowed_packages TEXT NOT NULL DEFAULT '[]',
				lookup_hash TEXT,
				expires_at TEXT,
				deleted_at TEXT,
				created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				placement_json TEXT,
				placement_origin TEXT,
				PRIMARY KEY (bucket_id, name)
			)`,
		)
		.run()
	// Suites that created secret_entries before placement_origin: add the column.
	try {
		await db
			.prepare(`ALTER TABLE secret_entries ADD COLUMN placement_origin TEXT`)
			.run()
	} catch {
		// Column already present.
	}
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS login_credential_sessions (
				credential_id TEXT PRIMARY KEY,
				user_id TEXT NOT NULL,
				revision TEXT,
				session_id TEXT,
				session_encrypted TEXT,
				expires_at INTEGER,
				lease_id TEXT,
				lease_expires_at INTEGER,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS credential_fill_placement_observations (
				credential_id TEXT PRIMARY KEY NOT NULL,
				filled_last_seen_json TEXT NOT NULL,
				would_block_last_seen_json TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS credential_fill_placement_opt_ins (
				credential_id TEXT PRIMARY KEY NOT NULL,
				query INTEGER NOT NULL DEFAULT 0,
				path INTEGER NOT NULL DEFAULT 0,
				body INTEGER NOT NULL DEFAULT 0,
				source TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS credential_allowed_packages_would_block (
				day TEXT NOT NULL,
				owner_id TEXT NOT NULL,
				credential_id TEXT NOT NULL,
				package_id TEXT NOT NULL,
				access_kind TEXT NOT NULL,
				first_seen_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL,
				observations INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (day, owner_id, credential_id, package_id)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS secret_provider_bindings (
				id TEXT UNIQUE DEFAULT (lower(hex(randomblob(16)))),
				user_id TEXT NOT NULL,
				provider_id TEXT NOT NULL,
				package_id TEXT NOT NULL,
				door_secret_name TEXT NOT NULL,
				config_json TEXT NOT NULL DEFAULT '{}',
				deleted_at TEXT,
				created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				placement_json TEXT,
				PRIMARY KEY (user_id, provider_id)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS secret_provider_grants (
				user_id TEXT NOT NULL,
				provider_id TEXT NOT NULL,
				canonical_ref TEXT NOT NULL,
				package_id TEXT NOT NULL,
				created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
				PRIMARY KEY (user_id, provider_id, canonical_ref, package_id)
			)`,
		)
		.run()
	// Package app bridge calls resolve the runs-as person (migration 0178).
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS package_app_authority (
				package_id TEXT PRIMARY KEY NOT NULL,
				owner_id TEXT NOT NULL,
				runs_as_person_id TEXT,
				published_by_person_id TEXT,
				publisher_unknown INTEGER NOT NULL DEFAULT 0,
				updated_at TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS package_app_authority_fallbacks (
				day TEXT NOT NULL,
				owner_id TEXT NOT NULL,
				package_id TEXT NOT NULL,
				call_name TEXT NOT NULL,
				difference_kind TEXT NOT NULL,
				visitor_hash TEXT NOT NULL,
				first_seen_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL,
				observations INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (day, package_id, call_name, difference_kind, visitor_hash)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS package_app_authority_rejections (
				day TEXT NOT NULL,
				owner_id TEXT NOT NULL,
				package_id TEXT NOT NULL,
				call_name TEXT NOT NULL,
				difference_kind TEXT NOT NULL,
				visitor_hash TEXT NOT NULL,
				first_seen_at TEXT NOT NULL,
				last_seen_at TEXT NOT NULL,
				observations INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (day, package_id, call_name, difference_kind, visitor_hash)
			)`,
		)
		.run()
}
