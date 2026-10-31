import { loadResourceListScope } from '#worker/authorization/authorize.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { resolveCronJobEnablementHint } from '#worker/enablements/job-enablement-hint.ts'
import { getJobInspection } from '#worker/jobs/inspect.ts'
import { listRunRecords } from '#worker/run-records/service.ts'
import {
	buildJobInspectionOutput,
	buildJobManagerDebugOutput,
	buildJobSourceInspectionOutput,
	formatJobRecentRunFromRecord,
	jobGetInputSchema,
	jobGetOutputSchema,
	authorizeJob,
	resolveJobGetId,
} from './shared.ts'

export const jobGetCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'jobGet',
		contextRuns: 'allow',
		orgPermission: 'job:read',
		description:
			'Load one existing scheduled job for the signed-in user, including debugging fields such as run counters, last error, recent run history from run records (with run ids for runGet log drill-down), current alarm state, and optionally the published source code. Recurring schedules belong on a package (`kody.jobs`); deferred one-shots use `workflows.create`.',
		keywords: [
			'job',
			'inspect',
			'debug',
			'status',
			'scheduled job',
			'source code',
			'recent runs',
			'logs',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: jobGetInputSchema,
		outputSchema: jobGetOutputSchema,
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const jobId = resolveJobGetId(args)
			await authorizeJob({
				env: ctx.env,
				callerContext: ctx.callerContext,
				permission: 'job:read',
				jobId,
			})
			const [inspection, scope] = await Promise.all([
				getJobInspection({
					env: ctx.env,
					userId: ownerIdFromCaller(ctx.callerContext),
					jobId,
					includeCode: args.includeCode ?? false,
				}),
				loadResourceListScope(
					{ env: ctx.env, request: requireMcpRequest(ctx.callerContext) },
					'job:read',
					'job',
				),
			])
			const recentPage = await listRunRecords({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				filter: { jobId, surface: 'job' },
				limit: 10,
			})
			const recentRuns = recentPage.runs.flatMap((run) => {
				const formatted = formatJobRecentRunFromRecord(run)
				return formatted ? [formatted] : []
			})
			const enablementHint = await resolveCronJobEnablementHint({
				env: ctx.env,
				orgId: ownerIdFromCaller(ctx.callerContext),
				jobId: inspection.job.id,
				jobName: inspection.job.name,
				enabled: inspection.job.enabled,
			})
			return {
				job: buildJobInspectionOutput(inspection.job, {
					recentRuns,
					enablementHint,
				}),
				alarm: buildJobManagerDebugOutput(inspection.alarm, scope),
				...(inspection.source
					? { source: buildJobSourceInspectionOutput(inspection.source) }
					: {}),
			}
		},
	},
)
