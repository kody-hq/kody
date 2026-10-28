import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { systemEmailOwnerId } from '#worker/email/email-owner.ts'
import { auditUserEmailMessageTriage } from '#worker/email/message-triage-audit.ts'
import { setEmailMessageClassification } from '#worker/email/service.ts'
import {
	emailClassificationValues,
	manualEmailClassificationReason,
} from '#worker/email/types.ts'
import {
	emailOwnerOrgId,
	requireVerifiedEmailAccountUser,
} from './require-verified-user.ts'

export const emailMessageTriageInputSchema = z
	.object({
		message_id: z.string().min(1),
		classification: z
			.enum(emailClassificationValues)
			.optional()
			.describe(
				'"spam" marks it as spam (hidden from the default inbox view), "accepted" is Not spam / release from quarantine, "quarantined" re-quarantines it.',
			),
		archived: z
			.boolean()
			.optional()
			.describe(
				'true archives (hidden from the default inbox view), false unarchives. Independent of classification.',
			),
	})
	.refine(
		(value) =>
			value.classification !== undefined || value.archived !== undefined,
		{
			message: 'Provide classification, archived, or both.',
			path: ['classification'],
		},
	)

export const emailMessageTriageOutputSchema = z.object({
	message_id: z.string(),
	classification: z.enum(emailClassificationValues).optional(),
	archived: z.boolean().optional(),
})

export const emailMessageClassifyCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'emailMessageClassify',
		contextRuns: 'allow',
		orgPermission: 'email:write',
		description:
			'Mark a stored inbound email message as spam, not spam, or quarantined, and/or archive or unarchive it. Nothing is deleted. Spam and archived mail leave the default inbox view (emailMessageList view "spam" / "archived" shows them). Setting classification to accepted releases a quarantined or spam message so emailReply can answer it. Receive-time classification decides package subscription dispatch once; reclassifying does not retroactively fire email.message.received. Marking spam never adds a sender rule; use emailSenderRuleSet to block future mail.',
		keywords: [
			'email',
			'message',
			'classify',
			'quarantine',
			'spam',
			'not spam',
			'accepted',
			'archive',
			'unarchive',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: emailMessageTriageInputSchema,
		outputSchema: emailMessageTriageOutputSchema,
		async handler(args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const ownerId = emailOwnerOrgId(ctx, user)
			if (ownerId === systemEmailOwnerId) {
				throw new McpCallerError(
					'System inbox messages are triaged with adminSystemEmailClassify.',
				)
			}
			const change = {
				messageId: args.message_id,
				classification: args.classification,
				archived: args.archived,
			}
			const updated = await setEmailMessageClassification({
				env: ctx.env,
				db: ctx.env.APP_DB,
				userId: ownerId,
				messageId: args.message_id,
				...(args.classification === undefined
					? {}
					: {
							classification: args.classification,
							classificationReason: manualEmailClassificationReason(
								args.classification,
							),
						}),
				archived: args.archived,
			})
			await auditUserEmailMessageTriage({
				env: ctx.env,
				actorEmail: user.email,
				path: '/mcp',
				result: updated ? 'success' : 'failure',
				change,
				outcome: updated ? undefined : 'not_found',
			})
			if (!updated) {
				throw new McpCallerError(`Email message not found: ${args.message_id}`)
			}
			return {
				message_id: args.message_id,
				...(args.classification === undefined
					? {}
					: { classification: args.classification }),
				...(args.archived === undefined ? {} : { archived: args.archived }),
			}
		},
	},
)
