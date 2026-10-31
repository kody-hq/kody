import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { listWebhooksForUser } from '#worker/webhooks/service.ts'
import {
	packageIdLookupDescription,
	packageKodyIdOptionalCamelInput,
} from '#worker/package-registry/package-name.ts'
import { listedWebhookSchema, toListedWebhookCapability } from './shared.ts'

export const webhookListCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhookList',
		contextRuns: 'allow',
		orgPermission: 'package:read',
		description:
			"List package.json#kody.webhooks declarations across the signed-in user's saved packages, joined with minted handles and approval state. Declaring a webhook does not open ingress until webhookUrlMint is called; open approval_url and click Approve to turn it on, or use enablementDisable to turn it off. URL secrets and credential URLs are never returned.",
		keywords: [
			'webhook',
			'list',
			'package.json#kody.webhooks',
			'inbound',
			'manifest',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			packageId: z
				.string()
				.min(1)
				.optional()
				.describe(packageIdLookupDescription),
			kodyId: packageKodyIdOptionalCamelInput(),
		}),
		outputSchema: z.object({
			webhooks: z.array(listedWebhookSchema),
		}),
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const webhooks = await listWebhooksForUser({
				env: ctx.env,
				request: requireMcpRequest(ctx.callerContext),
				baseUrl: ctx.callerContext.baseUrl,
				userId: ownerIdFromCaller(ctx.callerContext),
				packageId: args.packageId,
				kodyId: args.kodyId,
			})
			return { webhooks: webhooks.map(toListedWebhookCapability) }
		},
	},
)
