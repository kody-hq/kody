import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	buildPackageAppAuthorityFallbackReport,
	packageAppAuthorityDifferenceKinds,
	packageAppAuthorityFallbackReportPackageLimitMax,
} from '#worker/package-runtime/package-app-authority-fallback.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminPerson,
} from './admin-shared.ts'
import {
	defaultSinceDay,
	utcDaySchema,
} from './admin-credential-allowed-packages-would-block-report.ts'

const inputSchema = z.object({
	since: utcDaySchema
		.optional()
		.describe(
			'First UTC day to include (YYYY-MM-DD). Defaults to the last 7 UTC days, today included.',
		),
	until: utcDaySchema
		.optional()
		.describe('UTC day to stop before, exclusive (YYYY-MM-DD). Omit for now.'),
	packageId: z.string().min(1).optional().describe('Only this app package.'),
	packageLimit: z
		.number()
		.int()
		.min(1)
		.max(packageAppAuthorityFallbackReportPackageLimitMax)
		.default(100)
		.describe(
			'Max apps in per-app detail, busiest first. Totals are never capped.',
		),
})

const eventSection = {
	totals: z.object({
		apps: z.number().int().nonnegative(),
		owners: z.number().int().nonnegative(),
		visitors: z
			.number()
			.int()
			.nonnegative()
			.describe(
				'Distinct hashed visitors; all anonymous visitors count as one.',
			),
		observations: z.number().int().nonnegative(),
	}),
	packagesTruncated: z.boolean(),
	packages: z
		.array(
			z.object({
				packageId: z.string(),
				ownerId: z.string(),
				packageKodyId: z.string().nullable(),
				observations: z.number().int().nonnegative(),
				visitors: z.number().int().nonnegative(),
				days: z.number().int().nonnegative(),
				firstSeenAt: z.string(),
				lastSeenAt: z.string(),
				calls: z.array(
					z.object({
						callName: z.string(),
						kind: z.enum(packageAppAuthorityDifferenceKinds),
						observations: z.number().int().nonnegative(),
					}),
				),
			}),
		)
		.describe(
			'Per-app detail for internal decisions only. Do not paste into public PR, issue, or commit text; use totals.',
		),
}

const outputSchema = z.object({
	since: z.string(),
	until: z.string().nullable(),
	...eventSection,
	totals: eventSection.totals.describe(
		'Calls that failed as the runs-as person and worked the legacy way.',
	),
	hardRejections: z
		.object(eventSection)
		.describe(
			'Calls refused as not declared in kody.app.capabilities (including credential.named) that also failed the legacy way, so the app saw the error. Keyed like the fallbacks. Any count here is a bug to fix.',
		),
})

export const adminPackageAppAuthorityFallbackReportCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminCapabilityAccess,
		name: 'adminPackageAppAuthorityFallbackReport',
		contextRuns: 'deny',
		description:
			'Read-only report of package app calls that failed as the app’s runs-as person (publisher authority) and fell back to the legacy visitor authority, so the app kept working, plus `hardRejections`: undeclared-capability calls that failed both ways. Counts per app, per call name, and per kind of difference. Visitors are hashed; never returns handles, names, or credential values. Admin-only; use counts in public text.',
		keywords: [
			'admin',
			'package app',
			'runs as',
			'publisher',
			'authority',
			'fallback',
			'would break',
			'hard rejection',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			await resolveActingAdminPerson(ctx)
			const since = args.since ?? defaultSinceDay()
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminPackageAppAuthorityFallbackReport',
				async () =>
					await buildPackageAppAuthorityFallbackReport({
						db: ctx.env.APP_DB,
						since,
						until: args.until ?? null,
						packageId: args.packageId ?? null,
						packageLimit: args.packageLimit,
					}),
				{
					successReason: (result) =>
						`since=${result.since};apps=${String(result.totals.apps)};owners=${String(result.totals.owners)};observations=${String(result.totals.observations)};rejectedApps=${String(result.hardRejections.totals.apps)};rejections=${String(result.hardRejections.totals.observations)}`,
				},
			)
		},
	})
