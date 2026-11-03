import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { insertEnablement } from '#worker/enablements/repo.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { ensureSavedPackageInternetVisibleColumn } from '#worker/package-registry/internet-visible-column-test-schema.ts'
import { ensureSoftDeleteTestColumns } from '#worker/soft-delete/test-schema.ts'
import { ensurePersonalOrg } from '#worker/orgs/provision.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

/**
 * Explicit-import factories for `*.workers.test.ts` suites that need a local
 * D1 user/RBAC/package-subscription schema. Call these inside each test (or a
 * per-test factory) — do not wire them through `beforeEach`.
 */

export async function ensureRbacTestSchema(db: D1Database) {
	await ensureEntitlementTestSchema(db)
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS roles (
				id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
				name TEXT NOT NULL UNIQUE,
				description TEXT NOT NULL DEFAULT ''
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS user_roles (
				user_id INTEGER NOT NULL,
				role_id INTEGER NOT NULL,
				PRIMARY KEY (user_id, role_id)
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS permissions (
				id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
				action TEXT NOT NULL,
				entity TEXT NOT NULL,
				access TEXT NOT NULL
			)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS role_permissions (
				role_id INTEGER NOT NULL,
				permission_id INTEGER NOT NULL,
				PRIMARY KEY (role_id, permission_id)
			)`,
		)
		.run()
	await db
		.prepare(`INSERT OR IGNORE INTO roles (name) VALUES ('user'), ('admin')`)
		.run()
}

export async function ensurePackageSubscriptionTestSchema(db: D1Database) {
	const statements = [
		`CREATE TABLE IF NOT EXISTS saved_packages (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			name TEXT NOT NULL,
			kody_id TEXT NOT NULL,
			description TEXT NOT NULL,
			tags_json TEXT NOT NULL DEFAULT '[]',
			search_text TEXT,
			source_id TEXT NOT NULL,
			has_app INTEGER NOT NULL DEFAULT 0,
			has_skills INTEGER NOT NULL DEFAULT 0,
			hidden INTEGER NOT NULL DEFAULT 0,
			is_private INTEGER NOT NULL DEFAULT 1,
			is_internet_visible INTEGER NOT NULL DEFAULT 0,
			locked_at TEXT,
			deleted_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS package_kody_id_redirects (
			user_id TEXT NOT NULL,
			old_kody_id TEXT NOT NULL,
			package_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			PRIMARY KEY (user_id, old_kody_id)
		)`,
		`CREATE TABLE IF NOT EXISTS package_slug_redirects (
			user_id TEXT NOT NULL,
			old_slug TEXT NOT NULL,
			package_id TEXT NOT NULL,
			created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
			PRIMARY KEY (user_id, old_slug)
		)`,
		`CREATE TABLE IF NOT EXISTS entity_sources (
			id TEXT PRIMARY KEY,
			user_id TEXT NOT NULL,
			entity_kind TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			repo_id TEXT NOT NULL,
			published_commit TEXT,
			serving_commit TEXT,
			indexed_commit TEXT,
			manifest_path TEXT NOT NULL,
			source_root TEXT NOT NULL,
			last_external_check_at TEXT,
			external_check_until TEXT,
			deleted_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
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
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_published_bundle_artifacts_identity
		ON published_bundle_artifacts(user_id, source_id, artifact_kind, COALESCE(artifact_name, ''), entry_point)`,
	]
	for (const statement of statements) {
		await db.prepare(statement).run()
	}
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
		// Column already present on newer schemas.
	}
	await ensureSoftDeleteTestColumns(db)
}

/**
 * Upserts a users row for workers-unit tests and returns the numeric account id.
 * Pass `db` explicitly (usually `env.APP_DB`) — no ambient default.
 */
export async function seedAccount(input: {
	db: D1Database
	email: string
	username: string
	emailVerifiedAt?: string | null
	plan?: string
	passwordHash?: string
	stableUserId?: string
}): Promise<number> {
	const stableUserId =
		input.stableUserId ?? testStableUserIdFromEmail(input.email)
	const emailVerifiedAt =
		input.emailVerifiedAt === undefined
			? new Date().toISOString()
			: input.emailVerifiedAt
	const passwordHash = input.passwordHash ?? 'test-password-hash'
	await input.db
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, email_verified_at,
				stable_user_id, personal_org_id
			) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(email) DO UPDATE SET
				username = excluded.username,
				email_verified_at = excluded.email_verified_at,
				stable_user_id = COALESCE(users.stable_user_id, excluded.stable_user_id),
				personal_org_id = COALESCE(
					NULLIF(TRIM(users.personal_org_id), ''),
					users.stable_user_id,
					excluded.personal_org_id
				),
				updated_at = CURRENT_TIMESTAMP`,
		)
		.bind(
			input.username,
			input.email,
			passwordHash,
			emailVerifiedAt,
			stableUserId,
			stableUserId,
		)
		.run()
	await ensurePersonalOrg(input.db, {
		stableUserId,
		username: input.username,
		...(input.plan === undefined ? {} : { plan: input.plan }),
	})
	if (input.plan !== undefined) {
		await input.db
			.prepare(
				`UPDATE orgs SET plan = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
			)
			.bind(input.plan, stableUserId)
			.run()
	}

	const row = await input.db
		.prepare(`SELECT id FROM users WHERE email = ?`)
		.bind(input.email)
		.first<{ id: number }>()
	if (!row) throw new Error(`Expected seeded user row for ${input.email}`)
	return row.id
}

export async function assignAdminRole(input: {
	db: D1Database
	userId: number
}) {
	await input.db
		.prepare(
			`INSERT OR IGNORE INTO user_roles (user_id, role_id)
			 SELECT ?, id FROM roles WHERE name = 'admin'`,
		)
		.bind(input.userId)
		.run()
}

/**
 * Turns a saved package's subscription on for the owner of the personal org
 * that saved it, so its events run as that person.
 */
export async function enableSubscriptionForOwner(input: {
	db: D1Database
	userId: string
	packageId: string
	topic: string
}) {
	await ensureOrgsTestSchema(input.db)
	return await insertEnablement({
		db: input.db,
		enablement: {
			orgId: ownerIdFromStored(input.userId),
			packageId: input.packageId,
			triggerKind: 'subscription',
			triggerName: input.topic,
			instanceId: input.packageId,
			enablerUserId: input.userId,
			origin: 'enabled',
			...(input.topic === 'email.message.received' ||
			input.topic === 'email.message.quarantined'
				? { senderKind: 'any_authenticated' as const }
				: {}),
		},
	})
}
