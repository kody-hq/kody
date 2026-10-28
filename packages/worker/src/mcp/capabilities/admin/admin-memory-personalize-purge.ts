import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { requireMcpRequest } from '#mcp/capabilities/meta/require-user.ts'
import { runMemoryPersonalizePurge } from '#mcp/memory/memory-personalize-purge.ts'
import { orgAuditWriterFromRequest } from '#worker/orgs/org-audit.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const count = z.number().int().nonnegative()

const rowSchema = z.object({
	sourceMemoryId: z.string(),
	fromOrgId: z.string(),
	fromOrgSlug: z.string().nullable(),
	readerCount: count,
	verifiedCopyCount: count,
	missingReaderPersonIds: z.array(z.string()),
	provenanceUrisChecked: z.array(z.string()),
	outcome: z.enum([
		'would_purge',
		'purged',
		'blocked_missing_copy',
		'orphan_purged',
		'orphan_would_purge',
		'already_gone',
		'soft_delete_failed',
	]),
})

const grantRowSchema = z.object({
	grantId: z.string(),
	orgId: z.string(),
	orgSlug: z.string().nullable(),
	resourceId: z.string(),
	outcome: z.enum(['would_revoke', 'revoked', 'skipped_error']),
	error: z.string().optional(),
})

const inputSchema = z.object({
	dryRun: z
		.boolean()
		.optional()
		.describe(
			'When true (default), verify copies and plan soft-deletes without writing. Set false only after dry-run shows zero blocked_missing_copy.',
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
	plannedPurgeMemoryIds: z
		.array(z.string().min(1))
		.max(10_000)
		.optional()
		.describe(
			'Dry-run only: pass previous nextPlannedPurgeMemoryIds so the final grant sweep counts would-purge memories from earlier pages of the same org. Ignored when dryRun is false.',
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
			'Max live memories to scan for the current org segment in this page (default 50).',
		),
	orgIds: z
		.array(z.string().min(1))
		.max(50)
		.optional()
		.describe(
			'Optional canary: only these org ids (still skips personal orgs).',
		),
	purgeOrphans: z
		.boolean()
		.optional()
		.describe(
			'When true (default), soft-delete team memories with zero effective readers. Set false to leave orphans blocked.',
		),
})

const outputSchema = z.object({
	dryRun: z.boolean(),
	scannedOrgs: count,
	scannedMemories: count,
	wouldPurge: count,
	purged: count,
	blockedMissingCopy: count,
	orphanWouldPurge: count,
	orphanPurged: count,
	grantsWouldRevoke: count,
	grantsRevoked: count,
	vectorCleanupFailed: count,
	rows: z.array(rowSchema),
	grantRows: z.array(grantRowSchema),
	nextOrgCursor: z.string().nullable(),
	nextMemoryCursor: z.string().nullable(),
	nextPlannedPurgeMemoryIds: z.array(z.string()),
	warnings: z.array(z.string()),
})

export const adminMemoryPersonalizePurgeCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		idempotent: true,
		name: 'adminMemoryPersonalizePurge',
		contextRuns: 'deny',
		description:
			'Soft-delete verified legacy team-org mcp_memories and obsolete memory grants after ADR 0072 copy (adminMemoryPersonalizeCopy). Never deletes a memory until every effective reader has a personal copy (provenance URI or identical content). Rows report counts and provenance URIs only — never subject/summary/details. dryRun defaults to true. Page with orgCursor, memoryCursor, and plannedPurgeMemoryIds until nextOrgCursor and nextMemoryCursor are null (pass nextPlannedPurgeMemoryIds back on dry-run mid-org pages).',
		keywords: [
			'admin',
			'memory',
			'personalize',
			'migration',
			'purge',
			'cleanup',
			'team org',
			'soft delete',
		],
		destructive: true,
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			const request = requireMcpRequest(ctx.callerContext)
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminMemoryPersonalizePurge',
				async () =>
					await runMemoryPersonalizePurge({
						env: ctx.env,
						audit: orgAuditWriterFromRequest(ctx.env, request),
						dryRun: args.dryRun !== false,
						orgCursor: args.orgCursor ?? null,
						memoryCursor: args.memoryCursor ?? null,
						plannedPurgeMemoryIds: args.plannedPurgeMemoryIds ?? null,
						orgLimit: args.orgLimit,
						memoryLimitPerOrg: args.memoryLimitPerOrg,
						orgIds: args.orgIds ?? null,
						purgeOrphans: args.purgeOrphans,
					}),
				{
					successReason: (result) =>
						`dry_run=${result.dryRun};orgs=${result.scannedOrgs};memories=${result.scannedMemories};would=${result.wouldPurge};purged=${result.purged};blocked=${result.blockedMissingCopy};orphanWould=${result.orphanWouldPurge};orphanPurged=${result.orphanPurged};grantsWould=${result.grantsWouldRevoke};grantsRevoked=${result.grantsRevoked};vectorFailed=${result.vectorCleanupFailed};nextOrg=${result.nextOrgCursor ?? 'done'};nextMemory=${result.nextMemoryCursor ?? 'done'}`,
				},
			)
		},
	},
)
