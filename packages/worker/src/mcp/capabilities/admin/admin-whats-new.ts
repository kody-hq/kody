import { z } from 'zod'
import {
	listWhatsNewDeliveryEvents,
	listWhatsNewRecipients,
	setWhatsNewOptIn,
} from '#worker/admin/whats-new.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { capabilityDomainNames } from '#mcp/capabilities/domain-metadata.ts'
import { redactEmailRecipient } from '#worker/audit-log.ts'
import { sendNewsletterEmail } from '#worker/email/system-outbound.ts'
import { emailDeliveryStatusValues } from '#worker/email/types.ts'
import {
	adminCapabilityAccess,
	adminMutationCapabilityAccess,
	auditAdminCapabilityInvocation,
	stableUserIdSchema,
} from './admin-shared.ts'

const optInSchema = z.object({
	stable_user_id: stableUserIdSchema,
	opted_in: z.boolean(),
	opt_in_updated_at: z.string().nullable(),
	opt_in_source: z
		.enum(['signup', 'settings', 'email_link', 'admin'])
		.nullable(),
})

export const adminWhatsNewDeliveryEventListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminWhatsNewDeliveryEventList',
		contextRuns: 'deny',
		description:
			'List the latest matched delivery report per newsletter send, retained for 90 days. This is a mutable status snapshot, not a complete event history. Site admins only.',
		inputSchema: z.object({
			since: z.iso.datetime({ offset: true }).optional(),
			cursor: z.string().optional(),
			limit: z.number().int().min(1).max(500).default(100),
		}),
		outputSchema: z.object({
			events: z.array(
				z.object({
					provider_message_id: z.string(),
					recipient: z.string(),
					event: z.enum(emailDeliveryStatusValues),
					occurred_at: z.string(),
				}),
			),
			next_cursor: z.string().nullable(),
		}),
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminWhatsNewDeliveryEventList',
				() => listWhatsNewDeliveryEvents({ db: ctx.env.APP_DB, ...args }),
			)
		},
	},
)

export const adminWhatsNewRecipientListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminWhatsNewRecipientList',
		contextRuns: 'deny',
		description:
			"List verified, live users for What's New in Kody emails. Site admins only.",
		inputSchema: z.object({
			audience: z.enum(['opted-in', 'all-users']),
			cursor: stableUserIdSchema.optional(),
			limit: z.number().int().min(1).max(500).default(100),
		}),
		outputSchema: z.object({
			users: z.array(
				optInSchema.extend({
					email: z.string(),
					username: z.string(),
					unsubscribed: z.boolean(),
				}),
			),
			next_cursor: z.string().nullable(),
		}),
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminWhatsNewRecipientList',
				() => listWhatsNewRecipients({ db: ctx.env.APP_DB, ...args }),
			)
		},
	},
)

export const adminWhatsNewOptInSetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminWhatsNewOptInSet',
		contextRuns: 'deny',
		description:
			"Set or clear a user's What's New in Kody email consent. Site admins only.",
		inputSchema: z.object({
			stable_user_id: stableUserIdSchema,
			opted_in: z.boolean(),
			source: z.enum(['email_link', 'admin']).default('admin'),
		}),
		outputSchema: optInSchema.extend({ opt_in_updated_at: z.string() }),
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminWhatsNewOptInSet',
				() => setWhatsNewOptIn({ db: ctx.env.APP_DB, ...args }),
				{
					successReason: (result) =>
						`target_stable_user_id=${result.stable_user_id};opted_in=${result.opted_in}`,
				},
			)
		},
	},
)

export const adminWhatsNewEmailSendCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminWhatsNewEmailSend',
		contextRuns: 'deny',
		description:
			"Send one What's New in Kody email from news@. Site admins only; the package manages consent and signed unsubscribe links.",
		inputSchema: z
			.object({
				to: z.email(),
				subject: z.string().trim().min(1),
				html: z.string().trim().min(1).optional(),
				text: z.string().trim().min(1).optional(),
				headers: z
					.record(z.string(), z.string())
					.optional()
					.describe(
						'Custom headers Cloudflare Email Sending accepts, such as List-Unsubscribe or X-*. Headers with their own field (Reply-To, From, To, Cc, Bcc, Subject) or that Cloudflare generates (Message-ID, Date) are rejected.',
					),
			})
			.refine((value) => value.html || value.text, {
				message: 'Email text or HTML body is required.',
				path: ['text'],
			}),
		outputSchema: z.object({
			from: z.string(),
			to: z.array(z.string()),
			provider_message_id: z.string().nullable(),
			send_id: z
				.string()
				.nullable()
				.describe(
					'The system_email_sends composite key encoded as JSON [provider_message_id, recipient]; null if the provider returned no message ID.',
				),
		}),
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminWhatsNewEmailSend',
				async () => {
					const result = await sendNewsletterEmail({
						env: ctx.env,
						...args,
						waitUntil: ctx.waitUntil,
					})
					return {
						from: result.from,
						to: result.to,
						provider_message_id: result.providerMessageId,
						send_id: result.providerMessageId
							? JSON.stringify([result.providerMessageId, result.to[0]])
							: null,
					}
				},
				{
					successReason: (result) =>
						`to=${result.to.map(redactEmailRecipient).join(',')}`,
				},
			)
		},
	},
)
