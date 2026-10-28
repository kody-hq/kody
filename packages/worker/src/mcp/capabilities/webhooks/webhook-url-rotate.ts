import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { rotateWebhookUrlForUser } from '#worker/webhooks/service.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import {
	mintedWebhookHandleSchema,
	requirePackageRef,
	toMintedWebhookCapability,
	webhookPackageRefSchema,
} from './shared.ts'

export const webhookUrlRotateCapability = defineDomainCapability(
	capabilityDomainNames.webhooks,
	{
		name: 'webhookUrlRotate',
		contextRuns: 'deny',
		orgPermission: 'package:write',
		description:
			'Rotate the URL secret for a minted package webhook and return a new opaque handle without changing its on/off state. The previous URL stays active for 24 hours, or until the first accepted delivery arrives on the new URL. Register the new URL with webhookUrlApply — the credential is never returned.',
		keywords: ['webhook', 'rotate', 'secret', 'handle', 'url'],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z
			.object({
				...webhookPackageRefSchema,
				webhookName: z.string().min(1),
				endpointId: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Minted endpoint to rotate. Required when several URLs share the webhook name.',
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
			}),
		outputSchema: z.object({
			webhook: mintedWebhookHandleSchema,
		}),
		async handler(args, ctx) {
			const user = requireMcpUser(ctx.callerContext)
			const rotated = await rotateWebhookUrlForUser({
				env: ctx.env,
				request: requireMcpRequest(ctx.callerContext),
				userId: ownerIdFromCaller(ctx.callerContext),
				email: user.email,
				username: user.username,
				packageId: args.packageId,
				kodyId: args.kodyId,
				webhookName: args.webhookName,
				endpointId: args.endpointId,
				requestUrl: ctx.callerContext.baseUrl,
			})
			return { webhook: toMintedWebhookCapability(rotated) }
		},
	},
)
