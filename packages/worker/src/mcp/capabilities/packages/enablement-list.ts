import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { listEnablementsForCaller } from '#worker/enablements/service.ts'
import { enablementSchema, toEnablementOutput } from './enablement-shared.ts'

export const enablementListCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'enablementList',
		contextRuns: 'allow',
		orgPermission: 'org:read',
		description:
			'List your enablements: the cron jobs, subscriptions, and webhooks that run as you, with paused ones and why they paused. An Owner can pass scope "org" to list everyone\'s.',
		keywords: [
			'enablement',
			'enablements',
			'triggers',
			'paused',
			'running as me',
			'cron',
			'subscription',
			'webhook',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			scope: z
				.enum(['mine', 'org'])
				.optional()
				.describe('mine (default) or org (Owners only).'),
			includeOff: z
				.boolean()
				.optional()
				.describe('Include enablements that were turned off.'),
		}),
		outputSchema: z.object({
			enablements: z.array(enablementSchema),
		}),
		async handler(args, ctx) {
			const request = requireMcpRequest(ctx.callerContext)
			const enablements = await listEnablementsForCaller({
				env: ctx.env,
				request,
				scope: args.scope ?? 'mine',
				includeOff: args.includeOff ?? false,
			})
			return {
				enablements: enablements.map(toEnablementOutput),
			}
		},
	},
)
