import { authorizeOrgWide } from '#worker/authorization/authorize.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'

const workflowRunSchema = z.object({
	id: z.string(),
	source_type: z.enum(['package', 'inline']),
	package_id: z.string().nullable(),
	kody_id: z.string().nullable(),
	source_id: z.string().nullable(),
	workflow_name: z.string(),
	export_name: z.string().nullable(),
	idempotency_key: z.string(),
	run_at: z.string(),
	plan_date: z.string().nullable(),
	status: z
		.enum([
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
		.nullable(),
	created_at: z.string(),
	updated_at: z.string(),
	completed_at: z.string().nullable(),
	last_error: z.string().nullable(),
	enqueued_commit: z
		.string()
		.nullable()
		.describe(
			'Package workflows: the published commit resolved when the workflow was queued. Each attempt records the commit it actually ran as published_commit on its run (runList / runGet).',
		),
	source_revision: z
		.enum(['latest', 'pinned'])
		.nullable()
		.describe(
			'Package workflows: latest runs the published revision at each attempt start; pinned refuses to run if the package moved since enqueue. Null for inline workflows and package workflows queued before this was recorded.',
		),
})

export const workflowListCapability = defineDomainCapability(
	capabilityDomainNames.jobs,
	{
		name: 'workflowRunList',
		orgPermission: 'job:read',
		description:
			'List recent Cloudflare Workflow runs created through kody:runtime workflows.create for durable work that may outlive execute timeouts, including source, status, and completion/error metadata.',
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
		],
		readOnly: true,
		idempotent: true,
		destructive: false,
		inputSchema: z.object({
			limit: z
				.number()
				.int()
				.min(1)
				.max(100)
				.optional()
				.describe(
					'Maximum number of recent workflow runs to return. Defaults to 25.',
				),
		}),
		outputSchema: z.object({
			workflows: z.array(workflowRunSchema),
		}),
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			await authorizeOrgWide(
				{ env: ctx.env, request: requireMcpRequest(ctx.callerContext) },
				'job:read',
			)
			const { listWorkflowRunsForUser } =
				await import('#worker/package-runtime/package-workflows.ts')
			const workflows = await listWorkflowRunsForUser({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				limit: args.limit,
			})
			return {
				workflows: workflows.map((workflow) => ({
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
