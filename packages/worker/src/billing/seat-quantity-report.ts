import {
	countLiveSeats,
	effectiveFreeOrgSql,
	isPaidOrgBilling,
} from '#worker/orgs/billing.ts'
import { auditDatabaseFromEnvOrThrow } from '#worker/orgs/org-audit.ts'
import { listSubscriptions, type StripeEnv } from './stripe-client.ts'
import {
	billingSeatQuantitySyncedAction,
	selectPurchasableSeatSubscription,
} from './seat-sync.ts'
import { type BillingEnv } from './billing-config.ts'
import { McpCallerError } from '#mcp/caller-error.ts'

type SeatQuantityReportEnv = Env & BillingEnv & StripeEnv

type SeatQuantityReportInput = {
	db: D1Database
	env: SeatQuantityReportEnv
	since: string
	checkStripe: boolean
	limit: number
	offset: number
}

function parseQuantity(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
		? value
		: null
}

export async function buildSeatQuantityReport(input: SeatQuantityReportInput) {
	if (input.checkStripe && !input.env.STRIPE_SECRET_KEY?.trim()) {
		throw new McpCallerError('Stripe is not configured in this environment.')
	}
	const since = new Date(input.since).toISOString()
	const auditDb = auditDatabaseFromEnvOrThrow(input.env)
	const auditRows = await auditDb
		.prepare(
			`SELECT org_id, details_json
			 FROM org_audit_events
			 WHERE action = ? AND created_at >= ?`,
		)
		.bind(billingSeatQuantitySyncedAction, since)
		.all<{ org_id: string; details_json: string | null }>()
	const orgs = new Set<string>()
	const changes = new Map<
		string,
		{ previousQuantity: number; nextQuantity: number; orgs: Set<string> }
	>()
	for (const row of auditRows.results ?? []) {
		orgs.add(row.org_id)
		let details: unknown
		try {
			details = row.details_json ? JSON.parse(row.details_json) : null
		} catch {
			continue
		}
		if (!details || typeof details !== 'object') continue
		const previousQuantity = parseQuantity(
			(details as Record<string, unknown>).previousQuantity,
		)
		const nextQuantity = parseQuantity(
			(details as Record<string, unknown>).nextQuantity,
		)
		if (previousQuantity === null || nextQuantity === null) continue
		const key = `${previousQuantity}:${nextQuantity}`
		const group = changes.get(key) ?? {
			previousQuantity,
			nextQuantity,
			orgs: new Set<string>(),
		}
		group.orgs.add(row.org_id)
		changes.set(key, group)
	}
	const output: {
		syncs: {
			since: string
			events: number
			orgs: number
			changes: Array<{
				previousQuantity: number
				nextQuantity: number
				orgs: number
			}>
		}
		stripe?: {
			checked: number
			matching: number
			mismatched: number
			skipped: number
			mismatches: Array<{
				stripeQuantity: number
				liveSeats: number
				orgs: number
			}>
			nextOffset: number | null
		}
	} = {
		syncs: {
			since,
			events: auditRows.results?.length ?? 0,
			orgs: orgs.size,
			changes: [...changes.values()]
				.map((group) => ({
					previousQuantity: group.previousQuantity,
					nextQuantity: group.nextQuantity,
					orgs: group.orgs.size,
				}))
				.sort((a, b) => b.orgs - a.orgs),
		},
	}
	if (!input.checkStripe) return output

	const rows = await input.db
		.prepare(
			`SELECT id, plan, stripe_plan, stripe_customer_id
			 FROM orgs o
			 WHERE o.deleted_at IS NULL
			   AND o.stripe_customer_id IS NOT NULL
			   AND NOT ${effectiveFreeOrgSql('o')}
			 ORDER BY o.id
			 LIMIT ? OFFSET ?`,
		)
		.bind(input.limit + 1, input.offset)
		.all<{
			id: string
			plan: string
			stripe_plan: string | null
			stripe_customer_id: string
		}>()
	const page = rows.results ?? []
	const hasNext = page.length > input.limit
	const mismatches = new Map<
		string,
		{ stripeQuantity: number; liveSeats: number; orgs: number }
	>()
	let checked = 0
	let matching = 0
	let skipped = 0
	for (const row of page.slice(0, input.limit)) {
		if (!isPaidOrgBilling(row)) {
			skipped += 1
			continue
		}
		let selected: ReturnType<typeof selectPurchasableSeatSubscription> = null
		try {
			selected = selectPurchasableSeatSubscription(
				input.env,
				await listSubscriptions(input.env, row.stripe_customer_id),
			)
		} catch (error) {
			skipped += 1
			console.warn('seat-quantity-report-stripe-lookup-failed', {
				error: error instanceof Error ? error.name : 'UnknownError',
			})
			continue
		}
		if (!selected) {
			skipped += 1
			continue
		}
		const stripeQuantity = selected.seatQuantity
		const liveSeats = Math.max(1, await countLiveSeats(input.db, row.id))
		checked += 1
		if (stripeQuantity === liveSeats) {
			matching += 1
			continue
		}
		const key = `${stripeQuantity}:${liveSeats}`
		const group = mismatches.get(key) ?? {
			stripeQuantity,
			liveSeats,
			orgs: 0,
		}
		group.orgs += 1
		mismatches.set(key, group)
	}
	output.stripe = {
		checked,
		matching,
		mismatched: checked - matching,
		skipped,
		mismatches: [...mismatches.values()].sort((a, b) => b.orgs - a.orgs),
		nextOffset: hasNext ? input.offset + input.limit : null,
	}
	return output
}
