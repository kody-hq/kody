import { DatabaseSync } from 'node:sqlite'
import { beforeEach, expect, test, vi } from 'vitest'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { ensureCreditWalletTestSchema } from '#worker/billing/test-schema.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	getBudgetSpend: vi.fn(
		async (_input: { month: string }) =>
			({
				month: '2026-10',
				users: {} as Record<string, number>,
				automationMicroUsd: 0,
			}) as {
				month: string
				users: Record<string, number>
				automationMicroUsd: number
			},
	),
}))

vi.mock('#worker/entitlements/user-meter-client.ts', () => ({
	userMeterRpc: () => ({ getBudgetSpend: mocks.getBudgetSpend }),
}))

const {
	decodeCreditLedgerCursor,
	describeOrgCreditsLedgerEntry,
	loadOrgCreditsData,
	loadOrgCreditsLedgerPage,
} = await import('./org-credits-data.ts')

const now = new Date('2026-10-14T12:00:00.000Z')
const orgId = ownerIdFromStored('org-acme')
const org = {
	id: orgId,
	slug: 'acme',
	displayName: 'Acme',
	personal: false,
}

let sqlite: DatabaseSync
let db: D1Database

function env() {
	return { APP_DB: db, USER_METER: {} } as unknown as Env
}

function insertLedger(row: {
	id: string
	kind: 'top_up' | 'auto_refill' | 'admin_grant' | 'debit'
	amountMicroUsd: number
	createdAt: string
	meter?: string
	month?: string
	units?: number
	note?: string
}) {
	sqlite
		.prepare(
			`INSERT INTO credit_ledger_entries
				(id, user_id, kind, amount_micro_usd, meter, month, units, note, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			row.id,
			orgId,
			row.kind,
			row.amountMicroUsd,
			row.meter ?? null,
			row.month ?? null,
			row.units ?? null,
			row.note ?? null,
			row.createdAt,
		)
}

function setBalance(balanceMicroUsd: number) {
	sqlite
		.prepare(
			`INSERT INTO credit_wallets (user_id, balance_micro_usd, created_at, updated_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT (user_id) DO UPDATE SET balance_micro_usd = excluded.balance_micro_usd`,
		)
		.run(orgId, balanceMicroUsd, now.toISOString(), now.toISOString())
}

/** $5 welcome, $25 goodwill grant, $10 top-up, two usage debits: $38.99 left. */
function seedLedger() {
	insertLedger({
		id: 'signup_welcome:org-acme',
		kind: 'admin_grant',
		amountMicroUsd: 5_000_000,
		createdAt: '2026-09-01T00:00:00.000Z',
	})
	insertLedger({
		id: 'grant-1',
		kind: 'admin_grant',
		amountMicroUsd: 25_000_000,
		createdAt: '2026-09-15T00:00:00.000Z',
		note: 'internal: refund for outage',
	})
	insertLedger({
		id: 'topup-1',
		kind: 'top_up',
		amountMicroUsd: 10_000_000,
		createdAt: '2026-10-01T00:00:00.000Z',
	})
	insertLedger({
		id: 'debit:org-acme:2026-10:unique_worker_days:0',
		kind: 'debit',
		amountMicroUsd: -1_000_000,
		createdAt: '2026-10-10T00:00:00.000Z',
		meter: 'unique_worker_days',
		month: '2026-10',
		units: 250,
	})
	insertLedger({
		id: 'debit:org-acme:2026-10:durable_object_rows_read:0',
		kind: 'debit',
		amountMicroUsd: -10_000,
		createdAt: '2026-10-10T00:00:00.000Z',
		meter: 'durable_object_rows_read',
		month: '2026-10',
		units: 5_000_000,
	})
	setBalance(38_990_000)
}

beforeEach(async () => {
	vi.clearAllMocks()
	sqlite = new DatabaseSync(':memory:')
	db = createD1FromSqlite(sqlite)
	await ensureCreditWalletTestSchema(db)
	sqlite
		.prepare(
			`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
			 VALUES (?, 'acme', 'Acme', ?, ?)`,
		)
		.run(orgId, now.toISOString(), now.toISOString())
})

test('ledger pages walk newest first with the balance after every row', async () => {
	seedLedger()
	const { balanceMicroUsd, page: first } = await loadOrgCreditsLedgerPage({
		db,
		orgId,
		before: null,
		limit: 2,
	})
	const { page: second } = await loadOrgCreditsLedgerPage({
		db,
		orgId,
		before: decodeCreditLedgerCursor(first.nextCursor),
		limit: 2,
	})
	const { page: third } = await loadOrgCreditsLedgerPage({
		db,
		orgId,
		before: decodeCreditLedgerCursor(second.nextCursor),
		limit: 2,
	})
	const rows = [...first.entries, ...second.entries, ...third.entries].map(
		(entry) => [entry.id, entry.amountMicroUsd, entry.balanceAfterMicroUsd],
	)
	expect(rows).toEqual([
		['debit:org-acme:2026-10:unique_worker_days:0', -1_000_000, 38_990_000],
		['debit:org-acme:2026-10:durable_object_rows_read:0', -10_000, 39_990_000],
		['topup-1', 10_000_000, 40_000_000],
		['grant-1', 25_000_000, 30_000_000],
		['signup_welcome:org-acme', 5_000_000, 5_000_000],
	])
	expect(third.nextCursor).toBeNull()
	expect(balanceMicroUsd).toBe(38_990_000)
})

test('ledger rows say what they are without leaking internal grant notes', async () => {
	seedLedger()
	const { page } = await loadOrgCreditsLedgerPage({
		db,
		orgId,
		before: null,
	})
	expect(
		page.entries.map((entry) => [
			entry.typeLabel,
			entry.description,
			entry.detail,
		]),
	).toEqual([
		[
			'Usage',
			'Worker compute',
			'250 worker-compute days past the October 2026 include',
		],
		['Usage', 'Rows read', '5,000,000 rows read past the October 2026 include'],
		['Purchase', 'Added credits', null],
		['Grant', 'Credits granted by Kody', null],
		['Grant', 'Welcome credits', 'Granted at signup'],
	])
	expect(JSON.stringify(page)).not.toContain('outage')
	expect(
		describeOrgCreditsLedgerEntry({
			id: 'refill',
			kind: 'auto_refill',
			amountMicroUsd: 1,
			meter: null,
			month: null,
			units: null,
			grantedByUserId: null,
			note: null,
			createdAt: '',
		}),
	).toEqual({
		typeLabel: 'Auto-refill',
		description: 'Auto-refilled credits',
		detail: 'Charged to the saved card',
	})
})

test('billing readers get balance, org budgets, spend, and the ledger', async () => {
	seedLedger()
	sqlite
		.prepare(
			`UPDATE orgs SET plan = 'pro', stripe_plan = 'pro', stripe_credits_eligible = 1,
				default_user_budget_micro_usd = 20000000, automation_budget_micro_usd = 5000000
			 WHERE id = ?`,
		)
		.run(orgId)
	mocks.getBudgetSpend.mockResolvedValueOnce({
		month: '2026-10',
		users: { 'person-ada': 1_500_000 },
		automationMicroUsd: 250_000,
	})
	const data = await loadOrgCreditsData({
		env: env(),
		org,
		viewerUserId: 'person-ada',
		canReadBilling: true,
		before: null,
		now,
	})
	expect(mocks.getBudgetSpend).toHaveBeenCalledWith({ month: '2026-10' })
	expect(data).toMatchObject({
		ok: true,
		access: 'billing',
		org: { slug: 'acme', displayName: 'Acme', personal: false },
		wallet: {
			balanceMicroUsd: 38_990_000,
			creditsEligible: true,
			autoRefillEnabled: false,
			manageHref: '/@acme/-/usage#credits',
			whereItWentHref: '/@acme/-/usage#where-it-went',
		},
		budgets: {
			month: '2026-10',
			yours: {
				source: 'orgDefault',
				budgetMicroUsd: 20_000_000,
				spentMicroUsd: 1_500_000,
			},
			org: {
				defaultUserBudgetMicroUsd: 20_000_000,
				automation: { budgetMicroUsd: 5_000_000, spentMicroUsd: 250_000 },
			},
		},
	})
	expect(data?.ledger?.entries).toHaveLength(5)
})

test('members see only their own budget, never the balance or ledger', async () => {
	seedLedger()
	sqlite
		.prepare(
			`UPDATE orgs SET default_user_budget_micro_usd = 20000000,
				automation_budget_micro_usd = 5000000 WHERE id = ?`,
		)
		.run(orgId)
	sqlite
		.prepare(
			`INSERT INTO org_user_budgets
				(org_id, user_id, monthly_budget_micro_usd, set_by_user_id, updated_at)
			 VALUES (?, 'person-bob', 3000000, 'person-ada', ?)`,
		)
		.run(orgId, now.toISOString())
	mocks.getBudgetSpend.mockResolvedValueOnce({
		month: '2026-10',
		users: { 'person-bob': 400_000, 'person-ada': 9_000_000 },
		automationMicroUsd: 250_000,
	})
	const data = await loadOrgCreditsData({
		env: env(),
		org,
		viewerUserId: 'person-bob',
		canReadBilling: false,
		before: null,
		now,
	})
	expect(data).toEqual({
		ok: true,
		access: 'member',
		org: { slug: 'acme', displayName: 'Acme', personal: false },
		wallet: null,
		ledger: null,
		budgets: {
			month: '2026-10',
			yours: {
				source: 'individual',
				budgetMicroUsd: 3_000_000,
				spentMicroUsd: 400_000,
			},
			org: null,
		},
	})
})

test('an unreadable spend counter keeps the page and reports spend as unknown', async () => {
	consoleError.mockImplementation(() => {})
	sqlite
		.prepare(
			`UPDATE orgs SET default_user_budget_micro_usd = 20000000 WHERE id = ?`,
		)
		.run(orgId)
	mocks.getBudgetSpend.mockRejectedValueOnce(new Error('meter down'))
	const data = await loadOrgCreditsData({
		env: env(),
		org,
		viewerUserId: 'person-bob',
		canReadBilling: false,
		before: null,
		now,
	})
	expect(data?.budgets.yours).toEqual({
		source: 'orgDefault',
		budgetMicroUsd: 20_000_000,
		spentMicroUsd: null,
	})
	expect(consoleError.mock.calls.map(([message]) => message)).toEqual([
		'org_credits_budget_spend_read_failed',
	])
})
