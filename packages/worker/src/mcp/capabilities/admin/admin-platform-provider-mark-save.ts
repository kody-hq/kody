import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { canonicalIntegrationName } from '#mcp/capabilities/integrations/integration-shared.ts'
import { base64ToBytes } from '@kody-internal/shared/base64.ts'
import {
	buildProviderMarkLogoPath,
	PlatformProviderMarkValidationError,
	setPlatformProviderMarkLogo,
	upsertPlatformProviderMark,
	type PlatformProviderMark,
} from '#worker/integrations/provider-marks.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

export const platformProviderMarkPublicSchema = z.object({
	slug: z.string().min(1),
	label: z.string().min(1),
	aliases: z.array(z.string()),
	logoPath: z.string().nullable(),
	createdAt: z.string().min(1),
	updatedAt: z.string().min(1),
})

export function toPlatformProviderMarkPublic(mark: PlatformProviderMark) {
	return {
		slug: mark.slug,
		label: mark.label,
		aliases: mark.aliases,
		logoPath: buildProviderMarkLogoPath(mark),
		createdAt: mark.createdAt,
		updatedAt: mark.updatedAt,
	}
}

const inputSchema = z
	.object({
		slug: z
			.string()
			.min(1)
			.describe(
				'Stable mark id (for example "google"). Family keys like google-youtube match this slug.',
			),
		label: z.string().min(1).optional(),
		aliases: z
			.array(z.string())
			.optional()
			.describe(
				'Extra provider keys and authorize hosts that should use this mark (accounts.google.com, twitter).',
			),
		logoBase64: z
			.string()
			.nullable()
			.optional()
			.describe(
				'Base64-encoded mark (SVG, PNG, JPEG, or WebP). Kody fits the image to 256px WebP before storage. Omit to keep the current mark, pass null to remove it.',
			),
	})
	.strict()

const outputSchema = z.object({
	mark: platformProviderMarkPublicSchema,
})

export const adminPlatformProviderMarkSaveCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminPlatformProviderMarkSave',
		contextRuns: 'deny',
		description:
			'Create or update an operator-owned provider brand mark used after an explicit upload and before auto-favicon on saved integrations and MCP servers. Admin-only.',
		keywords: [
			'admin',
			'platform',
			'provider',
			'mark',
			'logo',
			'icon',
			'favicon',
			'integration',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminPlatformProviderMarkSave',
				async () => {
					try {
						const slug = canonicalIntegrationName(args.slug)
						let logoBytes: Uint8Array | null | undefined
						if (args.logoBase64 !== undefined) {
							if (!ctx.env.COMMUNITY_ASSETS || !ctx.env.IMAGES) {
								throw new McpCallerError('Logo storage is not configured.')
							}
							if (args.logoBase64 === null) {
								logoBytes = null
							} else {
								try {
									logoBytes = base64ToBytes(args.logoBase64)
								} catch (error) {
									throw new McpCallerError('Logo file is not valid base64.', {
										cause: error,
									})
								}
							}
						}
						let mark = await upsertPlatformProviderMark({
							db: ctx.env.APP_DB,
							slug: args.slug,
							label: args.label,
							aliases: args.aliases,
						})
						if (logoBytes !== undefined) {
							mark = await setPlatformProviderMarkLogo({
								db: ctx.env.APP_DB,
								env: ctx.env,
								slug: mark.slug || slug,
								sourceBytes: logoBytes,
							})
						}
						return { mark: toPlatformProviderMarkPublic(mark) }
					} catch (error) {
						if (error instanceof PlatformProviderMarkValidationError) {
							throw new McpCallerError(error.message, { cause: error })
						}
						throw error
					}
				},
				{
					successReason: ({ mark }) => `platform_provider_mark=${mark.slug}`,
				},
			)
		},
	},
)
