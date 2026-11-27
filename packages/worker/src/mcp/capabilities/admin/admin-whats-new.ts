import { z } from 'zod'
import { recordWhatsNewConsentChange } from '#worker/newsletter/consent-outbox.ts'
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
		.enum(['signup', 'settings', 'email_link', 'admin', 'newsletter_page'])
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
			occurred_at: z.iso
				.datetime()
				.optional()
				.describe(
					'When the person made the choice, if it was recorded elsewhere first. Defaults to now. Not in the future. A choice older than the saved one is not applied, and the saved one is returned.',
				),
		}),
		outputSchema: optInSchema.extend({ opt_in_updated_at: z.string() }),
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminWhatsNewOptInSet',
				async () => {
					if (args.occurred_at && Date.parse(args.occurred_at) > Date.now()) {
						throw new Error('occurred_at must not be in the future.')
					}
					const result = await setWhatsNewOptIn({
						db: ctx.env.APP_DB,
						...args,
					})
					// `email_link` is the newsletter package reporting a choice it
					// already recorded, so only admin changes are announced back.
					const superseded =
						args.occurred_at !== undefined &&
						result.opt_in_updated_at !==
							new Date(args.occurred_at).toISOString()
					if (args.source === 'admin' && !superseded) {
						await recordWhatsNewConsentChange({
							env: ctx.env,
							stableUserId: result.stable_user_id,
							optedIn: result.opted_in,
							source: 'admin',
							occurredAt: result.opt_in_updated_at,
						})
					}
					return result
				},
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
			"Send one What's New in Kody email from news@. Site admins only; the package manages consent and signed unsubscribe links. Pass idempotency_key (stable per campaign and recipient) so a retry after a lost response returns the original result instead of sending again.",
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
				idempotency_key: z
					.string()
					.trim()
					.min(1)
					.max(200)
					.optional()
					.describe(
						'Stable per campaign and recipient. Reserved before the daily counter or Cloudflare is touched. A retry of a sent key returns the stored result with replayed true and sends nothing. A retry of an attempt that never finished is refused as outcome unknown and sends nothing. A key that failed before reaching Cloudflare can be retried. Reusing a key for another recipient is refused. Keys expire after 90 days.',
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
			replayed: z
				.boolean()
				.describe(
					'True when idempotency_key matched an earlier finished send; nothing was sent by this call.',
				),
		}),
		async handler(args, ctx) {
			return auditAdminCapabilityInvocation(
				ctx,
				'adminWhatsNewEmailSend',
				async () => {
					const { idempotency_key, ...message } = args
					const result = await sendNewsletterEmail({
						env: ctx.env,
						...message,
						...(idempotency_key ? { idempotencyKey: idempotency_key } : {}),
						waitUntil: ctx.waitUntil,
					})
					return {
						from: result.from,
						to: result.to,
						provider_message_id: result.providerMessageId,
						send_id: result.providerMessageId
							? JSON.stringify([result.providerMessageId, result.to[0]])
							: null,
						replayed: result.replayed === true,
					}
				},
				{
					successReason: (result) =>
						`to=${result.to.map(redactEmailRecipient).join(',')}${result.replayed ? ' replayed' : ''}`,
				},
			)
		},
	},
)
