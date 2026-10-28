import { z } from 'zod'
import { loadAdminUserByTarget } from '#worker/admin/users-data.ts'
import {
	inspectRunLogSqlBilling,
	runLogSqlBillingOps,
} from '#worker/run-records/service.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
	stableUserIdSchema,
} from './admin-shared.ts'

const sqlBillingOpSchema = z.enum(runLogSqlBillingOps)

const billingOpSchema = z.object({
	op: sqlBillingOpSchema,
	rowsRead: z.number().int().nonnegative(),
	rowsWritten: z.number().int().nonnegative(),
	calls: z.number().int().nonnegative(),
})

const indexInfoSchema = z.object({
	seq: z.number().int().nonnegative(),
	name: z.string(),
	unique: z.boolean(),
	origin: z.string(),
	partial: z.boolean(),
})

const columnInfoSchema = z.object({
	cid: z.number().int().nonnegative(),
	name: z.string(),
	type: z.string(),
	notnull: z.boolean(),
	dfltValue: z.string().nullable(),
	pk: z.number().int().nonnegative(),
})

const explainStepSchema = z.object({
	id: z.number().int(),
	parent: z.number().int(),
	detail: z.string(),
})

const inputSchema = z
	.object({
		stableUserId: stableUserIdSchema.optional(),
		email: z.string().email().optional().describe('Email address to look up.'),
		username: z.string().min(1).optional().describe('Username to look up.'),
	})
	.refine(
		(value) =>
			[value.stableUserId, value.email, value.username].filter(
				(item) => item !== undefined,
			).length === 1,
		{ message: 'Provide exactly one of stableUserId, email, or username.' },
	)

const reportSchema = z.object({
	stableUserId: stableUserIdSchema,
	username: z.string(),
	schemaVersion: z.number().int().nullable(),
	billing: z.object({
		databaseSize: z.number().int().nonnegative(),
		rowsReadTotal: z.number().int().nonnegative(),
		rowsWrittenTotal: z.number().int().nonnegative(),
		ops: z.array(billingOpSchema),
	}),
	runLogsIndexes: z.array(indexInfoSchema),
	runLogsColumns: z.array(columnInfoSchema),
	tableCounts: z.object({
		runs: z.number().int().nonnegative(),
		runLogs: z.number().int().nonnegative(),
		packageInvocationLedger: z.number().int().nonnegative(),
		workflowProjections: z.number().int().nonnegative(),
	}),
	runCount: z.object({
		meta: z.number().int().nonnegative().nullable(),
		actual: z.number().int().nonnegative(),
		matches: z.boolean(),
	}),
	explainRunLogsDeleteByRunId: z.array(explainStepSchema),
	explainRunLogsSelectByRunId: z.array(explainStepSchema),
})

const outputSchema = z.object({
	report: reportSchema.nullable(),
})

export const adminRunLogSqlBillingCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminRunLogSqlBilling',
		contextRuns: 'deny',
		description:
			'Read-only content-free RunLog SQLite billing and schema snapshot for one user: per-op rowsRead/rowsWritten, run_logs PRAGMA index_list/table_info, COUNT(*) for runs/run_logs/ledger/workflow_projections, EXPLAIN QUERY PLAN for run_id DELETE/SELECT, and run_count meta versus COUNT(*) FROM runs. Admin-only; never returns run rows, logs, or other user-authored content. Same as listRuns or getSqlBillingStats: the first RPC on an account that has never used RunLog instantiates that Durable Object and writes the empty schema. Prefer inspecting accounts that already have run history.',
		keywords: [
			'admin',
			'run log',
			'sqlite',
			'rows read',
			'billing',
			'schema',
			'index',
			'pragma',
			'explain',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminRunLogSqlBilling',
				async () => {
					const user = await loadAdminUserByTarget(ctx.env.APP_DB, args)
					if (!user) return { report: null }
					const inspection = await inspectRunLogSqlBilling({
						env: ctx.env,
						userId: user.stableUserId,
					})
					return {
						report: {
							stableUserId: user.stableUserId,
							username: user.username,
							...inspection,
						},
					}
				},
				{
					successReason: (result) =>
						result.report
							? `target_stable_user_id=${result.report.stableUserId}`
							: 'user_not_found',
				},
			)
		},
	},
)
