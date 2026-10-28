import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	allowedPackagesWouldBlockReportOwnerLimitMax,
	buildAllowedPackagesWouldBlockReport,
} from '#worker/credentials/allowed-packages-would-block.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminPerson,
} from './admin-shared.ts'

export const utcDaySchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a UTC day like 2026-10-23.')
	.refine(
		(value) => {
			const parsed = new Date(`${value}T00:00:00.000Z`)
			return (
				!Number.isNaN(parsed.getTime()) &&
				parsed.toISOString().slice(0, 10) === value
			)
		},
		{ message: 'Use a real calendar day like 2026-10-23.' },
	)

const inputSchema = z.object({
	since: utcDaySchema
		.optional()
		.describe(
			'First UTC day to include (YYYY-MM-DD). Defaults to the last 7 UTC days, today included.',
		),
	until: utcDaySchema
		.optional()
		.describe('UTC day to stop before, exclusive (YYYY-MM-DD). Omit for now.'),
	ownerLimit: z
		.number()
		.int()
		.min(1)
		.max(allowedPackagesWouldBlockReportOwnerLimitMax)
		.default(100)
		.describe(
			'Max owners in per-owner detail, busiest first. Totals are never capped.',
		),
})

const accessKindSchema = z.enum(['self_authored', 'adopted'])

const outputSchema = z.object({
	since: z.string(),
	until: z.string().nullable(),
	totals: z.object({
		owners: z.number().int().nonnegative(),
		credentials: z.number().int().nonnegative(),
		packages: z.number().int().nonnegative(),
		credentialPackagePairs: z.number().int().nonnegative(),
		selfAuthoredPackages: z.number().int().nonnegative(),
		adoptedPackages: z.number().int().nonnegative(),
		observations: z
			.number()
			.int()
			.nonnegative()
			.describe('Allowed uses that enforcement would have refused.'),
	}),
	ownersTruncated: z.boolean(),
	owners: z
		.array(
			z.object({
				ownerId: z.string(),
				ownerSlug: z.string().nullable(),
				credentials: z.number().int().nonnegative(),
				packages: z.number().int().nonnegative(),
				observations: z.number().int().nonnegative(),
				firstSeenAt: z.string(),
				lastSeenAt: z.string(),
				pairs: z.array(
					z.object({
						credentialId: z.string(),
						credentialName: z
							.string()
							.nullable()
							.describe('Credential name only; never the value.'),
						packageId: z.string(),
						packageKodyId: z.string().nullable(),
						accessKind: accessKindSchema,
						days: z.number().int().nonnegative(),
						observations: z.number().int().nonnegative(),
						firstSeenAt: z.string(),
						lastSeenAt: z.string(),
					}),
				),
			}),
		)
		.describe(
			'Per-owner detail for internal decisions only. Do not paste into public PR, issue, or commit text; use totals.',
		),
})

/** Today plus the 6 UTC days before it: 7 calendar days with `day >= since`. */
export function defaultSinceDay(now = new Date()) {
	return new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000)
		.toISOString()
		.slice(0, 10)
}

export const adminCredentialAllowedPackagesWouldBlockReportCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminCapabilityAccess,
		name: 'adminCredentialAllowedPackagesWouldBlockReport',
		contextRuns: 'deny',
		description:
			'Read-only observe-mode report for issue #4129: uses where a self-authored or adopted package read a user credential whose allowed packages list is non-empty and leaves that package out. Access is still allowed today; this sizes enforcement. Returns distinct owner, credential, and package counts plus per-owner detail (ids, credential names, package kody ids, day counts, first/last seen). Never returns credential values. Never notifies owners. Admin-only; use counts in public text.',
		keywords: [
			'admin',
			'credential',
			'allowed packages',
			'would block',
			'enforcement',
			'impact',
			'4129',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			await resolveActingAdminPerson(ctx)
			const since = args.since ?? defaultSinceDay()
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminCredentialAllowedPackagesWouldBlockReport',
				async () =>
					await buildAllowedPackagesWouldBlockReport({
						db: ctx.env.APP_DB,
						since,
						until: args.until ?? null,
						ownerLimit: args.ownerLimit,
					}),
				{
					successReason: (result) =>
						`since=${result.since};owners=${String(result.totals.owners)};credentials=${String(result.totals.credentials)};packages=${String(result.totals.packages)};observations=${String(result.totals.observations)}`,
				},
			)
		},
	})
