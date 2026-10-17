import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { setEmailMessageClassification } from '#worker/email/service.ts'
import { emailClassificationValues } from '#worker/email/types.ts'
import {
	emailOwnerOrgId,
	requireVerifiedEmailAccountUser,
} from './require-verified-user.ts'

export const emailMessageClassifyCapability = defineDomainCapability(
	capabilityDomainNames.email,
	{
		name: 'emailMessageClassify',
		orgPermission: 'email:write',
		description:
			'Reclassify a stored inbound email message as accepted or quarantined. Setting classification to accepted releases a quarantined message so emailReply can answer it. Receive-time classification decides package subscription dispatch once; reclassifying to accepted does not retroactively fire email.message.received.',
		keywords: [
			'email',
			'message',
			'classify',
			'quarantine',
			'spam',
			'accepted',
		],
		readOnly: false,
		idempotent: false,
		destructive: false,
		inputSchema: z.object({
			message_id: z.string().min(1),
			classification: z.enum(emailClassificationValues),
		}),
		outputSchema: z.object({
			message_id: z.string(),
			classification: z.enum(emailClassificationValues),
		}),
		async handler(args, ctx) {
			const user = await requireVerifiedEmailAccountUser(ctx)
			const classificationReason =
				args.classification === 'quarantined' ? 'Reclassified by user.' : null
			const updated = await setEmailMessageClassification({
				env: ctx.env,
				db: ctx.env.APP_DB,
				userId: emailOwnerOrgId(ctx, user),
				messageId: args.message_id,
				classification: args.classification,
				classificationReason,
			})
			if (!updated) {
				throw new McpCallerError(`Email message not found: ${args.message_id}`)
			}
			return {
				message_id: args.message_id,
				classification: args.classification,
			}
		},
	},
)
