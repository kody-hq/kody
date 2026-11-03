import { z } from 'zod'
import { redactEmailRecipient } from '#worker/audit-log.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	canonicalSuppressionRecipient,
	clearRecipientSuppression,
	loadRecipientSuppression,
} from '#worker/email/recipient-suppression.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'
import {
	emailSuppressionSchema,
	toEmailSuppression,
} from './admin-email-suppression-shared.ts'

const inputSchema = z.object({
	recipient: z.string().min(1),
})

const outputSchema = z.object({
	cleared: z.literal(true),
	previous: emailSuppressionSchema,
})

export const adminEmailSuppressionClearCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		destructive: true,
		name: 'adminEmailSuppressionClear',
		contextRuns: 'deny',
		description:
			'Clear the hard-bounce suppression (and hard-bounce count) for one recipient so Kody system email, including verification and password reset, sends to it again. Admin-only and audit-logged. Clear only after confirming the address accepts mail; another hard bounce suppresses it again.',
		keywords: [
			'admin',
			'email',
			'suppression',
			'unsuppress',
			'bounce',
			'clear',
			'deliverability',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminEmailSuppressionClear',
				async () => {
					if (!canonicalSuppressionRecipient(args.recipient)) {
						throw new McpCallerError(
							`Invalid recipient email address: ${args.recipient}`,
						)
					}
					const previous = await loadRecipientSuppression({
						db: ctx.env.APP_DB,
						recipient: args.recipient,
					})
					if (!previous) {
						throw new McpCallerError(
							`No email suppression found for ${args.recipient}.`,
						)
					}
					await clearRecipientSuppression({
						db: ctx.env.APP_DB,
						recipient: previous.recipient,
					})
					return {
						cleared: true as const,
						previous: toEmailSuppression(previous),
					}
				},
				{
					successReason: (result) =>
						[
							`recipient=${redactEmailRecipient(result.previous.recipient)}`,
							`scope=${result.previous.scope}`,
						].join(';'),
				},
			)
		},
	},
)
