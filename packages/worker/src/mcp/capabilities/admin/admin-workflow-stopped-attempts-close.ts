import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	closeStoppedWorkflowAttemptRuns,
	listRunRecords,
} from '#worker/run-records/service.ts'
import {
	adminMutationCapabilityAccess,
	adminStableOwnerId,
	auditAdminCapabilityInvocation,
	stableUserIdSchema,
} from './admin-shared.ts'

export const adminWorkflowStoppedAttemptsCloseCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminMutationCapabilityAccess,
		name: 'adminWorkflowStoppedAttemptsClose',
		contextRuns: 'deny',
		description:
			"List, then close, the run rows one finished durable workflow instance left `running` because a step attempt was killed before its finish write. Closed rows become `error` (`workflow_attempt_stopped`), ignored when the workflow completed, and send no alerts. Scoped to one org's RunLog and one workflow id; `dry_run` (default true) only lists them. Admin-only.",
		keywords: ['admin', 'workflow', 'run', 'running', 'stuck', 'attempt'],
		inputSchema: z.object({
			stable_user_id: stableUserIdSchema.describe(
				'Org (RunLog owner) that ran the workflow.',
			),
			workflow_id: z.string().min(1),
			outcome: z
				.enum(['succeeded', 'failed'])
				.describe('How the workflow instance ended.'),
			dry_run: z.boolean().default(true),
			reason: z.string().min(10),
		}),
		outputSchema: z.object({
			running_run_ids: z.array(z.string()),
			closed_run_ids: z.array(z.string()),
		}),
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminWorkflowStoppedAttemptsClose',
				async () => {
					const userId = adminStableOwnerId(args.stable_user_id)
					const page = await listRunRecords({
						env: ctx.env,
						userId,
						filter: {
							surface: 'workflow',
							status: 'running',
							workflowId: args.workflow_id,
						},
						limit: 100,
					})
					const running = page.runs.map((run) => run.id)
					if (args.dry_run || running.length === 0) {
						return { running_run_ids: running, closed_run_ids: [] }
					}
					const closed = await closeStoppedWorkflowAttemptRuns({
						env: ctx.env,
						userId,
						workflowId: args.workflow_id,
						// A finished instance: every attempt that will ever run has run.
						outcome: args.outcome === 'failed' ? 'failed' : 'succeeded',
					})
					return { running_run_ids: running, closed_run_ids: closed }
				},
				{
					successReason: () =>
						`target=${args.stable_user_id};workflow=${args.workflow_id};dry_run=${args.dry_run};reason=${args.reason}`,
				},
			)
		},
	})
