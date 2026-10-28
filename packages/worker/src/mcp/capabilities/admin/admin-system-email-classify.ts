import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	emailMessageTriageInputSchema,
	emailMessageTriageOutputSchema,
} from '#mcp/capabilities/email/email-message-classify.ts'
import { emailMessageTriageAuditReason } from '#worker/email/message-triage-audit.ts'
import { setEmailMessageClassification } from '#worker/email/service.ts'
import { systemEmailOwnerId } from '#worker/email/system-email.ts'
import { manualEmailClassificationReason } from '#worker/email/types.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const outputSchema = emailMessageTriageOutputSchema.extend({
	ownerId: z
		.string()
		.describe(
			'Reserved operator-owned storage owner id; not a user account id.',
		),
})

export const adminSystemEmailClassifyCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminSystemEmailClassify',
		contextRuns: 'deny',
		description:
			'Mark one operator-owned system inbox message as spam, not spam (accepted), or quarantined, and/or archive or unarchive it. Nothing is deleted; spam and archived mail leave the default adminSystemEmailList view. Never adds a sender rule (use adminSystemEmailSenderRuleSet). Admin-only and audit logged; never touches user-owned email.',
		keywords: [
			'admin',
			'system email',
			'message',
			'classify',
			'spam',
			'not spam',
			'quarantine',
			'archive',
			'unarchive',
			'abuse',
			'postmaster',
		],
		inputSchema: emailMessageTriageInputSchema,
		outputSchema,
		async handler(args, ctx) {
			const change = {
				messageId: args.message_id,
				classification: args.classification,
				archived: args.archived,
			}
			return auditAdminCapabilityInvocation(
				ctx,
				'adminSystemEmailClassify',
				async () => {
					const updated = await setEmailMessageClassification({
						env: ctx.env,
						db: ctx.env.APP_DB,
						userId: systemEmailOwnerId,
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
					if (!updated) {
						throw new McpCallerError(
							`System email message not found: ${args.message_id}`,
						)
					}
					return {
						ownerId: systemEmailOwnerId,
						message_id: args.message_id,
						...(args.classification === undefined
							? {}
							: { classification: args.classification }),
						...(args.archived === undefined ? {} : { archived: args.archived }),
					}
				},
				{ successReason: () => emailMessageTriageAuditReason(change) },
			)
		},
	},
)
