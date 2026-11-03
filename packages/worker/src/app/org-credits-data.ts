import { utcMonthKey } from '@kody-internal/shared/date-keys.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { BillingPageOrg } from '#app/account-billing-data.ts'
import {
	computeOverageUnitLabels,
	computeOverageWarningResourceLabels,
} from '#universal/compute-overage.ts'
import {
	signupWelcomeCreditLedgerIdPrefix,
	signupWelcomeCreditNote,
} from '#universal/credits.ts'
import type {
	OrgCreditsBudget,
	OrgCreditsBudgets,
	OrgCreditsLedgerEntry,
	OrgCreditsLedgerPage,
	OrgCreditsLoaderData,
} from '#universal/loader-data.ts'
import {
	orgUsageCreditsPath,
	orgUsageWhereItWentPath,
} from '#universal/org-pages.ts'
import {
	listCreditLedgerPage,
	readCreditWallet,
	type CreditLedgerCursor,
	type CreditLedgerEntry,
} from '#worker/billing/credit-wallet.ts'
import {
	resolveUserPlanFromRow,
	userEntitlementColumnsSql,
	type UserEntitlementRow,
} from '#worker/entitlements/service.ts'
import {
	type UserMeterEnv,
	userMeterRpc,
} from '#worker/entitlements/user-meter-client.ts'
import {
	readOrgBudgetSettings,
	readUserBudgetMicroUsd,
} from '#worker/orgs/billing.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export const orgCreditsLedgerPageSize = 50

export class InvalidCreditLedgerCursorError extends Error {
	constructor() {
		super('Invalid ledger cursor.')
		this.name = 'InvalidCreditLedgerCursorError'
	}
}

export function encodeCreditLedgerCursor(cursor: CreditLedgerCursor): string {
	return btoa(JSON.stringify([cursor.createdAt, cursor.id]))
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/, '')
}

/** Null when absent; throws {@link InvalidCreditLedgerCursorError} when malformed. */
export function decodeCreditLedgerCursor(
	value: string | null,
): CreditLedgerCursor | null {
	if (value === null || value === '') return null
	try {
		const parsed: unknown = JSON.parse(
			atob(value.replaceAll('-', '+').replaceAll('_', '/')),
		)
		if (
			Array.isArray(parsed) &&
			parsed.length === 2 &&
			typeof parsed[0] === 'string' &&
			typeof parsed[1] === 'string' &&
			parsed[0] &&
			parsed[1]
		) {
			return { createdAt: parsed[0], id: parsed[1] }
		}
	} catch {
		// Fall through to the typed error below.
	}
	throw new InvalidCreditLedgerCursorError()
}

const monthFormatter = new Intl.DateTimeFormat('en-US', {
	month: 'long',
	year: 'numeric',
	timeZone: 'UTC',
})

function formatLedgerMonth(month: string): string | null {
	const match = /^(\d{4})-(\d{2})$/.exec(month)
	if (!match) return null
	return monthFormatter.format(
		new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)),
	)
}

function isDebitMeter(
	meter: string,
): meter is keyof typeof computeOverageWarningResourceLabels {
	return Object.hasOwn(computeOverageWarningResourceLabels, meter)
}

/**
 * Customer copy for one ledger row. Admin grant notes are internal audit
 * text and are never shown here.
 */
export function describeOrgCreditsLedgerEntry(
	entry: CreditLedgerEntry,
): Pick<OrgCreditsLedgerEntry, 'typeLabel' | 'description' | 'detail'> {
	switch (entry.kind) {
		case 'top_up':
			return {
				typeLabel: 'Purchase',
				description: 'Added credits',
				detail: null,
			}
		case 'auto_refill':
			return {
				typeLabel: 'Auto-refill',
				description: 'Auto-refilled credits',
				detail: 'Charged to the saved card',
			}
		case 'admin_grant':
			return entry.id.startsWith(signupWelcomeCreditLedgerIdPrefix)
				? {
						typeLabel: 'Grant',
						description: signupWelcomeCreditNote,
						detail: 'Granted at signup',
					}
				: {
						typeLabel: 'Grant',
						description: 'Credits granted by Kody',
						detail: null,
					}
		case 'debit': {
			const meter =
				entry.meter && isDebitMeter(entry.meter) ? entry.meter : null
			const month = entry.month ? formatLedgerMonth(entry.month) : null
			const units =
				meter && entry.units != null
					? `${entry.units.toLocaleString('en-US')} ${computeOverageUnitLabels[meter]}`
					: null
			const detail = units
				? month
					? `${units} past the ${month} include`
					: `${units} past the monthly include`
				: month
					? `Usage past the ${month} include`
					: null
			return {
				typeLabel: 'Usage',
				description: meter
					? computeOverageWarningResourceLabels[meter]
					: (entry.meter ?? 'Usage'),
				detail,
			}
		}
		default: {
			const exhaustive: never = entry.kind
			throw new Error(`Unknown ledger entry kind: ${String(exhaustive)}`)
		}
	}
}

/**
 * A newest-first ledger page with the balance after each row, walked back
 * from the wallet's current balance (every balance change writes one row).
 * `balanceMicroUsd` is that balance, read in the same snapshot as the page.
 */
export async function loadOrgCreditsLedgerPage(input: {
	db: D1Database
	orgId: OwnerId
	before: CreditLedgerCursor | null
	limit?: number
}): Promise<{ balanceMicroUsd: number; page: OrgCreditsLedgerPage }> {
	const page = await listCreditLedgerPage({
		db: input.db,
		userId: input.orgId,
		limit: input.limit ?? orgCreditsLedgerPageSize,
		before: input.before,
	})
	let balanceAfter = page.balanceMicroUsd - page.newerAmountMicroUsd
	const entries = page.entries.map((entry): OrgCreditsLedgerEntry => {
		const row: OrgCreditsLedgerEntry = {
			id: entry.id,
			kind: entry.kind,
			...describeOrgCreditsLedgerEntry(entry),
			amountMicroUsd: entry.amountMicroUsd,
			balanceAfterMicroUsd: balanceAfter,
			createdAt: entry.createdAt,
		}
		balanceAfter -= entry.amountMicroUsd
		return row
	})
	const last = page.entries.at(-1)
	return {
		balanceMicroUsd: page.balanceMicroUsd,
		page: {
			entries,
			nextCursor:
				page.hasMore && last
					? encodeCreditLedgerCursor({ createdAt: last.createdAt, id: last.id })
					: null,
		},
	}
}

async function readBudgetSpend(input: {
	env: UserMeterEnv
	orgId: OwnerId
	month: string
}): Promise<{
	users: Record<string, number>
	automationMicroUsd: number
} | null> {
	try {
		return await userMeterRpc({
			env: input.env,
			userId: input.orgId,
		}).getBudgetSpend({ month: input.month })
	} catch (error) {
		console.error('org_credits_budget_spend_read_failed', {
			orgId: input.orgId,
			error,
		})
		return null
	}
}

async function loadOrgCreditsBudgets(input: {
	env: Env
	orgId: OwnerId
	viewerUserId: string
	includeOrg: boolean
	now: Date
}): Promise<OrgCreditsBudgets> {
	const month = utcMonthKey(input.now)
	const [settings, individual] = await Promise.all([
		readOrgBudgetSettings(input.env.APP_DB, input.orgId),
		readUserBudgetMicroUsd(input.env.APP_DB, input.orgId, input.viewerUserId),
	])
	const yoursBudget = individual ?? settings.defaultUserBudgetMicroUsd
	const automationBudget = input.includeOrg
		? settings.automationBudgetMicroUsd
		: null
	const spend =
		yoursBudget != null || automationBudget != null
			? await readBudgetSpend({ env: input.env, orgId: input.orgId, month })
			: null
	const withSpend = (
		budgetMicroUsd: number,
		spentMicroUsd: number | undefined,
	): OrgCreditsBudget => ({
		budgetMicroUsd,
		spentMicroUsd: spend ? (spentMicroUsd ?? 0) : null,
	})
	return {
		month,
		yours:
			yoursBudget == null
				? null
				: {
						...withSpend(yoursBudget, spend?.users[input.viewerUserId]),
						source: individual != null ? 'individual' : 'orgDefault',
					},
		org: input.includeOrg
			? {
					defaultUserBudgetMicroUsd: settings.defaultUserBudgetMicroUsd,
					automation:
						automationBudget == null
							? null
							: withSpend(automationBudget, spend?.automationMicroUsd),
				}
			: null,
	}
}

async function readOrgEntitlementRow(
	db: D1Database,
	orgId: OwnerId,
): Promise<UserEntitlementRow | null> {
	return await db
		.prepare(
			`SELECT ${userEntitlementColumnsSql()}
			 FROM orgs
			 WHERE id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(orgId)
		.first<UserEntitlementRow>()
}

/**
 * `/@slug/-/credits`: owners and billing admins (`billing:read`) get the
 * wallet balance, organization budgets, and the full ledger. Everyone else
 * in the organization gets only their own budget and its spend this month.
 * Free organizations keep any balance and history they already have.
 */
export async function loadOrgCreditsData(input: {
	env: Env
	org: BillingPageOrg
	viewerUserId: string
	canReadBilling: boolean
	before: CreditLedgerCursor | null
	now?: Date
}): Promise<OrgCreditsLoaderData | null> {
	const now = input.now ?? new Date()
	const orgId = input.org.id as OwnerId
	const db = input.env.APP_DB
	const budgets = await loadOrgCreditsBudgets({
		env: input.env,
		orgId,
		viewerUserId: input.viewerUserId,
		includeOrg: input.canReadBilling,
		now,
	})
	const org = {
		slug: input.org.slug,
		displayName: input.org.displayName,
		personal: input.org.personal,
	}
	if (!input.canReadBilling) {
		return {
			ok: true,
			org,
			access: 'member',
			wallet: null,
			budgets,
			ledger: null,
		}
	}
	const [row, wallet, ledger] = await Promise.all([
		readOrgEntitlementRow(db, orgId),
		readCreditWallet(db, orgId),
		loadOrgCreditsLedgerPage({ db, orgId, before: input.before }),
	])
	if (!row) return null
	return {
		ok: true,
		org,
		access: 'billing',
		wallet: {
			balanceMicroUsd: ledger.balanceMicroUsd,
			creditsEligible: resolveUserPlanFromRow(row, now).creditsEligible,
			autoRefillEnabled: wallet.autoRefill.enabled,
			manageHref: orgUsageCreditsPath(input.org.slug),
			whereItWentHref: orgUsageWhereItWentPath(input.org.slug),
		},
		budgets,
		ledger: ledger.page,
	}
}
