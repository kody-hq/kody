import { resolveTransactionalSenderReplyTo } from '@kody-internal/shared/transactional-sender-reply-to.ts'
import {
	cloudflareCustomHeaderProblem,
	cloudflareRequestRejectionMessage,
	sendCloudflareEmail,
} from '#app/email/cloudflare-email.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { normalizeAddrSpec, normalizeHeaderMailbox } from './address.ts'
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
	systemEmailLimits,
	transactionalSystemEmailLocals,
	type SystemEmailLocal,
} from './system-email.ts'
import { dispatchSystemEmailSentSubscriptionEvent } from './system-email-sent-package-subscriptions.ts'
import { buildSystemEmailSentEvent } from './system-email-sent-subscription-event.ts'
import {
	claimSystemEmailSendKey,
	finishSystemEmailSendKey,
} from './system-email-send-keys.ts'
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
	/** True when an idempotency key matched a finished send and nothing was sent. */
	replayed?: boolean
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
		const address = normalizeHeaderMailbox(value)
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
type SystemEmailInput = {
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
	/**
	 * Newsletter only. Reserved per send kind before the counter or provider
	 * is touched; see `system-email-send-keys.ts`.
	 */
	idempotencyKey?: string
	now?: Date
	waitUntil?: (promise: Promise<unknown>) => void
}

export async function sendSystemEmail(
	input: Omit<SystemEmailInput, 'idempotencyKey'>,
): Promise<SystemOutboundResult> {
	if (
		!transactionalSystemEmailLocals.includes(
			(input.localPart ??
				'kody') as (typeof transactionalSystemEmailLocals)[number],
		)
	) {
		throw new McpCallerError(
			`Unknown system sender "${input.localPart}". This sender is not available for transactional system email.`,
		)
	}
	return sendReservedEmail(input, false)
}

// Newsletter volume and complaints use a dedicated sender and quota, separate
// from transactional correspondence.
export async function sendNewsletterEmail(
	input: Omit<SystemEmailInput, 'localPart' | 'replyTo' | 'kind' | 'to'> & {
		to: string
	},
): Promise<SystemOutboundResult> {
	if (typeof input.to !== 'string' || !normalizeAddrSpec(input.to)) {
		throw new McpCallerError(
			'One newsletter recipient email address is required.',
		)
	}
	return sendReservedEmail(
		{ ...input, localPart: 'news', kind: 'whats_new' },
		true,
	)
}

/**
 * Double opt-in confirmation for a public newsletter sign-up. It shares the
 * newsletter sender and quota so abuse of the public form cannot spend
 * transactional reputation, but records its own kind so it never appears in
 * newsletter delivery listings.
 */
export async function sendNewsletterConfirmationEmail(
	input: Omit<
		SystemEmailInput,
		'localPart' | 'replyTo' | 'kind' | 'to' | 'idempotencyKey'
	> & {
		to: string
	},
): Promise<SystemOutboundResult> {
	if (typeof input.to !== 'string' || !normalizeAddrSpec(input.to)) {
		throw new McpCallerError(
			'One newsletter recipient email address is required.',
		)
	}
	return sendReservedEmail(
		{ ...input, localPart: 'news', kind: 'whats_new_confirm' },
		true,
	)
}

async function sendReservedEmail(
	input: SystemEmailInput,
	newsletter: boolean,
): Promise<SystemOutboundResult> {
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
	const headerProblem = cloudflareCustomHeaderProblem(input.headers)
	if (headerProblem) throw new McpCallerError(headerProblem)
	const explicitReplyTo = input.replyTo
		? normalizeHeaderMailbox(input.replyTo)
		: null
	if (input.replyTo && !explicitReplyTo) {
		throw new McpCallerError(`Invalid reply-to address: ${input.replyTo}`)
	}
	const replyTo = newsletter
		? `kent@${domain}`
		: (resolveTransactionalSenderReplyTo({
				from,
				replyTo: explicitReplyTo,
			}) ?? null)
	const now = input.now ?? new Date()
	const kind = input.kind ?? systemEmailOperatorSendKind
	const key = newsletter ? input.idempotencyKey?.trim() || null : null
	if (key) {
		const claim = await claimSystemEmailSendKey({
			db: input.env.APP_DB,
			kind,
			key,
			recipient: to[0]!,
			now,
		})
		if (claim.type === 'replay') {
			return {
				from: claim.sender || from,
				to,
				providerMessageId: claim.providerMessageId,
				replayed: true,
			}
		}
	}
	let providerReached = false
	try {
		const result = await deliverReservedEmail({
			input,
			newsletter,
			localPart,
			from,
			to,
			subject,
			text,
			html,
			replyTo,
			kind,
			now,
			onProviderCall: () => {
				providerReached = true
			},
			onAccepted: async (providerMessageId) => {
				if (!key) return
				await finishSystemEmailSendKey({
					db: input.env.APP_DB,
					kind,
					key,
					state: 'sent',
					sender: from,
					providerMessageId,
					now,
				})
			},
		})
		return result
	} catch (error) {
		if (key) {
			// A thrown provider call may have reached Cloudflare; a definite
			// rejection or any failure before the call did not.
			await finishSystemEmailSendKey({
				db: input.env.APP_DB,
				kind,
				key,
				state:
					providerReached && !(error instanceof ProviderRejection)
						? 'unknown'
						: 'failed',
				now,
			}).catch((finishError: unknown) => {
				console.warn('system-email-send-key-finish-failed', finishError)
			})
		}
		if (error instanceof ProviderRejection) throw error.rejection
		throw error
	}
}

/** A definite provider response that the message was not accepted. */
class ProviderRejection extends Error {
	readonly rejection: Error
	constructor(rejection: Error) {
		super(rejection.message)
		this.rejection = rejection
	}
}

async function deliverReservedEmail({
	input,
	newsletter,
	localPart,
	from,
	to,
	subject,
	text,
	html,
	replyTo,
	kind,
	now,
	onProviderCall,
	onAccepted,
}: {
	input: SystemEmailInput
	newsletter: boolean
	localPart: SystemEmailLocal
	from: string
	to: Array<string>
	subject: string
	text: string | null
	html: string | null
	replyTo: string | null
	kind: string
	now: Date
	onProviderCall: () => void
	onAccepted: (providerMessageId: string | null) => Promise<void>
}): Promise<SystemOutboundResult> {
	for (const recipient of to) {
		const suppression = await loadRecipientSuppression({
			db: input.env.APP_DB,
			recipient,
		})
		if (suppression?.scope === 'all') {
			throw new McpCallerError(`${recipient}: ${recipientSuppressedMessage}`)
		}
	}

	const consumed = await consumeSystemEmailDailySend({
		db: input.env.APP_DB,
		localPart,
		now,
		limit: newsletter
			? systemEmailLimits.maxNewsletterSendsPerDay
			: systemEmailLimits.maxSendsPerDay,
	})
	if (consumed === null) {
		throw new McpCallerError(
			newsletter
				? `Daily newsletter send limit (${systemEmailLimits.maxNewsletterSendsPerDay}) reached for ${from}. Try again tomorrow.`
				: `Daily system email send limit reached for ${from}. Try again tomorrow.`,
		)
	}

	let result: Awaited<ReturnType<typeof sendCloudflareEmail>>
	onProviderCall()
	try {
		result = await sendCloudflareEmail(
			{
				accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
				apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
				apiToken: input.env.CLOUDFLARE_API_TOKEN,
				retryTransportErrors: !newsletter,
			},
			{
				to: to.length === 1 ? to[0]! : to,
				from,
				...(newsletter ? { fromName: 'Kent from Kody' } : {}),
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
		const rejection = cloudflareRequestRejectionMessage(result)
		const error = rejection
			? new McpCallerError(rejection)
			: new Error(
					result.skipped
						? 'System email was skipped because no Cloudflare Email credentials are configured.'
						: (result.error ?? 'System email send failed.'),
				)
		// Only a 4xx is a definite rejection. Lost transport, a 5xx, or an
		// unreadable 2xx may still have queued the message.
		const mayHaveSent =
			!result.skipped &&
			!result.messageId &&
			!(
				result.status !== undefined &&
				result.status >= 400 &&
				result.status < 500
			)
		throw mayHaveSent ? error : new ProviderRejection(error)
	}
	const providerMessageId = result.messageId ?? null
	await onAccepted(providerMessageId)
	await recordSystemEmailSends({
		db: input.env.APP_DB,
		providerMessageId,
		recipients: to,
		sender: from,
		kind,
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
