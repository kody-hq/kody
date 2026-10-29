import {
	authorizeOrgWide,
	listScopeIncludes,
	loadResourceListScope,
} from '#worker/authorization/authorize.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { getRunRecord } from '#worker/run-records/service.ts'
import { findStartedContextRun } from '#worker/execution-contexts/service.ts'
import {
	formatRunRecord,
	formatRunRecordLog,
	runRecordLogSchema,
	runRecordSchema,
} from './shared.ts'

const inputSchema = z.object({
	run_id: z
		.string()
		.min(1)
		.describe(
			'Run id from runList, jobGet recent_runs, or another run reference.',
		),
})

const outputSchema = z.object({
	run: runRecordSchema,
	logs: z.array(runRecordLogSchema),
})

export const runGetCapability = defineDomainCapability(
	capabilityDomainNames.runs,
	{
		name: 'runGet',
		contextRuns: 'allow',
		orgPermission: 'job:read',
		description:
			'Load one retained run with its captured log lines, error details, soft triage fields (error_triage / note / who / when), and (when available) a bounded metadata.result snapshot of the handler return value — useful for webhook deliveries, package exports, execute runs, and workflow runs. Works for ignored/resolved runs too. Records are retained about 30 days, capped per user, and pruned failure-last. Runs that started on an execution context stay findable from execution context history for 30 days (outcome, failure reason, error summary, no logs) after the full record is pruned.',
		keywords: [
			'run',
			'logs',
			'debug',
			'failure',
			'error',
			'crash',
			'trace',
			'stack',
			'why did it fail',
			'ignored',
			'resolved',
			'triage',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			const request = ctx.callerContext.request
			const result =
				(await getRunRecord({
					env: ctx.env,
					userId: ownerIdFromCaller(ctx.callerContext),
					runId: args.run_id,
				})) ??
				(request?.actor
					? await findStartedContextRun(ctx.env, {
							orgId: request.org.id,
							userId: request.actor.userId,
							runId: args.run_id,
						}).then((run) => (run ? { run, logs: [] } : null))
					: null)
			if (!result) {
				throw new McpCallerError(`Run "${args.run_id}" was not found.`)
			}
			const auth = {
				env: ctx.env,
				request: requireMcpRequest(ctx.callerContext),
			}
			const scope = await loadResourceListScope(auth, 'job:read', 'job')
			const jobId = result.run.jobId
			if (!jobId || !listScopeIncludes(scope, jobId)) {
				await authorizeOrgWide(auth, 'job:read')
			}
			return {
				run: formatRunRecord(result.run),
				logs: result.logs.map(formatRunRecordLog),
			}
		},
	},
)
