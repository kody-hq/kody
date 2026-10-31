import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	allowedPackagesGrandfatherScanLimitDefault,
	allowedPackagesGrandfatherScanLimitMax,
	runAllowedPackagesGrandfather,
} from '#worker/credentials/allowed-packages-grandfather.ts'
import { orgAuditWriterFromCaller } from '#worker/orgs/org-audit.ts'
import { utcDaySchema } from './admin-credential-allowed-packages-would-block-report.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z.object({
	dryRun: z
		.boolean()
		.optional()
		.describe(
			'When true (default), report the pairs without changing any list. Set false to add each package to its credential allowed list.',
		),
	logSince: utcDaySchema
		.optional()
		.describe(
			'First UTC day of would-block markers to cross-check (default 2026-10-23, when the log started).',
		),
	logLastSeenAfter: z
		.string()
		.datetime()
		.optional()
		.describe(
			'Only count log pairs last seen after this ISO time (for example, after the pre-binding rebuild) so stale-build markers drop out.',
		),
	includeLogOnly: z
		.boolean()
		.optional()
		.describe(
			'Include pairs found only in the would-block log (default true). They cover runtime-built names static analysis cannot resolve.',
		),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe('Resume after this saved_packages.id from a prior nextCursor.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(allowedPackagesGrandfatherScanLimitMax)
		.optional()
		.describe(
			`Packages to inspect this step (default ${allowedPackagesGrandfatherScanLimitDefault}, max ${allowedPackagesGrandfatherScanLimitMax}).`,
		),
	packageIds: z.array(z.string().min(1)).min(1).max(90).optional(),
	ownerUserIds: z.array(z.string().min(1)).min(1).max(90).optional(),
})

const count = z.number().int().nonnegative()

const outputSchema = z.object({
	dryRun: z.boolean(),
	scannedPackages: count,
	staticScannedPackages: count,
	skippedUnpublished: count,
	skippedNoSnapshot: count,
	skippedUnadoptedFork: count,
	skippedEligibilityUnknown: count.describe(
		'Packages whose adoption or publication lookup failed. Their log markers never become grants.',
	),
	unparsedPackages: count,
	unresolvedPackages: count.describe(
		'Packages with runtime-built credential names, unparsed modules, or no source snapshot.',
	),
	pairs: count,
	staticPairs: count,
	logPairs: count,
	bothPairs: count,
	staticOnlyPairs: count,
	logOnlyPairs: count,
	logOnlyUnresolvedPairs: count,
	logOnlyAdoptedPairs: count,
	owners: count,
	credentials: count,
	packages: count,
	wouldGrant: count,
	granted: count,
	alreadyAllowed: count,
	missing: count,
	conflicts: count,
	nextCursor: z.string().nullable(),
	details: z.array(
		z.object({
			ownerId: z.string(),
			credentialId: z.string(),
			packageId: z.string(),
			accessKind: z.enum(['self_authored', 'adopted']),
			source: z.enum(['static', 'log', 'static+log']),
			packageUnresolved: z.boolean(),
			logLastSeenAt: z.string().nullable(),
			logObservations: count,
			outcome: z.enum([
				'would_grant',
				'granted',
				'already_allowed',
				'missing',
				'conflict',
			]),
		}),
	),
})

export const adminCredentialAllowedPackagesGrandfatherCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminMutationCapabilityAccess,
		destructive: false,
		name: 'adminCredentialAllowedPackagesGrandfather',
		contextRuns: 'deny',
		description:
			'Issue #4129 grandfather backfill. Static join: literal user credential names each package\'s own published source reads (same scan as the allowed-packages publish warning), against the runner\'s user credentials whose non-empty allowed_packages list excludes the package (owner; community forks only once adopted). Cross-checks credential_allowed_packages_would_block markers. dryRun (default true) reports counts and pairs only. Apply adds each package to its credential list with a guarded write and a credential.allowed_packages_updated audit row (reason "grandfathered for #4129", source static/log). Never notifies owners. Internal admin output: share counts only. One page per execute; resume with nextCursor until null.',
		keywords: [
			'admin',
			'credential',
			'allowed packages',
			'grandfather',
			'backfill',
			'4129',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const dryRun = args.dryRun !== false
			return auditAdminCapabilityInvocation(
				ctx,
				'adminCredentialAllowedPackagesGrandfather',
				async () =>
					await runAllowedPackagesGrandfather({
						env: ctx.env,
						audit: dryRun
							? null
							: orgAuditWriterFromCaller(ctx.env, ctx.callerContext),
						dryRun,
						afterId: args.cursor ?? null,
						limit: args.limit,
						logSince: args.logSince ?? '2026-10-23',
						logLastSeenAfter: args.logLastSeenAfter ?? null,
						includeLogOnly: args.includeLogOnly,
						packageIds: args.packageIds,
						ownerUserIds: args.ownerUserIds,
					}),
				{
					successReason: (result) =>
						`dry_run=${result.dryRun};scanned=${result.scannedPackages};pairs=${result.pairs};static=${result.staticPairs};log=${result.logPairs};unresolved=${result.unresolvedPackages};granted=${result.granted};conflicts=${result.conflicts}`,
				},
			)
		},
	})
