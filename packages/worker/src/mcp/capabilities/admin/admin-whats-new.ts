import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
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

type RecipientRow = {
	stable_user_id: string
	email: string
	username: string
	whats_new_email_opt_in: number
	whats_new_email_opt_in_updated_at: string | null
	whats_new_email_opt_in_source:
		| 'signup'
		| 'settings'
		| 'email_link'
		| 'admin'
		| null
}

const deliveryCursorSchema = z.tuple([z.iso.datetime(), z.string(), z.string()])

function parseDeliveryCursor(value: string) {
	try {
		return deliveryCursorSchema.parse(JSON.parse(value))
	} catch {
		throw new McpCallerError('Invalid cursor; pass next_cursor unchanged.')
	}
}

export const adminWhatsNewDeliveryEventListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminWhatsNewDeliveryEventList',
		contextRuns: 'allow',
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
				async () => {
					const cursor = args.cursor
						? parseDeliveryCursor(args.cursor)
						: ['', '', '']
					const rows = await ctx.env.APP_DB.prepare(
						`SELECT provider_message_id, recipient, last_status AS event, last_status_at AS occurred_at
					 FROM system_email_sends
					 WHERE kind = 'whats_new' AND last_status IS NOT NULL AND last_status_at IS NOT NULL
					 AND last_status_at >= ?
					 AND (last_status_at, provider_message_id, recipient) > (?, ?, ?)
					 ORDER BY last_status_at, provider_message_id, recipient LIMIT ?`,
					)
						.bind(
							args.since ? new Date(args.since).toISOString() : '',
							...cursor,
							args.limit + 1,
						)
						.all<{
							provider_message_id: string
							recipient: string
							event: (typeof emailDeliveryStatusValues)[number]
							occurred_at: string
						}>()
					const events = rows.results.slice(0, args.limit)
					const last = events.at(-1)
					return {
						events,
						next_cursor:
							rows.results.length > args.limit && last
								? JSON.stringify([
										last.occurred_at,
										last.provider_message_id,
										last.recipient,
									])
								: null,
					}
				},
			)
		},
	},
)

export const adminWhatsNewRecipientListCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminCapabilityAccess,
		name: 'adminWhatsNewRecipientList',
		contextRuns: 'allow',
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
				async () => {
					const rows = await ctx.env.APP_DB.prepare(
						`SELECT stable_user_id, email, username,
						whats_new_email_opt_in, whats_new_email_opt_in_updated_at, whats_new_email_opt_in_source
					 FROM users
					 WHERE deleted_at IS NULL AND deleting_at IS NULL
						AND email_verified_at IS NOT NULL
						AND stable_user_id > ?
						${args.audience === 'opted-in' ? 'AND whats_new_email_opt_in = 1' : ''}
					 ORDER BY stable_user_id LIMIT ?`,
					)
						.bind(args.cursor ?? '', args.limit + 1)
						.all<RecipientRow>()
					const page = rows.results.slice(0, args.limit)
					return {
						users: page.map((row) => ({
							stable_user_id: row.stable_user_id,
							email: row.email,
							username: row.username,
							opted_in: row.whats_new_email_opt_in === 1,
							opt_in_updated_at: row.whats_new_email_opt_in_updated_at,
							opt_in_source: row.whats_new_email_opt_in_source,
							unsubscribed:
								row.whats_new_email_opt_in === 0 &&
								row.whats_new_email_opt_in_updated_at !== null,
						})),
						next_cursor:
							rows.results.length > args.limit
								? page.at(-1)!.stable_user_id
								: null,
					}
				},
			)
		},
	},
)

export const adminWhatsNewOptInSetCapability = defineDomainCapability(
	capabilityDomainNames.admin,
	{
		...adminMutationCapabilityAccess,
		name: 'adminWhatsNewOptInSet',
		contextRuns: 'allow',
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
				async () => {
					const updatedAt = new Date().toISOString()
					const row = await ctx.env.APP_DB.prepare(
						`UPDATE users SET whats_new_email_opt_in = ?, whats_new_email_opt_in_updated_at = ?, whats_new_email_opt_in_source = ?
					 WHERE stable_user_id = ? AND deleted_at IS NULL AND deleting_at IS NULL
					 RETURNING stable_user_id`,
					)
						.bind(
							args.opted_in ? 1 : 0,
							updatedAt,
							args.source,
							args.stable_user_id,
						)
						.first<{ stable_user_id: string }>()
					if (!row) throw new McpCallerError('User not found.')
					return {
						stable_user_id: row.stable_user_id,
						opted_in: args.opted_in,
						opt_in_updated_at: updatedAt,
						opt_in_source: args.source,
					}
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
		contextRuns: 'allow',
		description:
			"Send one What's New in Kody email from news@. Site admins only; the package manages consent and signed unsubscribe links.",
		inputSchema: z
			.object({
				to: z.email(),
				subject: z.string().trim().min(1),
				html: z.string().trim().min(1).optional(),
				text: z.string().trim().min(1).optional(),
				headers: z.record(z.string(), z.string()).optional(),
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
