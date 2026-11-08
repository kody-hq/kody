/** Mirrors `0259-org-plan-transfers.sql` for `*.workers.test.ts` suites. */
export async function ensurePlanTransferTestSchema(db: D1Database) {
	const statements = [
		`CREATE TABLE IF NOT EXISTS org_plan_transfers (
	id TEXT PRIMARY KEY NOT NULL,
	source_org_id TEXT NOT NULL,
	target_org_id TEXT NOT NULL,
	requested_by_user_id TEXT NOT NULL,
	status TEXT NOT NULL CHECK (
		status IN ('pending_checkout', 'applying', 'needs_retry', 'completed', 'canceled')
	),
	target_interval TEXT NOT NULL CHECK (target_interval IN ('month', 'year')),
	source_subscription_id TEXT NOT NULL,
	source_invoice_id TEXT,
	credit_amount_minor INTEGER,
	currency TEXT,
	checkout_session_id TEXT,
	checkout_expires_at TEXT,
	source_canceled_at TEXT,
	source_credit_note_id TEXT,
	target_balance_transaction_id TEXT,
	lease_expires_at TEXT,
	last_error_code TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	completed_at TEXT
)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_plan_transfers_open_source
	ON org_plan_transfers (source_org_id)
	WHERE status IN ('pending_checkout', 'applying', 'needs_retry')`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_org_plan_transfers_open_target
	ON org_plan_transfers (target_org_id)
	WHERE status IN ('pending_checkout', 'applying', 'needs_retry')`,
	]
	for (const statement of statements) {
		await db.prepare(statement).run()
	}
}
