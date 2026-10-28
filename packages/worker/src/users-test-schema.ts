import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { liveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { ensureSoftDeleteTestColumns } from '#worker/soft-delete/test-schema.ts'

/**
 * Shared `users` provisioning for `*.workers.test.ts` suites. Local D1 starts
 * empty and never applies migrations, so each suite creates the tables it
 * needs — and several suites share one database, so the same `users` table can
 * already exist with fewer columns than the current suite wants.
 *
 * Every column therefore has a fresh `CREATE TABLE` form and (where SQLite
 * allows it) an additive `ALTER TABLE ... ADD COLUMN` form. Feature-specific
 * tables stay in the feature's own `test-schema.ts`.
 */

/**
 * Columns beyond the always-present core that a suite can opt into. Suites
 * request only what they assert on so the helper keeps documenting which
 * migrations each suite depends on.
 */
export type UsersTestSchemaColumn =
	| 'email_verified_at'
	| 'bio'
	| 'avatar_key'
	| 'profile_visibility'
	| 'onboarding_checklist_dismissed_at'

type UsersColumnDefinition = {
	/** Definition used by the fresh `CREATE TABLE users`. */
	create: string
	/**
	 * Definition used by `ALTER TABLE users ADD COLUMN` when a preexisting
	 * shared table needs the column. SQLite cannot add `NOT NULL` without a
	 * constant default, so some alter forms are weaker than the create form.
	 * Omit to reuse `create`.
	 */
	alter?: string
}

/**
 * Present in every suite. `id`, `username`, `email`, `password_hash`,
 * `created_at`, and `updated_at` cannot be added by `ALTER TABLE` (identity,
 * `UNIQUE`, `NOT NULL` without a default, non-constant defaults), so they only
 * ever come from the fresh `CREATE TABLE`.
 */
const nonAdditiveCoreColumns = [
	'id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL',
	'username TEXT NOT NULL UNIQUE',
	'email TEXT NOT NULL UNIQUE',
	'password_hash TEXT NOT NULL',
] as const

const timestampColumns = [
	'created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)',
	'updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)',
] as const

/**
 * Mirrors migrations 0052 + 0075 (`stable_user_id` NOT NULL + unique index),
 * 0142 (`personal_org_id`), account deletion/suspension state, and profile
 * display names. Plan, Stripe, gift, retention, and outbound-pause columns
 * live on `orgs` (`ensureOrgsTestSchema`), not `users`.
 */
const alwaysAdditiveColumns: Record<string, UsersColumnDefinition> = {
	// Preexisting shared tables: ALTER ADD COLUMN cannot express NOT NULL
	// without a default; nullable TEXT matches migration 0052's add step.
	stable_user_id: { create: 'TEXT NOT NULL', alter: 'TEXT' },
	// 0142 widen. Fresh tables require the column. The empty default lets
	// shared workers-test inserts that only set `stable_user_id` succeed.
	// Production 0142 backfills real ids and does not default the column.
	personal_org_id: { create: "TEXT NOT NULL DEFAULT ''", alter: 'TEXT' },
	deleting_at: { create: 'TEXT' },
	deleted_at: { create: 'TEXT' },
	suspended_at: { create: 'TEXT' },
	email_verification_delivery_status: { create: 'TEXT' },
	email_verification_delivery_at: { create: 'TEXT' },
	email_verification_delivery_detail: { create: 'TEXT' },
	email_verification_delivery_class: { create: 'TEXT' },
	display_name: { create: 'TEXT' },
	utm_source: { create: 'TEXT' },
	utm_medium: { create: 'TEXT' },
	utm_campaign: { create: 'TEXT' },
	utm_content: { create: 'TEXT' },
	utm_term: { create: 'TEXT' },
	first_touch_landing_path: { create: 'TEXT' },
	first_touch_referrer: { create: 'TEXT' },
	first_mcp_connected_at: { create: 'TEXT' },
	first_execute_at: { create: 'TEXT' },
	first_search_at: { create: 'TEXT' },
	first_saved_package_at: { create: 'TEXT' },
	first_secret_at: { create: 'TEXT' },
	first_integration_at: { create: 'TEXT' },
	first_job_at: { create: 'TEXT' },
	mcp_client_name: { create: 'TEXT' },
	last_active_at: { create: 'TEXT' },
	experiments_opt_in: {
		create: `INTEGER NOT NULL DEFAULT 0 CHECK (experiments_opt_in IN (0, 1))`,
		alter: `INTEGER NOT NULL DEFAULT 0`,
	},
}

/**
 * Opt-in columns. `email_verified_at` mirrors 0046, the profile columns
 * mirror the community social migration,
 * and `onboarding_checklist_dismissed_at` mirrors 0015. `CHECK` constraints
 * are dropped from the alter forms to match what the migrations do for
 * preexisting tables. Billing columns are not optional on `users`.
 */
const optionalColumns: Record<UsersTestSchemaColumn, UsersColumnDefinition> = {
	email_verified_at: { create: 'TEXT' },
	bio: { create: 'TEXT' },
	avatar_key: { create: 'TEXT' },
	profile_visibility: {
		create: `TEXT NOT NULL DEFAULT 'public' CHECK (profile_visibility IN ('public', 'private'))`,
		alter: `TEXT NOT NULL DEFAULT 'public'`,
	},
	onboarding_checklist_dismissed_at: { create: 'TEXT' },
}

export async function ensureUsersTestSchema(input: {
	db: D1Database
	columns?: ReadonlyArray<UsersTestSchemaColumn>
}) {
	const additive: Array<readonly [string, UsersColumnDefinition]> = [
		...Object.entries(alwaysAdditiveColumns),
		...(input.columns ?? []).map(
			(column) => [column, optionalColumns[column]] as const,
		),
	]

	const createColumns = [
		...nonAdditiveCoreColumns,
		...additive.map(([name, definition]) => `${name} ${definition.create}`),
		...timestampColumns,
	]
	await input.db
		.prepare(
			`CREATE TABLE IF NOT EXISTS users (\n\t${createColumns.join(',\n\t')}\n)`,
		)
		.run()

	for (const [name, definition] of additive) {
		try {
			await input.db
				.prepare(
					`ALTER TABLE users ADD COLUMN ${name} ${definition.alter ?? definition.create}`,
				)
				.run()
		} catch {
			// The column already exists (fresh CREATE above, or a prior suite).
		}
	}

	try {
		await input.db
			.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_stable_user_id
				 ON users(stable_user_id) WHERE ${liveDeletedAtSql()}`,
			)
			.run()
	} catch {
		// Index already exists, or a partial legacy index remains from an
		// earlier suite sharing this database.
	}
	try {
		// Ignore blank defaults from fixture inserts that omit the column.
		// Migration 0142 indexes every live row after backfill.
		await input.db
			.prepare(
				`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_personal_org_id
				 ON users(personal_org_id)
				 WHERE ${liveDeletedAtSql()}
				   AND length(trim(personal_org_id)) > 0`,
			)
			.run()
	} catch {
		// Index already exists on a suite that shares this database.
	}
	await ensureCreditWalletsTestTable(input.db)
	await ensureOrgLimitOverridesTestTable(input.db)
	await ensureOrgsTestSchema(input.db)
	await ensureSoftDeleteTestColumns(input.db)
}

/**
 * Mirrors `org_limit_overrides` from `0103-org-limit-overrides.sql`. Every
 * entitlement resolution reads it, so it is created with `users`.
 */
export async function ensureOrgLimitOverridesTestTable(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS org_limit_overrides (
	org_id TEXT NOT NULL,
	limit_key TEXT NOT NULL,
	limit_value INTEGER CHECK (limit_value IS NULL OR limit_value >= 0),
	reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
	expires_at TEXT,
	set_by_user_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (org_id, limit_key)
)`,
		)
		.run()
}

/**
 * Mirrors `credit_wallets` from `0069-prepaid-credits.sql`. Created with
 * `users` because entitlement resolution reads the wallet balance for any
 * account on the purchasable Pro (including gift and referral overlays).
 */
export async function ensureCreditWalletsTestTable(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS credit_wallets (
	user_id TEXT PRIMARY KEY NOT NULL,
	balance_micro_usd INTEGER NOT NULL DEFAULT 0,
	auto_refill_enabled INTEGER NOT NULL DEFAULT 0,
	auto_refill_threshold_cents INTEGER,
	auto_refill_amount_cents INTEGER,
	auto_refill_monthly_cap_cents INTEGER,
	auto_refill_payment_method_id TEXT,
	auto_refill_failed_at TEXT,
	notify_auto_refilled INTEGER NOT NULL DEFAULT 1,
	notify_monthly_cap INTEGER NOT NULL DEFAULT 1,
	notify_low_balance INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
)`,
		)
		.run()
}
