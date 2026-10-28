import { z } from 'zod'
import {
	listUnverifiedAccountPurgeCandidates,
	pruneUnverifiedAccounts,
	unverifiedAccountPurgeBatchSize,
	unverifiedAccountPurgeDays,
} from '#worker/account/unverified-account-purge.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	stableUserIdSchema,
} from './admin-shared.ts'

/**
 * Shorter than the hourly lane budget so an interactive MCP call returns
 * before the execute transport gives up; the lane keeps draining the rest.
 */
export const adminUnverifiedAccountPurgeRunTimeBudgetMs = 10_000

const inputSchema = z.object({
	dryRun: z
		.boolean()
		.optional()
		.describe(
			'When true, only list the accounts the next purge pass would claim. No claims, no deletes, no per-account audit rows.',
		),
	batchSize: z
		.number()
		.int()
		.min(1)
		.max(20)
		.optional()
		.describe(
			`Accounts to inspect in this pass (1-20, default ${unverifiedAccountPurgeBatchSize}).`,
		),
})

const outcomeSchema = z.object({
	stableUserId: stableUserIdSchema,
	ageDays: z
		.number()
		.int()
		.describe('Whole days since the account was created.'),
	outcome: z
		.enum(['purged', 'failed', 'skipped_claim', 'would_claim'])
		.describe(
			'purged: deleted and audited. failed: deleteUserAccount threw (see error/warnings); an audit row unverified_account_purge_failed was written. skipped_claim: the row was verified, linked, or fenced between select and claim. would_claim: dry-run candidate.',
		),
	error: z
		.string()
		.optional()
		.describe(
			'Compact failure reason, `<ErrorClassName>: <first warning or message>` truncated to 200 characters.',
		),
	warnings: z
		.array(z.string())
		.optional()
		.describe('Inventory or cleanup warnings that caused the failure.'),
})

const outputSchema = z.object({
	dryRun: z.boolean(),
	scanned: z.number().int(),
	purged: z.number().int(),
	failed: z.number().int(),
	timeBudgetExhausted: z.boolean(),
	outcomes: z.array(outcomeSchema),
})

export const adminUnverifiedAccountPurgeRunCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminUnverifiedAccountPurgeRun',
		contextRuns: 'deny',
		description: `Run one bounded pass of the unverified-account purge (person accounts unverified for ${unverifiedAccountPurgeDays}+ days with no linked provider) and return per-account outcomes so operators can see why the hourly lane is failing. dryRun lists what would be claimed without claiming or deleting. Admin-only and destructive; identifies accounts by stable user id and never returns emails or usernames.`,
		keywords: [
			'admin',
			'unverified',
			'account',
			'purge',
			'retention',
			'deletion',
			'dry run',
			'scheduled lane',
		],
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const dryRun = args.dryRun ?? false
			return auditAdminCapabilityInvocation(
				ctx,
				'adminUnverifiedAccountPurgeRun',
				async () => {
					if (dryRun) {
						const preview = await listUnverifiedAccountPurgeCandidates({
							env: ctx.env,
							batchSize: args.batchSize,
						})
						return {
							dryRun: true,
							scanned: preview.scanned,
							purged: 0,
							failed: 0,
							timeBudgetExhausted: false,
							outcomes: preview.candidates.map((candidate) => ({
								...candidate,
								outcome: 'would_claim' as const,
							})),
						}
					}
					const result = await pruneUnverifiedAccounts({
						env: ctx.env,
						batchSize: args.batchSize,
						timeBudgetMs: adminUnverifiedAccountPurgeRunTimeBudgetMs,
					})
					return { dryRun: false, ...result }
				},
				{
					successReason: (result) =>
						`dry_run=${result.dryRun};scanned=${result.scanned};purged=${result.purged};failed=${result.failed}`,
				},
			)
		},
	},
)
