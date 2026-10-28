import { authorizeOrgWide } from '#worker/authorization/authorize.ts'
import { ownerIdFromCaller } from '#worker/request-context/owner-id.ts'
import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	requireMcpRequest,
	requireMcpUser,
} from '#mcp/capabilities/meta/require-user.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { bulkUpdateRunErrorTriage } from '#worker/run-records/service.ts'
import {
	runErrorTriageFilterSchema,
	runErrorTriageUpdateSchema,
	runListLimitSchema,
	runSurfaceSchema,
	runTriageNoteSchema,
} from './shared.ts'

const exactFilterSchema = z
	.object({
		surface: runSurfaceSchema.optional(),
		package_id: z.string().min(1).optional(),
		job_id: z.string().min(1).optional(),
		name: z.string().min(1).optional(),
		error_name: z.string().min(1).optional(),
		error_message: z.string().min(1).optional(),
		error_triage: runErrorTriageFilterSchema.optional(),
	})
	.refine(
		(filter) =>
			filter.surface != null ||
			filter.package_id != null ||
			filter.job_id != null ||
			filter.name != null ||
			filter.error_name != null ||
			filter.error_message != null,
		{
			message:
				'filter must include surface, package_id, job_id, name, error_name, or error_message',
		},
	)

const inputSchema = z
	.object({
		run_ids: z
			.array(z.string().min(1))
			.min(1)
			.max(100)
			.optional()
			.describe('Explicit retained run ids to triage (max 100).'),
		filter: exactFilterSchema
			.optional()
			.describe(
				'Exact-match selector for retained error runs. At least one identity or error field is required. error_triage defaults to open when resolving/ignoring.',
			),
		triage: runErrorTriageUpdateSchema.describe(
			'Set ignored/resolved, or open to clear soft triage. Execution status and error details never change.',
		),
		note: runTriageNoteSchema,
		limit: runListLimitSchema.describe(
			'Maximum rows updated in one call for both run_ids and filter selectors (default/max 100).',
		),
		dry_run: z
			.boolean()
			.optional()
			.describe('Preview matching run ids without changing any rows.'),
	})
	.superRefine((input, ctx) => {
		if ((input.run_ids == null) === (input.filter == null)) {
			ctx.addIssue({
				code: 'custom',
				message: 'Provide exactly one of run_ids or filter.',
			})
		}
		if (
			input.triage === 'open' &&
			input.filter &&
			input.filter.error_triage !== 'ignored' &&
			input.filter.error_triage !== 'resolved'
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['filter', 'error_triage'],
				message: 'Filtered reopen requires error_triage ignored or resolved.',
			})
		}
	})

const outputSchema = z.object({
	matched_run_ids: z.array(z.string()),
	updated_count: z.number().int().nonnegative(),
	has_more: z.boolean(),
	dry_run: z.boolean(),
})

export const runUpdateBulkCapability = defineDomainCapability(
	capabilityDomainNames.runs,
	{
		name: 'runUpdateBulk',
		contextRuns: 'allow',
		orgPermission: 'job:write',
		description:
			'Non-destructively triage up to 100 retained error runs by explicit ids or safe exact-match filters. Use dry_run first for operational cleanup, then repeat filtered updates while has_more is true. Original error status, message, logs, and history remain inspectable.',
		keywords: [
			'run',
			'bulk',
			'triage',
			'resolve duplicate errors',
			'ignore recurring failures',
			'job errors',
			'activity cleanup',
		],
		readOnly: false,
		idempotent: true,
		destructive: false,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			requireMcpUser(ctx.callerContext)
			await authorizeOrgWide(
				{ env: ctx.env, request: requireMcpRequest(ctx.callerContext) },
				'job:write',
			)
			const errorTriage = args.triage === 'open' ? null : args.triage
			const result = await bulkUpdateRunErrorTriage({
				env: ctx.env,
				userId: ownerIdFromCaller(ctx.callerContext),
				runIds: args.run_ids ?? null,
				filter: args.filter
					? {
							surface: args.filter.surface ?? null,
							packageId: args.filter.package_id ?? null,
							jobId: args.filter.job_id ?? null,
							name: args.filter.name ?? null,
							errorName: args.filter.error_name ?? null,
							errorMessage: args.filter.error_message ?? null,
							errorTriage: args.filter.error_triage ?? null,
						}
					: null,
				errorTriage,
				triageNote: args.note,
				limit: args.limit ?? null,
				dryRun: args.dry_run ?? false,
			})
			if ('reason' in result) {
				throw new McpCallerError('Run history is unavailable.')
			}
			return {
				matched_run_ids: result.matchedRunIds,
				updated_count: result.updatedCount,
				has_more: result.hasMore,
				dry_run: args.dry_run ?? false,
			}
		},
	},
)
