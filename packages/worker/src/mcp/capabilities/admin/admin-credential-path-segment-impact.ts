import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { analyzeCredentialPathSegmentImpact } from '#worker/credentials/credential-path-segment-impact.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminPerson,
} from './admin-shared.ts'

const inputSchema = z.object({
	runId: z
		.string()
		.min(1)
		.describe(
			'Complete credential inventory run id from adminCredentialInventoryScan.',
		),
})

const packageSchema = z.object({
	packageId: z.string(),
	ownerId: z.string(),
	ownerHandle: z.string().nullable(),
	packageName: z.string().nullable(),
	kodyId: z.string().nullable(),
	credentialNames: z
		.array(z.string())
		.describe('Credential names only; never values.'),
})

const outputSchema = z.object({
	runId: z.string(),
	pathReferences: z.number().int().nonnegative(),
	packagesWithPathPlacement: z.number().int().nonnegative(),
	packagesWithRoutingChars: z.number().int().nonnegative(),
	credentialsWithRoutingChars: z.number().int().nonnegative(),
	undecryptableCredentials: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'Path credentials that could not be decrypted; excluded from routing-char counts.',
		),
	packages: z
		.array(packageSchema)
		.describe(
			'Affected packages for private outreach decisions. Do not paste into public PR/issue/commit text; prefer counts.',
		),
})

export const adminCredentialPathSegmentImpactCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminCapabilityAccess,
		name: 'adminCredentialPathSegmentImpact',
		contextRuns: 'deny',
		description:
			'Read-only impact of path-segment credential encoding: from a complete adminCredentialInventoryScan run, count packages that fill a Key into a URL path where the stored value contains /, ?, or #. Decrypts only to test those characters; never returns values. Never emails or notifies owners. Admin-only; use counts in public text.',
		keywords: [
			'admin',
			'credential',
			'inventory',
			'path',
			'segment',
			'encoding',
			'impact',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			await resolveActingAdminPerson(ctx)
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminCredentialPathSegmentImpact',
				async () =>
					await analyzeCredentialPathSegmentImpact({
						env: ctx.env,
						runId: args.runId,
					}),
				{
					successReason: (result) =>
						`run=${result.runId};pathRefs=${result.pathReferences};packagesPath=${result.packagesWithPathPlacement};packagesRouting=${result.packagesWithRoutingChars}`,
				},
			)
		},
	})
