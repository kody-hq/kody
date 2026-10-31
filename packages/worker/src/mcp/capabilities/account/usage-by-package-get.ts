import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import {
	creditAttributionForPackage,
	type CreditAttributionRow,
} from '#universal/credit-attribution.ts'
import { routes } from '#universal/routes.ts'
import { readAccountComputeOverage } from '#worker/billing/compute-overage-account.ts'
import { getUserEntitlement } from '#worker/entitlements/service.ts'
import { resolvePublicUsername } from '#worker/identity/user-lookup.ts'
import {
	entitlementEmailForOwner,
	ownerIdFromCaller,
} from '#worker/request-context/owner-id.ts'
import { loadCreditAttributionBreakdown } from '#worker/usage/credit-attribution.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

const creditAttributionMeterSchema = z.enum([
	'unique_worker_days',
	'durable_object_rows_read',
])

const creditAttributionMeterSplitSchema = z.object({
	meter: creditAttributionMeterSchema,
	/** Customer label: Worker compute / Rows read. */
	label: z.string(),
	creditsMicroUsd: z.number().int().nonnegative(),
})

const creditAttributionCumulativePointSchema = z.object({
	day: z.string(),
	creditsMicroUsd: z.number().int().nonnegative(),
})

const creditAttributionVisitorSchema = z.object({
	displayName: z.string(),
	creditsMicroUsd: z.number().int().nonnegative(),
	lastDay: z.string(),
	/** The visitor's own org paid for their metered work (ADR 0095). */
	billedToVisitorOrg: z.boolean().optional(),
	meters: z.array(
		z.object({
			meter: creditAttributionMeterSchema,
			label: z.string(),
			units: z.number().nonnegative(),
			creditsMicroUsd: z.number().int().nonnegative(),
			billedToVisitorOrg: z.boolean().optional(),
		}),
	),
})

const creditAttributionRowSchema = z.object({
	packageId: z.string(),
	/** Display name (package name/kodyId, or Ad hoc). */
	name: z.string(),
	/** Community href when this is a known owned package; null for Ad hoc. */
	href: z.string().nullable(),
	creditsMicroUsd: z.number().int().nonnegative(),
	/** 0–1 share of the period credit total. */
	share: z.number().nonnegative(),
	meters: z.array(creditAttributionMeterSplitSchema),
	/** Running total of this row's credits across the period (oldest first). */
	cumulative: z.array(creditAttributionCumulativePointSchema),
	isAdHoc: z.boolean(),
	visitors: z.array(creditAttributionVisitorSchema).optional(),
	visitorCount: z.number().int().nonnegative().optional(),
	visitorsTruncated: z.boolean().optional(),
})

/**
 * Current-UTC-month past-include credit attribution by package (same shape as
 * account usage `whereItWent`). Meters are only Worker compute
 * (`unique_worker_days`) and Rows read (`durable_object_rows_read`) credits —
 * not execute, jobs, or package exports.
 */
export const usageByPackageGetCapability = defineDomainCapability(
	capabilityDomainNames.account,
	{
		name: 'usageByPackageGet',
		contextRuns: 'allow',
		orgPermission: 'billing:read',
		description:
			'Read the current UTC month past-include credit attribution for the org this connection is bound to (personal or team) by package (Where it went): Worker compute and Rows read credits only — not execute, jobs, or package exports. Optional packageId returns that package’s slice of the same period breakdown. Another org’s internal app that this org’s people visited shows up named as shared by its owner (this org paid for that metered work); in a publisher’s Visitors list, visitors from other orgs are flagged billedToVisitorOrg with no credits charged here.',
		keywords: [
			'account',
			'usage',
			'by package',
			'attribution',
			'where it went',
			'credits',
			'worker compute',
			'rows read',
			'package filter',
			'dashboard',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			packageId: z
				.string()
				.trim()
				.min(1)
				.optional()
				.describe(
					'When set, return only this package’s row from the current-month breakdown (zero row when the package spent nothing). Omit for the full Where-it-went list including Ad hoc.',
				),
		}),
		outputSchema: z.object({
			/** UTC month key (`YYYY-MM`) for the current period. */
			month: z.string(),
			/**
			 * Sum of attributed past-include credits this period (Worker compute
			 * + Rows read only). Unchanged when filtering to one packageId so
			 * row.share stays relative to the full month.
			 */
			totalCreditsMicroUsd: z.number().int().nonnegative(),
			rows: z.array(creditAttributionRowSchema),
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const db = ctx.env.APP_DB
			const now = new Date()
			const ownerId = ownerIdFromCaller(ctx.callerContext)
			const teamSlug =
				ownerId === personalOrgIdForPerson(user)
					? null
					: ctx.callerContext.request?.org.slug?.trim() || null
			const entitlement = await getUserEntitlement(db, {
				userId: ownerId,
				email: entitlementEmailForOwner(ctx.callerContext, ownerId),
			})
			const [computeOverage, username] = await Promise.all([
				readAccountComputeOverage({
					db,
					stableUserId: ownerId,
					plan: entitlement.plan,
					ladder: entitlement.ladder,
					creditWallet: entitlement.creditWallet,
					limitOverrides: entitlement.limitOverrides,
					now,
				}),
				teamSlug ??
					resolvePublicUsername({
						db,
						username: user.username,
						email: user.email,
					}),
			])
			if (!username) {
				throw new Error(
					'Authenticated MCP user username is required for usage attribution.',
				)
			}
			const breakdown = await loadCreditAttributionBreakdown({
				db,
				stableUserId: ownerId,
				username,
				computeOverage,
				now,
			})
			const packageId = args.packageId
			if (!packageId) return breakdown
			const row = creditAttributionForPackage(breakdown, packageId)
			if (!row) {
				return {
					month: breakdown.month,
					totalCreditsMicroUsd: breakdown.totalCreditsMicroUsd,
					rows: [],
				}
			}
			return {
				month: breakdown.month,
				totalCreditsMicroUsd: breakdown.totalCreditsMicroUsd,
				rows: [
					await enrichUnspentPackageAttributionRow({
						db,
						stableUserId: ownerId,
						username,
						row,
					}),
				],
			}
		},
	},
)

/**
 * Zero-spend package slices from {@link creditAttributionForPackage} use the
 * raw package id as the name and a null href. Restore the saved package label
 * and community link the same way the package settings page does.
 */
async function enrichUnspentPackageAttributionRow(input: {
	db: D1Database
	stableUserId: string
	username: string
	row: CreditAttributionRow
}): Promise<CreditAttributionRow> {
	const { row } = input
	if (row.isAdHoc) return row
	if (row.name !== row.packageId && row.href) return row
	const saved = await input.db
		.prepare(
			`SELECT kody_id, name FROM saved_packages WHERE id = ? AND user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(row.packageId, input.stableUserId)
		.first<{ kody_id: string; name: string }>()
	if (!saved) return row
	return {
		...row,
		name: saved.name?.trim() || saved.kody_id,
		href: routes.communityPackage.href({
			username: input.username,
			kodyId: saved.kody_id,
		}),
	}
}
