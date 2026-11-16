import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	packageAppHostMigrationNoticeKinds,
	runPackageAppHostMigrationNotice,
} from '#worker/package-codemods/host-migration-owner-notice.ts'
import {
	PackageOwnerNoticeError,
	packageOwnerNoticeDefaultLimit,
	packageOwnerNoticeMaxLimit,
} from '#worker/package-codemods/owner-notice.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const statusSchema = z.enum([
	'would_send',
	'sent',
	'already_sent',
	'no_recipients',
	'send_failed',
	'claim_failed',
])
const categorySchema = z.enum(['browserData', 'addressCode', 'outsideRequests'])
const countSchema = z.object({ owners: z.number(), apps: z.number() })

const inputSchema = z.object({
	runId: z
		.string()
		.min(1)
		.describe(
			'Scan run id of 0019-detect-package-app-host-migration (adminPackageCodemodScan).',
		),
	noticeId: z
		.string()
		.min(3)
		.max(80)
		.describe(
			'Stable id for this email (lowercase, digits, dashes). Use a different id for the reminder. Each owner is emailed at most once per noticeId.',
		),
	kind: z
		.enum(packageAppHostMigrationNoticeKinds)
		.describe(
			'announce is the first email; reminder is the one a week before cutover.',
		),
	cutoverDate: z
		.string()
		.min(1)
		.max(100)
		.describe(
			'The fixed cutover date, in words (for example "January 15, 2027").',
		),
	reminderDate: z
		.string()
		.min(1)
		.max(100)
		.describe('When the reminder goes out, in words.'),
	dryRun: z
		.boolean()
		.default(true)
		.describe(
			'Defaults to true: count recipients by category, list owners, and render a preview without sending or claiming.',
		),
	cursor: z.string().min(1).optional(),
	limit: z
		.number()
		.int()
		.min(1)
		.max(packageOwnerNoticeMaxLimit)
		.default(packageOwnerNoticeDefaultLimit),
})

const outputSchema = z.object({
	runId: z.string(),
	noticeId: z.string(),
	kind: z.enum(packageAppHostMigrationNoticeKinds),
	dryRun: z.boolean(),
	totals: z.object({
		recipients: countSchema,
		byCategory: z.object({
			browserData: countSchema,
			addressCode: countSchema,
			outsideRequests: countSchema,
		}),
		outsideOnly: countSchema,
		appsWithoutNewHost: z.number(),
	}),
	owners: z.array(
		z.object({
			ownerId: z.string(),
			status: statusSchema,
			recipientCount: z.number(),
			apps: z.array(
				z.object({
					packageId: z.string(),
					name: z.string(),
					oldUrl: z.string(),
					newUrl: z.string(),
					categories: z.array(categorySchema),
					outside: z.array(z.string()),
				}),
			),
		}),
	),
	summary: z.partialRecord(statusSchema, z.number()),
	preview: z.object({ subject: z.string(), text: z.string() }).nullable(),
	nextCursor: z.string().nullable(),
})

export const adminPackageAppHostMigrationOwnerNoticeCapability =
	defineDomainCapability(capabilityDomainNames.admin, {
		...adminMutationCapabilityAccess,
		name: 'adminPackageAppHostMigrationOwnerNotice',
		contextRuns: 'deny',
		description:
			'Email package app owners about the move to {app}--{user} hosts, from a 0019-detect-package-app-host-migration scan run: their affected apps with old and new address, the cutover date, and the agent prompt. Dry run by default (recipient counts by category plus a preview); set dryRun false to send. Each owner is emailed once per noticeId. Page with nextCursor.',
		keywords: [
			'admin',
			'package app',
			'host migration',
			'subdomain',
			'owner',
			'notice',
			'email',
			'rollout',
		],
		tags: ['codemod'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminPackageAppHostMigrationOwnerNotice',
				async () => {
					try {
						return await runPackageAppHostMigrationNotice({
							env: ctx.env,
							runId: args.runId,
							noticeId: args.noticeId,
							kind: args.kind,
							cutoverDate: args.cutoverDate,
							reminderDate: args.reminderDate,
							dryRun: args.dryRun,
							cursor: args.cursor ?? null,
							limit: args.limit,
						})
					} catch (error) {
						if (error instanceof PackageOwnerNoticeError) {
							throw new McpCallerError(error.message, { cause: error })
						}
						throw error
					}
				},
				{
					successReason: (result) =>
						`notice=${result.noticeId};run=${result.runId};kind=${result.kind};dryRun=${result.dryRun};owners=${result.owners.length}`,
				},
			)
		},
	})
