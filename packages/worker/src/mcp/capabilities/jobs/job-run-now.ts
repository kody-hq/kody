import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	type JobRunNowCapabilityInput,
	jobRunNowInputSchema,
	jobRunNowOutputSchema,
	runJobNowFromArgs,
} from './shared.ts'

export const jobRunNowCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'jobRunNow',
		contextRuns: 'deny',
		orgPermission: 'job:execute',
		description:
			'Run an existing scheduled job immediately by id using the normal job runtime, then return the updated job state and execution result for debugging. Recurring schedules belong on a package (`kody.jobs`); deferred one-shots use `workflows.create`.',
		keywords: [
			'job',
			'run',
			'run now',
			'immediate',
			'manual',
			'execute',
			'debug',
			'backfill',
			'trigger',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: jobRunNowInputSchema,
		outputSchema: jobRunNowOutputSchema,
		async handler(args: JobRunNowCapabilityInput, ctx) {
			return runJobNowFromArgs({
				env: ctx.env,
				callerContext: ctx.callerContext,
				args,
			})
		},
	},
)
