import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { mintWebhookUrlForUser } from '#worker/webhooks/service.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	mintedWebhookHandleSchema,
	requirePackageRef,
	toMintedWebhookCapability,
	webhookPackageRefSchema,
} from './shared.ts'

export const webhookUrlMintCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhookUrlMint',
		contextRuns: 'deny',
		orgPermission: 'package:write',
		description:
			'Mint (or remint) the URL secret for a package-declared webhook and return an opaque handle plus url_host. Pass createInstance+instanceLabel to mint another URL under the same declared name (each URL needs its own Approve). The credential URL is never returned — register it with webhookUrlApply. Minting does not turn the webhook on: deliveries fail with enablement_not_on until a person opens approval_url and clicks Approve, which runs it as them (and is where its credentials are mapped). Existing approvals are kept across remint and rotate; after enablementDisable, Approve is required again.',
		keywords: ['webhook', 'mint', 'url', 'approve', 'handle', 'inbound'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z
			.object({
				...webhookPackageRefSchema,
				webhookName: z
					.string()
					.min(1)
					.describe('Webhook name from package.json#kody.webhooks[].name.'),
				createInstance: z
					.boolean()
					.optional()
					.describe(
						'When true, mint another URL under the same declared name. Requires instanceLabel.',
					),
				instanceLabel: z
					.string()
					.min(1)
					.max(64)
					.optional()
					.describe(
						'Short label to tell this URL apart from others under the same name.',
					),
			})
			.superRefine((input, ctx) => {
				try {
					requirePackageRef(input)
				} catch (error) {
					ctx.addIssue({
						code: 'custom',
						path: ['packageId'],
						message:
							error instanceof Error ? error.message : 'Invalid package ref.',
					})
				}
				if (input.createInstance && !input.instanceLabel?.trim()) {
					ctx.addIssue({
						code: 'custom',
						path: ['instanceLabel'],
						message: 'instanceLabel is required when createInstance is true.',
					})
				}
			}),
		outputSchema: z.object({
			webhook: mintedWebhookHandleSchema,
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const minted = await mintWebhookUrlForUser({
				env: ctx.env,
				request: requireMcpRequest(ctx.callerContext),
				userId: ownerIdFromCaller(ctx.callerContext),
				email: user.email,
				username: user.username,
				packageId: args.packageId,
				kodyId: args.kodyId,
				webhookName: args.webhookName,
				requestUrl: ctx.callerContext.baseUrl,
				createInstance: args.createInstance,
				instanceLabel: args.instanceLabel,
			})
			return { webhook: toMintedWebhookCapability(minted) }
		},
	},
)
