import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	listedPackageFetchBindingScanBundlesPerCall,
	listedPackageFetchBindingScanLimitDefault,
	listedPackageFetchBindingScanLimitMax,
	runListedPackageFetchBindingScan,
} from '#worker/credentials/listed-package-fetch-binding-scan.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const count = z.number().int().nonnegative()

const inputSchema = z.object({
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe('nextCursor from the previous page.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(listedPackageFetchBindingScanLimitMax)
		.optional()
		.describe(
			`Listed packages to inspect this page (default ${listedPackageFetchBindingScanLimitDefault}, max ${listedPackageFetchBindingScanLimitMax}).`,
		),
	bundlesPerCall: z
		.number()
		.int()
		.min(1)
		.max(listedPackageFetchBindingScanBundlesPerCall)
		.optional()
		.describe(
			`Stored bundles to read this call (default and max ${listedPackageFetchBindingScanBundlesPerCall}). Lower it when a call runs out of memory or CPU time.`,
		),
})

const outputSchema = z.object({
	lists: z
		.array(
			z.object({
				credentialId: z.string(),
				ownerId: z.string(),
				packageIds: z.array(z.string()),
			}),
		)
		.nullable()
		.describe(
			'Every credential with a non-empty allowed packages list, ids only. First page only.',
		),
	packages: z.array(
		z.object({
			packageId: z.string(),
			outcome: z.enum([
				'unbound_reads',
				'needs_install_to_rebuild',
				'not_parsed',
				'rebuild_from_source',
				'bound_in_place',
				'no_global_reads',
				'unpublished',
				'no_stored_bundles',
				'failed',
			]),
			bundles: count,
			bundlesWithGlobalReads: count,
			unboundReadShapes: z
				.array(z.string())
				.describe('Short code shapes of the reads behind unbound_reads.'),
			unresolved: z
				.boolean()
				.describe(
					'Upper bound: a read of .fetch, or a computed read from the global object, could not be shown to come from somewhere other than the global object.',
				),
			unresolvedShapes: z.array(z.string()),
			bundlesWithUndefinedGlobalReads: count.describe(
				'Bundles reading window.fetch or global.fetch, which the package runtime does not define. Reported, not counted.',
			),
			partial: z
				.boolean()
				.optional()
				.describe(
					"True when the call stopped part way through this package's bundles. The next page reports it again for the rest: add the counts and keep the worst outcome.",
				),
			error: z.string().optional(),
		}),
	),
	nextCursor: z.string().nullable(),
})

export const adminListedPackageFetchBindingScanCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminCapabilityAccess,
		name: 'adminListedPackageFetchBindingScan',
		contextRuns: 'deny',
		description:
			"Read-only scan of the stored bundles of every package on a credential's allowed packages list for reads of fetch through the global object (globalThis.fetch, self.fetch). Per package: whether such reads exist, whether they sit in a single-package bundle (bindable in place), in a bundle that inlines other packages (needs a rebuild from source, with or without an npm install), or reach the global object in a way the on-load bind does not cover (unbound_reads: another name for the global object, followed through assignments, properties, parameters and return values). Reads that cannot be resolved either way are reported separately as an upper bound. Writes nothing. One page per call, cut short once it has read a fixed number of bundles, so a package with many bundles can span pages (partial: true). Resume with nextCursor until null.",
		keywords: [
			'admin',
			'credential',
			'allowed packages',
			'bundle',
			'fetch',
			'scan',
			'fleet',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminListedPackageFetchBindingScan',
				async () =>
					await runListedPackageFetchBindingScan({
						env: ctx.env,
						cursor: args.cursor ?? null,
						limit: args.limit,
						bundlesPerCall: args.bundlesPerCall,
					}),
				{
					successReason: (result) =>
						`packages=${result.packages.length};done=${result.nextCursor === null}`,
				},
			)
		},
	})
