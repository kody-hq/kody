import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	type JobUpdateCapabilityInput,
	jobUpdateInputSchema,
	jobViewOutputSchema,
	updateJobFromArgs,
} from './shared.ts'

export const jobUpdateCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'jobUpdate',
		contextRuns: 'allow',
		orgPermission: 'job:write',
		description:
			'Update metadata on an existing scheduled job: enabled, kill switch, expires_at, params, schedule, and timezone. Package-owned jobs keep source in the package repo, so name, code, and published source cannot change here — edit the package and publish. Recurring schedules belong on a package (`kody.jobs`); deferred one-shots use `workflows.create`.',
		keywords: [
			'job',
			'update',
			'edit',
			'reschedule',
			'rename',
			'enable',
			'disable',
			'kill switch',
			'timezone',
			'expires',
			'expiry',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: jobUpdateInputSchema,
		outputSchema: jobViewOutputSchema,
		async handler(args: JobUpdateCapabilityInput, ctx) {
			return updateJobFromArgs({
				env: ctx.env,
				callerContext: ctx.callerContext,
				args,
			})
		},
	},
)
