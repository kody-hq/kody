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
import { listRunRecords } from '#worker/run-records/service.ts'
import {
	formatRunRecord,
	runErrorTriageFilterSchema,
	runListLimitSchema,
	runRecordSchema,
	runStatusSchema,
	runSurfaceSchema,
} from './shared.ts'

const runListInputKeys = [
	'surface',
	'status',
	'package_id',
	'job_id',
	'workflow_id',
	'since',
	'error_triage',
	'started_by',
	'execution_context_id',
	'limit',
	'cursor',
] as const

const runListInputKeySet = new Set<string>(runListInputKeys)

function camelToSnakeCaseKey(key: string) {
	return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

function unknownRunListKeyMessage(key: string) {
	const snake = camelToSnakeCaseKey(key)
	if (snake !== key && runListInputKeySet.has(snake)) {
		return `${key} is not a parameter; did you mean ${snake}?`
	}
	return `${key} is not a parameter`
}

/** Exported for schema-level tests; keep snake_case keys strict for callers. */
export const runListInputSchema = z
	.object(
		{
			surface: runSurfaceSchema
				.optional()
				.describe(
					'Optional runtime surface filter such as job, webhook, execute, app_fetch, or workflow.',
				),
			status: runStatusSchema
				.optional()
				.describe('Optional status filter: running, success, or error.'),
			package_id: z
				.string()
				.min(1)
				.optional()
				.describe('Optional saved package id to scope package-owned runs.'),
			job_id: z
				.string()
				.min(1)
				.optional()
				.describe('Optional job id to list runs for one scheduled job.'),
			workflow_id: z
				.string()
				.min(1)
				.optional()
				.describe(
					"Optional workflow run id (dynwf-… or pkgwf-…) from workflows.create. Returns that workflow's run, whose metadata.result holds the return value once it succeeds.",
				),
			since: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Optional ISO 8601 lower bound on started_at (inclusive), for example 2026-07-01T00:00:00.000Z.',
				),
			error_triage: runErrorTriageFilterSchema
				.optional()
				.describe(
					'Soft error-triage filter. Defaults to open (hides ignored/resolved noise). Use ignored, resolved, or all to inspect triaged runs.',
				),
			started_by: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Optional exact match on the started-by person id (the actor who started the run or owns the enablement).',
				),
			execution_context_id: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Optional exact match on the execution context (ec_...) a run ran on or tried before falling back.',
				),
			limit: runListLimitSchema,
			cursor: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Opaque pagination cursor from a previous next_cursor value.',
				),
		},
		{
			error: (issue) => {
				if (issue.code !== 'unrecognized_keys') return undefined
				return {
					message: issue.keys.map(unknownRunListKeyMessage).join(' '),
				}
			},
		},
	)
	.strict()

const inputSchema = runListInputSchema

const outputSchema = z.object({
	runs: z.array(runRecordSchema),
	next_cursor: z
		.string()
		.nullable()
		.describe(
			'Opaque cursor for the next page, or null when this is the last page.',
		),
})

export const runListCapability = defineDomainCapability(
	capabilityDomainNames.runs,
	{
		name: 'runList',
		contextRuns: 'allow',
		orgPermission: 'job:read',
		description:
			'List recent execution history across jobs, webhooks, package apps, workflows, ad-hoc execute, and other runtimes so you can debug failures or inspect what ran. Ad-hoc execute runs are included for both success and error. Terminal rows may include a bounded metadata.result snapshot. By default, ignored/resolved error runs are hidden (error_triage defaults to open); use runUpdate or runUpdateBulk to triage noise, or pass error_triage all/ignored/resolved to inspect those rows. Pass status success (or omit status with error_triage all) for a recent "what ran" list. Records are retained about 30 days, capped per user, and cap-pruned in this order: handled errors, successes, then open errors.',
		keywords: [
			'run',
			'runs',
			'history',
			'logs',
			'debug',
			'failure',
			'failures',
			'error',
			'errors',
			'success',
			'recent',
			'what ran',
			'crash',
			'job failed',
			'scheduled job',
			'package app',
			'observability',
			'trace',
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
			const auth = {
				env: ctx.env,
				request: requireMcpRequest(ctx.callerContext),
			}
			const scope = await loadResourceListScope(auth, 'job:read', 'job')
			// A job grant covers that job's runs, never the org's run history.
			if (!args.job_id || !listScopeIncludes(scope, args.job_id)) {
				await authorizeOrgWide(auth, 'job:read')
			}
			const page = await listRunRecords({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				filter: {
					surface: args.surface ?? null,
					status: args.status ?? null,
					packageId: args.package_id ?? null,
					jobId: args.job_id ?? null,
					workflowId: args.workflow_id ?? null,
					since: args.since ?? null,
					errorTriage: args.error_triage ?? 'open',
					startedByUserId: args.started_by ?? null,
					executionContextId: args.execution_context_id ?? null,
				},
				limit: args.limit ?? null,
				cursor: args.cursor ?? null,
			})
			return {
				runs: page.runs.map(formatRunRecord),
				next_cursor: page.nextCursor,
			}
		},
	},
)
