import { z } from 'zod'
import { loadAdminHandleHolders } from '#worker/admin/handle-get.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z.object({
	handle: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.describe(
			'Handle, org slug, or username. Matched case-insensitively after stripping hyphens and underscores, the same compaction reserved-name checks use.',
		),
})

const holderSchema = z.object({
	source: z
		.enum(['handle', 'org', 'user'])
		.describe('Which table held the match.'),
	ownerKind: z
		.enum(['user', 'org'])
		.nullable()
		.describe(
			'Org when the row is an org slug or a handle claimed by an org (including a personal org). User when only a person username or user-held handle matched. Null for a handle row with no owner id.',
		),
	id: z
		.string()
		.nullable()
		.describe(
			'orgs.id or users.stable_user_id. Null when the handle has no owner.',
		),
	storedHandle: z
		.string()
		.describe('Handle, slug, or username as stored, before compaction.'),
	createdAt: z.string().describe('created_at of the matching row.'),
	deletedAt: z
		.string()
		.nullable()
		.describe(
			'Soft-delete timestamp when that owner row is tombstoned. Null for a live row, and for a handle whose owner row is gone or was never set.',
		),
})

const outputSchema = z.object({
	compact: z
		.string()
		.describe(
			'Lookup key after reserved-name compaction (lowercase, hyphens and underscores removed).',
		),
	holders: z.array(holderSchema),
	total: z
		.number()
		.int()
		.nonnegative()
		.describe(
			'Full match count across handles, orgs, and users. holders is capped at 50.',
		),
	truncated: z
		.boolean()
		.describe('True when total is greater than the 50 holders returned.'),
})

export const adminHandleGetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminHandleGet',
		contextRuns: 'deny',
		description:
			'Resolve one handle across handles, org slugs, and usernames, including soft-deleted rows. Match is case-insensitive and strips hyphens and underscores the same way reserved-name checks do. Returns owner kind, id, and created_at only. Admin-only; never a public search or profile lookup.',
		keywords: [
			'admin',
			'handle',
			'username',
			'org slug',
			'lookup',
			'reserved',
			'soft delete',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminHandleGet',
				async () => loadAdminHandleHolders(ctx.env.APP_DB, args.handle),
				{
					successReason: (result) =>
						`compact=${result.compact};returned=${String(result.holders.length)};total=${String(result.total)};truncated=${String(result.truncated)}`,
				},
			)
		},
	},
)
