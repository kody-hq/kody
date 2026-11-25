import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'

/**
 * Mirrors `0069-prepaid-credits.sql` and `0297-credit-ledger-idempotency-key.sql` (ledger, debit progress, and sweep cursor; wallets
 * come with the shared `users` schema) plus `usage_rollups` for
 * `*.workers.test.ts` suites, which run against an empty local D1.
 */
export async function ensureCreditWalletTestSchema(db: D1Database) {
	await ensureEntitlementTestSchema(db)
	await ensureUsageRollupsTestSchema(db)
	const statements = [
		`CREATE TABLE IF NOT EXISTS credit_ledger_entries (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('top_up', 'auto_refill', 'admin_grant', 'debit')),
	amount_micro_usd INTEGER NOT NULL,
	meter TEXT,
	month TEXT,
	units INTEGER,
	stripe_reference TEXT,
	granted_by_user_id TEXT,
	note TEXT,
	created_at TEXT NOT NULL,
	idempotency_key TEXT
)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_entries_stripe_reference
	ON credit_ledger_entries (stripe_reference)
	WHERE stripe_reference IS NOT NULL`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_credit_ledger_entries_idempotency_key
	ON credit_ledger_entries (idempotency_key)
	WHERE idempotency_key IS NOT NULL`,
		`CREATE TABLE IF NOT EXISTS credit_debit_progress (
	user_id TEXT NOT NULL,
	month TEXT NOT NULL,
	meter TEXT NOT NULL,
	accounted_units INTEGER NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, month, meter)
)`,
		`CREATE TABLE IF NOT EXISTS credit_debit_cursor (
	singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
	position TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
)`,
		`INSERT OR IGNORE INTO credit_debit_cursor (singleton, position) VALUES (1, '')`,
	]
	for (const statement of statements) {
		await db.prepare(statement).run()
	}
}
