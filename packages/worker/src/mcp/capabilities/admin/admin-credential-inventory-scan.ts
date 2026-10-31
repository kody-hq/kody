import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	credentialOtherContexts,
	credentialPlacementTypes,
} from '#worker/credentials/credential-inventory-scan.ts'
import {
	credentialInventoryFailureListMax,
	credentialInventoryTallyMax,
	credentialInventoryScanLimitDefault,
	credentialInventoryScanLimitMax,
	getCredentialInventoryReport,
	runCredentialInventoryScanStep,
} from '#worker/credentials/credential-inventory.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminPerson,
} from './admin-shared.ts'

const count = z.number().int().nonnegative()

const placementCountsSchema = z.object(
	Object.fromEntries(credentialPlacementTypes.map((type) => [type, count])) as {
		[K in (typeof credentialPlacementTypes)[number]]: typeof count
	},
)

const tallySchema = z
	.array(z.object({ name: z.string(), count }))
	.describe(`Most common first, at most ${credentialInventoryTallyMax}.`)

const placeholderCountsSchema = z.object({
	secret: count,
	'secret-basic': count,
	'integration-token': count,
	vault: count,
	computed: count,
})

export const credentialInventoryReportSchema = z.object({
	packages: z.object({
		scanned: count,
		unpublished: count,
		failed: count,
		withPlaceholders: count,
		withSlots: count,
	}),
	placeholders: placeholderCountsSchema.describe(
		'Every placeholder occurrence by kind, including ones that match a declared slot.',
	),
	unparsedModules: count,
	references: z.object({
		total: count,
		attributed: count,
		unattributed: count,
		byPlacement: placementCountsSchema.describe(
			'`binding` is a placeholder bound to a variable; each read of the variable is counted as its own reference.',
		),
		unattributedByPlacement: placementCountsSchema,
		otherByContext: z
			.object(
				Object.fromEntries(
					credentialOtherContexts.map((context) => [context, count]),
				) as {
					[K in (typeof credentialOtherContexts)[number]]: typeof count
				},
			)
			.describe('Why each `other` placement is not on a request shape.'),
		bodyByEndpoint: z
			.object({ login: count, other: count, unknown: count })
			.describe(
				'Body placements by the literal fetch URL path: a login or token exchange, any other path, or not known statically.',
			),
		bodyFields: tallySchema.describe('Body fields placeholders fill.'),
		sdkOptions: tallySchema.describe(
			'`callee.key` object options passed to a call or constructor.',
		),
		argumentCallees: tallySchema.describe(
			'Functions a placeholder is passed to directly.',
		),
	}),
	vault: z.object({ byPlacement: placementCountsSchema }),
	signing: z.object({
		placeholderKeys: count.describe(
			'Placeholders used as signing key material (HMAC, JWT, crypto.subtle).',
		),
		jwtSignCalls: count.describe('`secretJwtSign` calls in package source.'),
		packagesWithSigning: count,
	}),
	slots: z.object({
		total: count,
		attributed: count,
		byKind: z.object({ secret: count, oauth: count, mcp: count }),
	}),
	credentialsReferenced: count,
	failures: z
		.array(z.object({ packageId: z.string(), error: z.string() }))
		.describe(
			`Packages the run could not scan, with the load error (first ${credentialInventoryFailureListMax} by package id). A backfill apply refuses while any remain unless it lists every failed package in acknowledgedFailedPackageIds.`,
		),
})

const inputSchema = z.object({
	runId: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Inventory run to continue. Omit to start a new run. A complete run returns its report again.',
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(credentialInventoryScanLimitMax)
		.optional()
		.describe(
			`Saved packages to scan in this step (default ${credentialInventoryScanLimitDefault}, max ${credentialInventoryScanLimitMax}).`,
		),
})

const outputSchema = z.object({
	runId: z.string(),
	complete: z.boolean(),
	page: z.object({ scanned: count, unpublished: count, failed: count }),
	report: credentialInventoryReportSchema
		.nullable()
		.describe('Aggregate counts for the whole run, once it is complete.'),
})

export const adminCredentialInventoryScanCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		idempotent: true,
		name: 'adminCredentialInventoryScan',
		contextRuns: 'deny',
		description:
			'Fleet inventory of credential placeholders in published package source (ADR 0068). Changes no package or credential: it records, per package, which credential ids each placeholder can fill, where the placeholder sits on a request (a placeholder bound to a variable is followed to each read), and the declared slot providers. Never records credential names or values; placement detail keeps only package identifiers such as body fields and SDK option keys. Paged: call again with the returned runId until complete is true; the final call returns the report.',
		keywords: [
			'admin',
			'credential',
			'inventory',
			'placeholder',
			'scan',
			'fleet',
			'secret',
			'integration',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const admin = await resolveActingAdminPerson(ctx)
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminCredentialInventoryScan',
				async () => {
					const step = await runCredentialInventoryScanStep({
						env: ctx.env,
						baseUrl: ctx.callerContext.baseUrl,
						initiatedByUserId: admin.stableUserId,
						runId: args.runId,
						limit: args.limit,
					})
					const report = step.complete
						? (await getCredentialInventoryReport(ctx.env.APP_DB, step.runId))
								.report
						: null
					return { ...step, report }
				},
				{
					successReason: (result) =>
						`run=${result.runId};complete=${result.complete};scanned=${result.page.scanned};failed=${result.page.failed}`,
				},
			)
		},
	},
)
