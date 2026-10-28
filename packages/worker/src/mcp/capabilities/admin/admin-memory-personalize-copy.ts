import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { runMemoryPersonalizeCopy } from '#mcp/memory/memory-personalize.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const count = z.number().int().nonnegative()

const rowSchema = z.object({
	sourceMemoryId: z.string(),
	fromOrgId: z.string(),
	fromOrgSlug: z.string().nullable(),
	personId: z.string().nullable(),
	toOrgId: z.string().nullable(),
	newMemoryId: z.string().nullable(),
	outcome: z.enum([
		'copied',
		'skipped_already_copied',
		'skipped_content_duplicate',
		'would_copy',
		'orphan_no_reader',
	]),
})

const inputSchema = z.object({
	dryRun: z
		.boolean()
		.optional()
		.describe(
			'When true (default), plan copies without writing. Set false to insert personal copies.',
		),
	orgCursor: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Resume after this team org id (keyset). Pass the previous nextOrgCursor.',
		),
	memoryCursor: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Resume memories after this id inside the first org after orgCursor. Pass the previous nextMemoryCursor until it is null.',
		),
	orgLimit: z
		.number()
		.int()
		.min(1)
		.max(50)
		.optional()
		.describe('Team orgs to scan in this page (default 20).'),
	memoryLimitPerOrg: z
		.number()
		.int()
		.min(1)
		.max(200)
		.optional()
		.describe(
			'Max live memories to scan for the current org segment in this page (default 50). When an org has more, nextMemoryCursor is set and nextOrgCursor stays before that org.',
		),
	orgIds: z
		.array(z.string().min(1))
		.max(50)
		.optional()
		.describe(
			'Optional canary: only these org ids (still skips personal orgs).',
		),
})

const outputSchema = z.object({
	dryRun: z.boolean(),
	scannedOrgs: count,
	scannedMemories: count,
	copied: count,
	skippedAlreadyCopied: count,
	skippedContentDuplicate: count,
	wouldCopy: count,
	orphanNoReader: count,
	rows: z.array(rowSchema),
	nextOrgCursor: z.string().nullable(),
	nextMemoryCursor: z.string().nullable(),
	warnings: z.array(z.string()),
})

export const adminMemoryPersonalizeCopyCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		idempotent: true,
		name: 'adminMemoryPersonalizeCopy',
		contextRuns: 'deny',
		description:
			"Copy each live team-org memory to every person with effective memory:read at snapshot time (ADR 0072 personal-only memory). Originals stay on the team org (write-frozen). Copies go into each reader's personal org with a provenance source_uri; identical subject+summary+details already in personal are skipped. dryRun defaults to true. Page with orgCursor and memoryCursor until both nextOrgCursor and nextMemoryCursor are null.",
		keywords: [
			'admin',
			'memory',
			'personalize',
			'migration',
			'copy',
			'team org',
			'personal org',
			'backfill',
		],
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminMemoryPersonalizeCopy',
				async () =>
					await runMemoryPersonalizeCopy({
						env: ctx.env,
						dryRun: args.dryRun !== false,
						orgCursor: args.orgCursor ?? null,
						memoryCursor: args.memoryCursor ?? null,
						orgLimit: args.orgLimit,
						memoryLimitPerOrg: args.memoryLimitPerOrg,
						orgIds: args.orgIds ?? null,
					}),
				{
					successReason: (result) =>
						`dry_run=${result.dryRun};orgs=${result.scannedOrgs};memories=${result.scannedMemories};copied=${result.copied};would=${result.wouldCopy};already=${result.skippedAlreadyCopied};dup=${result.skippedContentDuplicate};orphan=${result.orphanNoReader};nextOrg=${result.nextOrgCursor ?? 'done'};nextMemory=${result.nextMemoryCursor ?? 'done'}`,
				},
			)
		},
	},
)
