import { orgAuditCauseFromCaller } from '#worker/orgs/org-audit.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { enableTriggerWithJobForCaller } from '#worker/enablements/service.ts'
import {
	packageIdLookupDescription,
	packageKodyIdOptionalCamelInput,
} from '#worker/package-registry/package-name.ts'
import {
	enablementSchema,
	enablementTriggerKindSchema,
	toEnablementOutput,
} from './enablement-shared.ts'

const enablementJobSchema = z.object({
	job_id: z.string(),
	state: z
		.enum(['armed', 'already_on', 'left_off', 'expired', 'missing'])
		.describe(
			'armed: the job was off and is now on and scheduled from now. already_on: it was already on. left_off: it is still off because you lack job:write. expired: it passed its expiry time. missing: the job was not found.',
		),
	missing_permission: z
		.literal('job:write')
		.nullable()
		.describe('The permission you need for the job to turn on, if any.'),
	message: z
		.string()
		.nullable()
		.describe('Plain-language explanation when the job did not turn on.'),
})

export const enablementEnableCapability = defineDomainCapability(
	capabilityDomainNames.packages,
	{
		name: 'enablementEnable',
		contextRuns: 'deny',
		orgPermission: 'package:execute',
		description:
			'Turn a package cron job or subscription topic on for yourself. A webhook is different: turn it on only by Approve at the approval URL (webhookUrlMint or credentialMappingPropose returns it), including after it was turned off with enablementDisable. This capability refuses to turn a webhook on directly and only returns an existing live enablement. email.message.received and email.message.quarantined are refused here too: those run only for a sender, so a person Approves them from the inbox (the approval link includes sender_kind and sender_value). Every run then acts as you: your access, your credentials, billed and audited to you. Publishing never turns a trigger on, and nobody can enable one for someone else. Needs package:execute on the package. For a cron job that is itself off, this also turns the job on and schedules its next run from now when you hold job:write (what jobUpdate needs); without it the job stays off until someone with job:write turns it on, and the result job field says so (state left_off, missing_permission job:write, and how to get it). If you lose access later, the enablement pauses and resumes by itself once access is back.',
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
				kodyId: packageKodyIdOptionalCamelInput(),
				triggerKind: enablementTriggerKindSchema,
				triggerName: z
					.string()
					.min(1)
					.describe('Job name, subscription topic, or webhook name.'),
			})
			.refine((input) => Boolean(input.packageId ?? input.kodyId), {
				message: 'Provide packageId or leftover kodyId. Prefer packageId.',
				path: ['packageId'],
			}),
		outputSchema: z.object({
			enablement: enablementSchema,
			job: enablementJobSchema
				.nullable()
				.describe(
					'For a cron enablement, what happened to its job. Null for other triggers.',
				),
		}),
		async handler(args, ctx) {
			const { enablement, job } = await enableTriggerWithJobForCaller({
				env: ctx.env,
				baseUrl: ctx.callerContext.baseUrl,
				request: requireMcpRequest(ctx.callerContext),
				packageIdOrKodyId: args.packageId ?? args.kodyId ?? '',
				kind: args.triggerKind,
				name: args.triggerName,
				cause: orgAuditCauseFromCaller(ctx.callerContext),
			})
			return {
				enablement: toEnablementOutput(enablement),
				job: job
					? {
							job_id: job.jobId,
							state: job.state,
							missing_permission: job.missingPermission,
							message: job.message,
						}
					: null,
			}
		},
	},
)
