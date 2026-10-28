import { z } from 'zod'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import {
	EmailSenderRuleLimitError,
	EmailSenderRuleValidationError,
	upsertEmailSenderRule,
} from '#worker/email/sender-rules.ts'
import { systemEmailOwnerId } from '#worker/email/system-email.ts'
import {
	emailSenderRuleEffectValues,
	emailSenderRuleKindValues,
} from '#worker/email/types.ts'
import {
	emailSenderRuleSchema,
	toSenderRule,
} from '#mcp/capabilities/email/shared.ts'
import {
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
} from './admin-shared.ts'

const inputSchema = z.object({
	kind: z.enum(emailSenderRuleKindValues),
	value: z.string().min(1),
	effect: z.enum(emailSenderRuleEffectValues),
	note: z.string().optional(),
})

const outputSchema = z.object({
	ownerId: z
		.string()
		.describe(
			'Reserved operator-owned storage owner id; not a user account id.',
		),
	rule: emailSenderRuleSchema,
})

export const adminSystemEmailSenderRuleSetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminSystemEmailSenderRuleSet',
		contextRuns: 'deny',
		description:
			'Create or update a sender rule that controls inbound spam policy for operator system inboxes (kody@, abuse@, and other reserved locals on the apex domain). Admin-only; never mutates user-owned email rules.',
		keywords: [
			'admin',
			'system email',
			'sender rule',
			'allow',
			'block',
			'quarantine',
			'spam',
		],
		inputSchema,
		outputSchema,
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminSystemEmailSenderRuleSet',
				async () => {
					try {
						const rule = await upsertEmailSenderRule({
							db: ctx.env.APP_DB,
							userId: systemEmailOwnerId,
							kind: args.kind,
							value: args.value,
							effect: args.effect,
							note: args.note,
						})
						return {
							ownerId: systemEmailOwnerId,
							rule: toSenderRule(rule),
						}
					} catch (error) {
						if (
							error instanceof EmailSenderRuleValidationError ||
							error instanceof EmailSenderRuleLimitError
						) {
							throw new Error(error.message)
						}
						throw error
					}
				},
				{
					successReason: ({ rule }) =>
						`rule_id=${rule.id};kind=${rule.kind};effect=${rule.effect}`,
				},
			)
		},
	},
)
