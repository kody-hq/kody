import { resolveTransactionalSenderReplyTo } from '@kody-internal/shared/transactional-sender-reply-to.ts'
import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { normalizeEmailAddress } from './address.ts'
import {
	loadRecipientSuppression,
	recipientSuppressedMessage,
} from './recipient-suppression.ts'
import { getSystemEmailDomain } from './platform-address.ts'
import {
	consumeSystemEmailDailySend,
	isSystemEmailLocal,
	refundSystemEmailDailySend,
	systemEmailLocals,
	type SystemEmailLocal,
} from './system-email.ts'
import { dispatchSystemEmailSentSubscriptionEvent } from './system-email-sent-package-subscriptions.ts'
import { buildSystemEmailSentEvent } from './system-email-sent-subscription-event.ts'
import {
	recordSystemEmailSends,
	systemEmailOperatorSendKind,
} from './system-email-sends.ts'

type SystemOutboundEnv = Pick<
	Env,
	| 'APP_DB'
	| 'APP_BASE_URL'
	| 'BUNDLE_ARTIFACTS_KV'
	| 'CLOUDFLARE_ACCOUNT_ID'
	| 'CLOUDFLARE_API_BASE_URL'
	| 'CLOUDFLARE_API_TOKEN'
> & { SYSTEM_EMAIL_DOMAIN?: string | null }

/**
 * Ceiling on recipients per operator send. System mail is transactional
 * one-to-one correspondence (a reply to a report, a heads-up to one user),
 * never a mailing list: bulk sending belongs on a marketing provider with
 * its own consent and unsubscribe handling.
 */
export const maxSystemOutboundRecipients = 5

export type SystemOutboundResult = {
	from: string
	to: Array<string>
	providerMessageId: string | null
}

function escapeHtml(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
}

/**
 * The provider requires an HTML body. Text-only callers get the same
 * paragraph-per-blank-line rendering the platform's own alert mail uses.
 */
function htmlFromText(text: string) {
	const paragraphs = text
		.split(/\n{2,}/u)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph.length > 0)
		.map(
			(paragraph) =>
				`<p>${escapeHtml(paragraph).replaceAll('\n', '<br />')}</p>`,
		)
		.join('')
	return `<!doctype html><html lang="en"><body>${paragraphs}</body></html>`
}

function resolveRecipients(to: string | Array<string>): Array<string> {
	const values = Array.isArray(to) ? to : [to]
	const recipients: Array<string> = []
	for (const value of values) {
		const address = normalizeEmailAddress(value)
		if (!address) {
			throw new McpCallerError(`Invalid recipient email address: ${value}`)
		}
		if (!recipients.includes(address)) recipients.push(address)
	}
	if (recipients.length === 0) {
		throw new McpCallerError(
			'At least one recipient email address is required.',
		)
	}
	if (recipients.length > maxSystemOutboundRecipients) {
		throw new McpCallerError(
			`System email allows at most ${maxSystemOutboundRecipients} recipients per message.`,
		)
	}
	return recipients
}

/**
 * Send transactional mail from a reserved system sender
 * (`{local}@<system domain>`) to arbitrary recipients.
 *
 * This is the operator correspondence channel, structurally separate from
 * user mail: it does not touch any user mailbox, sender identity, or plan
 * entitlement, and it is protected by its own per-sender daily cap so a
 * runaway caller cannot burn the apex domain's sending reputation. Mail
 * From `kody@<domain>` sets Reply-To to `support@<domain>` unless the
 * caller passes an explicit `replyTo`. Callers are responsible for the
 * authorization check — today only admin-gated, audit-logged capabilities
 * and internal platform alerts reach it.
 *
 * Every send is recorded in `system_email_sends` so delivery reports match
 * it, and a recipient fully suppressed after repeated hard bounces is
 * refused before the counter is consumed (`adminEmailSuppressionClear`
 * lifts it).
 */
export async function sendSystemEmail(input: {
	env: SystemOutboundEnv
	/** Reserved system local part; defaults to the `kody` sender. */
	localPart?: SystemEmailLocal
	to: string | Array<string>
	subject: string
	text?: string | null
	html?: string | null
	replyTo?: string | null
	headers?: Record<string, string>
	/** Send kind recorded for delivery-report matching. */
	kind?: string
	now?: Date
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<SystemOutboundResult> {
	const localPart = input.localPart ?? 'kody'
	if (!isSystemEmailLocal(localPart)) {
		throw new McpCallerError(
			`Unknown system sender "${localPart}". Expected one of: ${systemEmailLocals.join(', ')}.`,
		)
	}
	const domain = getSystemEmailDomain(input.env)
	if (!domain) {
		throw new Error(
			'System email is unavailable because no system email domain is configured.',
		)
	}
	const from = `${localPart}@${domain}`
	const to = resolveRecipients(input.to)
	const subject = input.subject.trim()
	if (!subject) throw new McpCallerError('Email subject is required.')
	const text = input.text?.trim() || null
	const html = input.html?.trim() || null
	if (!text && !html) {
		throw new McpCallerError('Email text or HTML body is required.')
	}
	const explicitReplyTo = input.replyTo
		? normalizeEmailAddress(input.replyTo)
		: null
	if (input.replyTo && !explicitReplyTo) {
		throw new McpCallerError(`Invalid reply-to address: ${input.replyTo}`)
	}
	const replyTo =
		resolveTransactionalSenderReplyTo({
			from,
			replyTo: explicitReplyTo,
		}) ?? null

	for (const recipient of to) {
		const suppression = await loadRecipientSuppression({
			db: input.env.APP_DB,
			recipient,
		})
		if (suppression?.scope === 'all') {
			throw new McpCallerError(`${recipient}: ${recipientSuppressedMessage}`)
		}
	}

	const now = input.now ?? new Date()
	const consumed = await consumeSystemEmailDailySend({
		db: input.env.APP_DB,
		localPart,
		now,
	})
	if (consumed === null) {
		throw new McpCallerError(
			`Daily system email send limit reached for ${from}. Try again tomorrow.`,
		)
	}

	let result: Awaited<ReturnType<typeof sendCloudflareEmail>>
	try {
		result = await sendCloudflareEmail(
			{
				accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
				apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
				apiToken: input.env.CLOUDFLARE_API_TOKEN,
			},
			{
				to: to.length === 1 ? to[0]! : to,
				from,
				subject,
				html: html ?? htmlFromText(text ?? ''),
				text: text ?? undefined,
				...(replyTo ? { replyTo } : {}),
				...(input.headers ? { headers: input.headers } : {}),
			},
		)
	} catch (error) {
		await refundSystemEmailDailySend({
			db: input.env.APP_DB,
			localPart,
			now,
		})
		throw error
	}
	if (!result.ok) {
		await refundSystemEmailDailySend({
			db: input.env.APP_DB,
			localPart,
			now,
		})
		throw new Error(
			result.skipped
				? 'System email was skipped because no Cloudflare Email credentials are configured.'
				: (result.error ?? 'System email send failed.'),
		)
	}
	const providerMessageId = result.messageId ?? null
	await recordSystemEmailSends({
		db: input.env.APP_DB,
		providerMessageId,
		recipients: to,
		sender: from,
		kind: input.kind ?? systemEmailOperatorSendKind,
		now,
	})
	const resolvedHtml = html ?? htmlFromText(text ?? '')
	try {
		await dispatchSystemEmailSentSubscriptionEvent({
			env: input.env,
			event: buildSystemEmailSentEvent({
				from,
				to,
				subject,
				text,
				html: resolvedHtml,
				replyTo,
				providerMessageId,
				sentAt: now.toISOString(),
			}),
			waitUntil: input.waitUntil,
		})
	} catch (error) {
		console.warn('system-email-sent-subscription-dispatch-failed', error)
	}
	return { from, to, providerMessageId }
}
