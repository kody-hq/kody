import { z } from 'zod'
import { routes } from '#universal/routes.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	AdminAccountHardDeleteError,
	createAdminAccountDeletionApproval,
} from '#worker/admin/account-hard-delete.ts'
import { adminAccountDeletionAcknowledgementReasons } from '#universal/admin-account-deletion.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	resolveActingAdminPerson,
	stableUserIdSchema,
} from './admin-shared.ts'

const inputSchema = z
	.object({
		stableUserId: stableUserIdSchema
			.optional()
			.describe('Stable users.stable_user_id of the account to delete.'),
		email: z
			.string()
			.email()
			.optional()
			.describe('Email address of the account to delete.'),
		username: z
			.string()
			.min(1)
			.optional()
			.describe('Handle of the account to delete.'),
	})
	.refine(
		(value) =>
			[value.stableUserId, value.email, value.username].filter(
				(item) => item !== undefined,
			).length === 1,
		{ message: 'Provide exactly one of stableUserId, email, or username.' },
	)

const outputSchema = z.object({
	status: z.literal('approval_required'),
	approvalUrl: z
		.string()
		.describe(
			'Open this page, review the account, and click Approve. Nothing is deleted until then.',
		),
	expiresAt: z.string(),
	acknowledgementRequired: z.boolean(),
	acknowledgementReasons: z.array(
		z.enum(adminAccountDeletionAcknowledgementReasons),
	),
	message: z.string(),
})

export const adminUserAccountDeleteCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminUserAccountDelete',
		description:
			'Start a hard delete of one person account. Admin-only. This never deletes anything: it returns an approval URL. The admin opens that single page, reviews the handle, email, created date, plan, and counts (packages, jobs, credentials, connections, sessions, org memberships, memories, webhooks, usage, and credit balance), and clicks Approve. Packages, sole ownership of a non-personal organization, or paid billing require an extra acknowledgement on that page before Approve works. Approval frees the handle so it can be registered again, removes the personal organization, and leaves organizations this person does not solely own (and their other members) in place. The link expires in 24 hours.',
		keywords: [
			'admin',
			'user',
			'account',
			'delete',
			'hard delete',
			'handle',
			'approval',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminUserAccountDelete',
				async () => {
					const admin = await resolveActingAdminPerson(ctx)
					let created: Awaited<
						ReturnType<typeof createAdminAccountDeletionApproval>
					>
					try {
						created = await createAdminAccountDeletionApproval({
							env: ctx.env,
							actor: {
								stableUserId: admin.stableUserId,
								email: admin.email,
								username: admin.username,
							},
							target: {
								stableUserId: args.stableUserId,
								email: args.email,
								username: args.username,
							},
						})
					} catch (error) {
						if (error instanceof AdminAccountHardDeleteError) {
							throw new McpCallerError(error.message, { cause: error })
						}
						throw error
					}
					const approvalUrl = new URL(
						routes.adminAccountDeletion.href({
							approvalId: created.approvalId,
						}),
						ctx.callerContext.baseUrl,
					).toString()
					const acknowledgement = created.summary.acknowledgementRequired
						? ` The page requires an extra acknowledgement (${created.summary.acknowledgementReasons.join(', ')}) before Approve is enabled.`
						: ''
					return {
						status: 'approval_required' as const,
						approvalUrl,
						expiresAt: created.expiresAt,
						acknowledgementRequired: created.summary.acknowledgementRequired,
						acknowledgementReasons: created.summary.acknowledgementReasons,
						message: `Nothing was deleted. Send the admin to ${approvalUrl} to review @${created.summary.handle} and click Approve.${acknowledgement}`,
					}
				},
				{
					successReason: (result) =>
						`approval_required;acknowledgement=${result.acknowledgementRequired};expires_at=${result.expiresAt}`,
				},
			)
		},
	},
)
