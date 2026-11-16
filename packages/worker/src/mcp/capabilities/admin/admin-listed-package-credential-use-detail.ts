import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { runListedPackageCredentialUseDetail } from '#worker/credentials/listed-package-credential-use-detail.ts'
import { listedPackageFetchBindingScanBundlesPerCall } from '#worker/credentials/listed-package-fetch-binding-scan.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const count = z.number().int().nonnegative()

const inputSchema = z.object({
	packageId: z.string().min(1).describe('Saved package id.'),
	offset: z
		.number()
		.int()
		.min(0)
		.optional()
		.describe('nextOffset from the previous call.'),
	bundlesPerCall: z
		.number()
		.int()
		.min(1)
		.max(listedPackageFetchBindingScanBundlesPerCall)
		.optional()
		.describe(
			`Stored bundles to read this call (default and max ${listedPackageFetchBindingScanBundlesPerCall}).`,
		),
})

const outputSchema = z.object({
	packageId: z.string(),
	found: z.boolean(),
	credentials: z
		.array(
			z.object({
				credentialId: z.string(),
				ownerIsPackageOwner: z.boolean(),
				mappedNeeds: count.describe(
					'Saved credential mappings of this package that point at the credential.',
				),
			}),
		)
		.describe('Credentials whose allowed packages list names this package.'),
	bundles: count,
	bundlesWithDirectRead: count.describe(
		'Bundles with a globalThis.fetch or self.fetch read.',
	),
	directReadBundles: z
		.object({
			withLockedCredentialPlaceholder: count,
			lockedCredentialPlaceholders: count,
			withAnyPlaceholder: count,
			anyPlaceholders: count,
			withCredentialClientCall: count,
			credentialClientCalls: count,
		})
		.describe(
			'Counted only in the bundles with such a read: secret placeholders that name a listed credential, placeholders of any name, and credential client calls.',
		),
	nextOffset: z.number().int().nullable(),
})

export const adminListedPackageCredentialUseDetailCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminCapabilityAccess,
		name: 'adminListedPackageCredentialUseDetail',
		contextRuns: 'deny',
		description:
			"Read-only detail for one package on a credential's allowed packages list: which credentials list it and whether each has the same owner as the package, and, in the stored bundles that read fetch through the global object, how many refer to a listed credential by placeholder, to any credential by placeholder, or call a credential client. Counts and booleans only: no source text, names or values. Writes nothing. Resume with nextOffset until null and add the counts.",
		keywords: ['admin', 'credential', 'allowed packages', 'bundle', 'fetch'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminListedPackageCredentialUseDetail',
				async () =>
					await runListedPackageCredentialUseDetail({
						env: ctx.env,
						packageId: args.packageId,
						offset: args.offset,
						bundlesPerCall: args.bundlesPerCall,
					}),
				{
					successReason: (result) =>
						`found=${result.found};done=${result.nextOffset === null}`,
				},
			)
		},
	})
