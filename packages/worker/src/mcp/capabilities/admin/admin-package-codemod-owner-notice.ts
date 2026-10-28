import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	PackageOwnerNoticeError,
	packageOwnerNoticeDefaultLimit,
	packageOwnerNoticeMaxLimit,
	runPackageOwnerNotice,
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

const inputSchema = z.object({
	runId: z
		.string()
		.min(1)
		.describe(
			'Codemod run id from adminPackageCodemodScan whose flagged packages get the notice.',
		),
	noticeId: z
		.string()
		.min(3)
		.max(80)
		.describe(
			'Stable id for this notice (lowercase, digits, dashes). Each owner is emailed at most once per noticeId.',
		),
	subject: z.string().min(1).max(200),
	whatBreaks: z
		.string()
		.min(1)
		.max(2000)
		.describe('Plain-language description of what stops working.'),
	howToFix: z
		.string()
		.min(1)
		.max(2000)
		.describe('The change the owner makes to their package.'),
	effectiveAt: z
		.string()
		.min(1)
		.max(100)
		.describe(
			'When enforcement starts, in words (for example "June 1, 2027").',
		),
	findingMessages: z
		.array(z.string().min(1))
		.min(1)
		.max(20)
		.optional()
		.describe(
			'Only notify for these exact finding messages. Omit to include every finding in the run.',
		),
	dryRun: z
		.boolean()
		.default(true)
		.describe(
			'Defaults to true: list owners and render a preview without sending or claiming.',
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
	codemodId: z.string(),
	noticeId: z.string(),
	dryRun: z.boolean(),
	owners: z.array(
		z.object({
			ownerId: z.string(),
			status: statusSchema,
			recipientCount: z.number(),
			packages: z.array(
				z.object({
					packageId: z.string(),
					kodyId: z.string(),
					findings: z.array(z.string()),
				}),
			),
		}),
	),
	summary: z.partialRecord(statusSchema, z.number()),
	preview: z.object({ subject: z.string(), text: z.string() }).nullable(),
	nextCursor: z.string().nullable(),
})

export const adminPackageCodemodOwnerNoticeCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminPackageCodemodOwnerNotice',
		contextRuns: 'deny',
		description:
			'Email the owners of packages a codemod scan flagged before a breaking gateway or credential rule change: what breaks, when, and how to fix it, naming each affected package. Dry run by default; set dryRun false to send. Each owner is emailed once per noticeId. Page with nextCursor.',
		keywords: [
			'admin',
			'package',
			'codemod',
			'owner',
			'notice',
			'email',
			'breaking change',
			'rollout',
		],
		tags: ['codemod'],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return await auditAdminCapabilityInvocation(
				ctx,
				'adminPackageCodemodOwnerNotice',
				async () => {
					try {
						return await runPackageOwnerNotice({
							env: ctx.env,
							runId: args.runId,
							noticeId: args.noticeId,
							content: {
								subject: args.subject,
								whatBreaks: args.whatBreaks,
								howToFix: args.howToFix,
								effectiveAt: args.effectiveAt,
							},
							findingMessages: args.findingMessages ?? null,
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
						`notice=${result.noticeId};run=${result.runId};dryRun=${result.dryRun};owners=${result.owners.length}`,
				},
			)
		},
	},
)
