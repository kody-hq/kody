import { z } from 'zod'
import { type CapabilityContext } from '#mcp/capabilities/types.ts'
import { requireMcpUser } from '#mcp/capabilities/meta/require-user.ts'
import { credentialNeedEnforcementScope } from '#worker/credentials/credential-need-enforcement-scope.ts'
import {
	runPackageCodemodStep,
	type PackageCodemodRunFilters,
	type PackageCodemodRunMode,
} from '#worker/package-codemods/engine.ts'

export const packageCodemodItemStatusSchema = z.enum([
	'detected',
	'clean',
	'dry_run_ok',
	'dry_run_new_failures',
	'needs_manual',
	'skipped_drift',
	'skipped_unpublished',
	'applied',
	'reverted',
	'failed',
])

export const packageCodemodRunModeSchema = z.enum([
	'scan',
	'dry-run',
	'apply',
	'revert',
])

export const packageCodemodFindingSchema = z.object({
	path: z.string().nullable(),
	message: z.string(),
})

export const packageCodemodRunItemSchema = z.object({
	itemId: z.string(),
	userId: z.string(),
	packageId: z.string(),
	kodyId: z.string(),
	status: packageCodemodItemStatusSchema,
	changedPaths: z.array(z.string()),
	findings: z.array(packageCodemodFindingSchema),
	beforeCommit: z.string().nullable(),
	afterCommit: z.string().nullable(),
	checkSummary: z
		.object({
			ok: z.boolean(),
			newFailures: z.array(z.string()),
		})
		.nullable(),
	error: z.string().nullable(),
})

export const packageCodemodStepResultSchema = z.object({
	runId: z.string().describe('Codemod run id; pass back when paging.'),
	codemodId: z.string(),
	mode: packageCodemodRunModeSchema,
	items: z.array(packageCodemodRunItemSchema),
	nextCursor: z
		.string()
		.nullable()
		.describe(
			'Opaque cursor for the next page, or null when this is the last page.',
		),
	summary: z.partialRecord(
		packageCodemodItemStatusSchema,
		z.number().int().nonnegative(),
	),
	nextStep: z
		.string()
		.describe(
			'What to do with nextCursor. Dry-run, apply, and revert continue in a new execute or workflow sandbox.',
		),
})

export const packageCodemodStepInputSchema = z.object({
	codemodId: z.string().min(1).describe('Registered package codemod id.'),
	packageIds: z
		.array(z.string().min(1))
		.optional()
		.describe('Optional saved package ids to limit this step.'),
	runId: z
		.string()
		.min(1)
		.optional()
		.describe('Existing run id to continue; required with cursor when paging.'),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe('Opaque pagination cursor from a previous nextCursor value.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(50)
		.optional()
		.describe(
			'Max packages to process in this step. Scan: default 20, max 50. Dry-run, apply, and revert are check-heavy: default 5, max 10 (higher values are clamped). One apply/dry-run/revert page per execute or workflow sandbox.',
		),
})

export const packageCodemodRevertInputSchema = z.object({
	revertOfRunId: z
		.string()
		.min(1)
		.describe('Prior apply run id whose applied items should be reverted.'),
	runId: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Existing revert run id to continue; required with cursor when paging.',
		),
	cursor: z
		.string()
		.min(1)
		.optional()
		.describe('Opaque pagination cursor from a previous nextCursor value.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(10)
		.optional()
		.describe(
			'Max items to revert in this step (default 5, max 10). Reverts republish packages: one page per execute or workflow sandbox.',
		),
})

export const packageCodemodFiltersSchema = z
	.object({
		userIds: z
			.array(z.string().min(1))
			.optional()
			.describe('Optional user ids to canary or limit a fleet run.'),
		packageIds: z
			.array(z.string().min(1))
			.optional()
			.describe('Optional saved package ids to limit a fleet run.'),
		excludePackageIds: z
			.array(z.string().min(1))
			.optional()
			.describe(
				'Optional saved package ids to record as needs_manual (operator excluded) instead of processing.',
			),
		scope: z
			.literal(credentialNeedEnforcementScope)
			.optional()
			.describe(
				'Keep the run to packages the credential-need enforcement can reach: team-org packages, personal-org packages in an org that grants access, unadopted community forks, and internet-visible packages.',
			),
	})
	.describe('Optional fleet filters for canary or partial runs.')

export const adminPackageCodemodStepInputSchema =
	packageCodemodStepInputSchema.extend({
		filters: packageCodemodFiltersSchema.optional(),
	})

export const adminPackageCodemodRevertInputSchema =
	packageCodemodRevertInputSchema.extend({
		filters: packageCodemodFiltersSchema.optional(),
	})

export const packageCodemodPagingHint =
	'Paged: each call is one page. Continue with the same runId and nextCursor until nextCursor is null.'

export const packageCodemodHeavyPagingHint =
	'Paged: one page per execute or workflow sandbox (default limit 5). When nextCursor is set, start a new execute or workflows.create with that runId and cursor — do not loop pages in the same sandbox.'

export function createPackageCodemodNextStep(result: {
	runId: string
	nextCursor: string | null
	mode: PackageCodemodRunMode
}) {
	if (result.nextCursor == null) {
		return 'This run has no further pages.'
	}
	switch (result.mode) {
		case 'scan':
			return `Continue with runId ${result.runId} and cursor ${result.nextCursor}. Scan pages usually fit in one sandbox; spawn a new workflow if the call is approaching the sandbox budget.`
		case 'dry-run':
		case 'apply':
		case 'revert':
			return `This page is done. Continue in a new execute or workflows.create call with runId ${result.runId} and cursor ${result.nextCursor} (limit ≤5). Do not page again in the same sandbox.`
		default: {
			const exhaustive: never = result.mode
			throw new Error(`Unknown package codemod mode: ${String(exhaustive)}`)
		}
	}
}

export async function runFleetPackageCodemodStep(
	ctx: CapabilityContext,
	input: {
		codemodId: string
		mode: PackageCodemodRunMode
		packageIds?: Array<string>
		filters?: PackageCodemodRunFilters
		runId?: string
		cursor?: string
		limit?: number
		revertOfRunId?: string
	},
) {
	const user = requireMcpUser(ctx.callerContext)
	const packageIds = input.filters?.packageIds ?? input.packageIds
	const scope = input.filters?.scope
	const excludePackageIds = input.filters?.excludePackageIds
	const filters =
		input.filters?.userIds != null ||
		packageIds != null ||
		excludePackageIds != null ||
		scope != null
			? {
					...(input.filters?.userIds != null
						? { userIds: input.filters.userIds }
						: {}),
					...(packageIds != null ? { packageIds } : {}),
					...(excludePackageIds != null ? { excludePackageIds } : {}),
					...(scope != null ? { scope } : {}),
				}
			: undefined
	const result = await runPackageCodemodStep({
		env: ctx.env,
		baseUrl: ctx.callerContext.baseUrl,
		initiatedByUserId: user.userId,
		codemodId: input.codemodId,
		mode: input.mode,
		scope: { kind: 'fleet' },
		filters,
		runId: input.runId,
		cursor: input.cursor,
		limit: input.limit,
		revertOfRunId: input.revertOfRunId,
	})
	return {
		...result,
		nextStep: createPackageCodemodNextStep(result),
	}
}
