import { z } from 'zod'
import {
	auditEventCategories,
	auditEventResults,
	queryAuditLog,
} from '#worker/audit-log.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	adminCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z.object({
	action: z
		.string()
		.min(1)
		.optional()
		.describe('Exact audit action to match, such as adminUserList.'),
	category: z
		.enum(auditEventCategories)
		.optional()
		.describe('Audit event category filter.'),
	result: z
		.enum(auditEventResults)
		.optional()
		.describe('Audit event result filter.'),
	user: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Actor email address to filter by. Kody hashes it before querying; raw emails are not stored in audit rows.',
		),
	emailHash: z
		.string()
		.min(1)
		.optional()
		.describe('Actor email hash from the prior page of results.'),
	startTime: z
		.string()
		.datetime()
		.optional()
		.describe('Inclusive ISO timestamp lower bound.'),
	endTime: z
		.string()
		.datetime()
		.optional()
		.describe('Inclusive ISO timestamp upper bound.'),
	page: z.number().int().min(1).optional().describe('One-indexed result page.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe('Events per page. Defaults to 50 and maxes at 100.'),
})

const auditLogEntrySchema = z.object({
	// SQLite INTEGER PRIMARY KEY accepts any signed 64-bit integer (including 0
	// and negatives from legacy/manual rows). AUTOINCREMENT app writes start at 1.
	id: z.number().int(),
	category: z.enum(auditEventCategories),
	action: z.string(),
	result: z.enum(auditEventResults),
	email_hash: z.string().nullable(),
	ip_hash: z.string().nullable(),
	client_id: z.string().nullable(),
	path: z.string().nullable(),
	reason: z.string().nullable(),
	timestamp: z.string(),
})

const outputSchema = z.object({
	total: z.number().int().nonnegative(),
	page: z.number().int().positive(),
	limit: z.number().int().positive(),
	events: z.array(auditLogEntrySchema),
})

export const adminAuditLogQueryCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminAuditLogQuery',
		contextRuns: 'deny',
		description:
			'Query sanitized account-administration audit metadata by action, actor, result, category, or time range. Admin-only; never returns user content.',
		keywords: ['admin', 'audit', 'log', 'events', 'account metadata'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminAuditLogQuery',
				async () => queryAuditLog(ctx.env.AUDIT_DB, args),
			)
		},
	},
)
