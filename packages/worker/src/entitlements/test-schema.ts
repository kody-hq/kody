import { ensureUserStorageBucketsTestSchema } from '#worker/storage-buckets/test-schema.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

/**
 * Non-destructive schema for entitlement primitives in workers-unit tests,
 * where the D1 database starts empty and each suite provisions the tables it
 * needs. Billing columns live on `orgs` (provisioned with `users`). Daily
 * counters live only in UserMeter.
 *
 * Also provisions `user_storage_buckets` because entitlement suites that touch
 * StorageRunner writes register ownership through that table, and `referrals`
 * for the invoice-gated Standard credit program.
 */
export async function ensureEntitlementTestSchema(db: D1Database) {
	await ensureUsersTestSchema({
		db,
		columns: ['email_verified_at'],
	})
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS stripe_webhook_events (
	event_id TEXT PRIMARY KEY NOT NULL,
	event_type TEXT NOT NULL,
	processed_at TEXT NOT NULL
)`,
		)
		.run()
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS d1_storage_reconcile_cursor (
	singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
	position TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
)`,
		)
		.run()
	await db
		.prepare(
			`INSERT OR IGNORE INTO d1_storage_reconcile_cursor (singleton, position)
			VALUES (1, '')`,
		)
		.run()
	await ensureUserStorageBucketsTestSchema(db)
	await ensureReferralProgramTestSchema(db)
}

export async function ensureReferralProgramTestSchema(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS referrals (
	id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
	referrer_org_id TEXT NOT NULL,
	referee_stable_user_id TEXT NOT NULL,
	created_at TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	rewarded_at TEXT,
	reward_invoice_id TEXT,
	reject_reason TEXT,
	held_invoice_id TEXT,
	held_period_end_at TEXT,
	credits_granted_at TEXT
)`,
		)
		.run()
	await db
		.prepare(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_referee
			 ON referrals(referee_stable_user_id)`,
		)
		.run()
	await db
		.prepare(
			`CREATE INDEX IF NOT EXISTS idx_referrals_referrer_org
			 ON referrals(referrer_org_id)`,
		)
		.run()
	await db
		.prepare(
			`CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_reward_invoice
			 ON referrals(reward_invoice_id)
			 WHERE reward_invoice_id IS NOT NULL`,
		)
		.run()
}
