import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { enableTriggerForCaller } from '#worker/enablements/service.ts'
import {
	packageIdLookupDescription,
	packageNameLookupDescription,
} from '#worker/package-registry/package-name.ts'
import {
	enablementSchema,
	enablementTriggerKindSchema,
	toEnablementOutput,
} from './enablement-shared.ts'

export const enablementEnableCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'enablementEnable',
		orgPermission: 'package:execute',
		description:
			'Turn a package cron job or subscription topic on for yourself. A webhook is different: its first turn-on needs a person to Approve it at the approval URL (webhookUrlMint or credentialMappingPropose returns it), so this refuses a webhook that is not already on, and only returns an existing enablement. email.message.received and email.message.quarantined are refused here too: those run only for a sender, so a person Approves them from the inbox (the approval link includes sender_kind and sender_value). Every run then acts as you: your access, your credentials, billed and audited to you. Publishing never turns a trigger on, and nobody can enable one for someone else. Needs package:execute on the package. For a cron job that is itself off, this also turns the job on and schedules its next run from now when you hold job:write (what jobUpdate needs); without it the job stays off until someone with job:write turns it on. If you lose access later, the enablement pauses and resumes by itself once access is back.',
		keywords: [
			'enable',
			'enablement',
			'turn on',
			'trigger',
			'cron',
			'job',
			'subscription',
			'webhook',
			'run as me',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z
			.object({
				packageId: z
					.string()
					.min(1)
					.optional()
					.describe(packageIdLookupDescription),
				kodyId: z
					.string()
					.min(1)
					.optional()
					.describe(packageNameLookupDescription),
				triggerKind: enablementTriggerKindSchema,
				triggerName: z
					.string()
					.min(1)
					.describe('Job name, subscription topic, or webhook name.'),
			})
			.refine((input) => Boolean(input.packageId ?? input.kodyId), {
				message: 'Provide packageId or kodyId.',
				path: ['packageId'],
			}),
		outputSchema: z.object({ enablement: enablementSchema }),
		async handler(args, ctx) {
			const enablement = await enableTriggerForCaller({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				request: requireMcpRequest(ctx.callerContext),
				packageIdOrKodyId: args.packageId ?? args.kodyId ?? '',
				kind: args.triggerKind,
				name: args.triggerName,
			})
			return { enablement: toEnablementOutput(enablement) }
		},
	},
)
