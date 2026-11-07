import { authorizeOrgWide } from '#worker/authorization/authorize.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'

const workflowRunStatusSchema = z.enum([
	'queued',
	'running',
	'paused',
	'waiting',
	'waitingForPause',
	'unknown',
	'complete',
	'errored',
	'terminated',
	'cancelled',
])

const workflowRunSchema = z.object({
	id: z.string(),
	source_type: z
		.enum(['package', 'inline'])
		.describe(
			'How the run executes: package runs a saved package export; inline runs module code passed at create time (including durable handoffs such as packagePublishExternalPush).',
		),
	package_id: z
		.string()
		.nullable()
		.describe(
			'Saved package the run belongs to: the exported package for package runs, or the package an inline run was launched for (for example a durable publish). Null for inline runs with no package.',
		),
	kody_id: z.string().nullable(),
	source_id: z
		.string()
		.nullable()
		.describe(
			'Package source the run belongs to, alongside package_id. Null when package_id is null.',
		),
	workflow_name: z.string(),
	export_name: z.string().nullable(),
	idempotency_key: z
		.string()
		.describe(
			'Opaque dedupe key. Its format is internal, varies by operation and version, and is replaced when a failed run releases it; do not parse it. Use package_id, source_id and enqueued_commit for provenance.',
		),
	run_at: z.string(),
	plan_date: z.string().nullable(),
	status: workflowRunStatusSchema.nullable(),
	created_at: z.string(),
	updated_at: z.string(),
	completed_at: z.string().nullable(),
	last_error: z.string().nullable(),
	enqueued_commit: z
		.string()
		.nullable()
		.describe(
			'Package workflows: the published commit resolved when the workflow was queued. Each attempt records the commit it actually ran as published_commit on its run (runList / runGet). Package-launched inline runs (such as packagePublishExternalPush): the commit the operation targets. Null when unknown.',
		),
	source_revision: z
		.enum(['latest', 'pinned'])
		.nullable()
		.describe(
			'Package workflows: latest runs the published revision at each attempt start; pinned refuses to run if the package moved since enqueue. Null for inline workflows and package workflows queued before this was recorded.',
		),
})

const workflowRunListInputKeys = [
	'workflow_id',
	'status',
	'package_id',
	'since',
	'limit',
	'cursor',
] as const

const workflowRunListInputKeySet = new Set<string>(workflowRunListInputKeys)

function camelToSnakeCaseKey(key: string) {
	return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

function unknownWorkflowRunListKeyMessage(key: string) {
	const snake = camelToSnakeCaseKey(key)
	if (snake !== key && workflowRunListInputKeySet.has(snake)) {
		return `${key} is not a parameter; did you mean ${snake}?`
	}
	return `${key} is not a parameter`
}

/** Exported for schema-level tests; keep snake_case keys strict for callers. */
export const workflowRunListInputSchema = z
	.object(
		{
			workflow_id: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Optional exact workflow run id (dynwf-… or pkgwf-…) from workflows.create or a dispatched durable handoff. Returns that run alone when present.',
				),
			status: workflowRunStatusSchema
				.optional()
				.describe(
					'Optional workflow-level status filter such as queued, running, complete, or errored.',
				),
			package_id: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Optional saved package id: lists runs of its exports and inline runs launched for it (such as packagePublishExternalPush).',
				),
			since: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Optional ISO 8601 lower bound on created_at (inclusive), for example 2026-07-01T00:00:00.000Z.',
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe(
					'Maximum number of recent workflow runs to return per page. Defaults to 25.',
				),
			cursor: z
				.string()
				.min(1)
				.optional()
				.describe(
					'Opaque pagination cursor from a previous next_cursor value. Keep the same filters across pages.',
				),
		},
		{
			error: (issue) => {
				if (issue.code !== 'unrecognized_keys') return undefined
				return {
					message: issue.keys.map(unknownWorkflowRunListKeyMessage).join(' '),
				}
			},
		},
	)
	.strict()

/** Exported for schema-level tests. */
export const workflowRunListOutputSchema = z.object({
	workflows: z.array(workflowRunSchema),
	next_cursor: z
		.string()
		.nullable()
		.describe(
			'Opaque cursor for the next page, or null when this is the last page.',
		),
})

export const workflowListCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'workflowRunList',
		contextRuns: 'allow',
		orgPermission: 'job:read',
		description:
			'List recent Cloudflare Workflow runs created through kody:runtime workflows.create for durable work that may outlive execute timeouts, including source, status, and completion/error metadata. Newest first; filter with workflow_id (exact id), status, package_id, and/or since, and pass next_cursor back as cursor for older pages. Unknown input fields are rejected.',
		keywords: [
			'workflow',
			'workflows',
			'list',
			'inspect',
			'debug',
			'status',
			'background',
			'timeout',
			'migration',
			'poll',
			'dispatched',
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: workflowRunListInputSchema,
		outputSchema: workflowRunListOutputSchema,
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			await authorizeOrgWide(
				{ env: ctx.env, request: requireMcpRequest(ctx.callerContext) },
				'job:read',
			)
			const { listWorkflowRunPageForUser } =
				await import('#worker/package-runtime/package-workflows.ts')
			const page = await listWorkflowRunPageForUser({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				limit: args.limit,
				cursor: args.cursor ?? null,
				filter: {
					workflowId: args.workflow_id ?? null,
					status: args.status ?? null,
					packageId: args.package_id ?? null,
					since: args.since ?? null,
				},
			})
			return {
				next_cursor: page.nextCursor,
				workflows: page.workflows.map((workflow) => ({
					id: workflow.id,
					source_type: workflow.sourceType,
					package_id: workflow.packageId,
					kody_id: workflow.kodyId,
					source_id: workflow.sourceId,
					workflow_name: workflow.workflowName,
					export_name: workflow.exportName,
					idempotency_key: workflow.idempotencyKey,
					run_at: workflow.runAt,
					plan_date: workflow.planDate,
					status: workflow.status,
					created_at: workflow.createdAt,
					updated_at: workflow.updatedAt,
					completed_at: workflow.completedAt,
					last_error: workflow.lastError,
					enqueued_commit: workflow.enqueuedCommit,
					source_revision: workflow.sourceRevision,
				})),
			}
		},
	},
)
