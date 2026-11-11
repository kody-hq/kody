import { McpCallerError } from '#mcp/caller-error.ts'
import {
	normalizeEmailAddress,
	normalizeHeaderMailbox,
	splitEmailLocalPart,
} from './address.ts'
import { resolveInboundEmailAuthVerdict } from './auth-verdict.ts'
import { authenticatesFromAddress } from './inbound-sender.ts'
import type { EmailMessageRecord } from './types.ts'

/**
 * Reply-all sends allowed per thread in a rolling window, on top of the plan's
 * daily `email_sends_per_day`. Failed attempts count.
 */
export const replyAllThreadSendLimit = 5
export const replyAllThreadWindowMs = 24 * 60 * 60 * 1000

export const replyAllNotAllowedErrorCode = 'reply_all_not_allowed' as const

export const replyAllNotAllowedMessage =
	'Reply-all is not allowed on this thread because the inbox owner has not added this inbox to it. Kody only replies to everyone on a thread after the owner sends a message on that thread from one of their verified email destinations with this inbox in To or Cc. Reply to the sender only (omit reply_all), or add the inbox to the thread from your own verified address first. (reply_all_not_allowed)'

export const replyAllThreadLimitErrorCode = 'reply_all_thread_limit' as const

export const replyAllThreadLimitMessage = `Reply-all limit reached for this thread: at most ${replyAllThreadSendLimit} reply-all sends per thread in 24 hours. Reply to the sender only (omit reply_all), or try again later. (reply_all_thread_limit)`

/** Caller-fixable refusal: the owner never put this inbox on the thread. */
export class ReplyAllNotAllowedError extends McpCallerError {
	readonly code = replyAllNotAllowedErrorCode
	constructor() {
		super(replyAllNotAllowedMessage)
		this.name = 'ReplyAllNotAllowedError'
	}
}

export class ReplyAllThreadLimitError extends McpCallerError {
	readonly code = replyAllThreadLimitErrorCode
	constructor() {
		super(replyAllThreadLimitMessage)
		this.name = 'ReplyAllThreadLimitError'
	}
}

export type KodyInboxAddressMatcher = (address: string) => boolean

/**
 * True for this inbox's own addresses: a handle the inbox answers to
 * (`{handle}@` or `{handle}+tag@`) on an accepted user email domain.
 */
export function createKodyInboxAddressMatcher(input: {
	handles: Iterable<string>
	acceptedDomains: ReadonlyArray<string>
}): KodyInboxAddressMatcher {
	const handles = new Set(
		Array.from(input.handles, (handle) => handle.trim().toLowerCase()).filter(
			Boolean,
		),
	)
	const domains = new Set(input.acceptedDomains.map((d) => d.toLowerCase()))
	return (address) => {
		const normalized = normalizeEmailAddress(address)
		if (!normalized) return false
		const at = normalized.lastIndexOf('@')
		if (!domains.has(normalized.slice(at + 1))) return false
		return handles.has(splitEmailLocalPart(normalized.slice(0, at)).base)
	}
}

function addressList(values: ReadonlyArray<unknown>) {
	return values.filter((value): value is string => typeof value === 'string')
}

/**
 * The owner put the inbox on the thread: some inbound message on it was sent
 * (From authenticated by DMARC or aligned SPF) from one of the owner's
 * verified destinations, with an inbox address in To or Cc. Bcc does not
 * count.
 */
export function ownerAddedInboxToThread(input: {
	threadMessages: ReadonlyArray<EmailMessageRecord>
	ownerAddresses: ReadonlySet<string>
	isKodyInboxAddress: KodyInboxAddressMatcher
}) {
	return input.threadMessages.some((message) => {
		if (message.direction !== 'inbound') return false
		if (message.classification !== 'accepted') return false
		const from = message.fromAddress
			? normalizeHeaderMailbox(message.fromAddress)
			: null
		if (!from || !input.ownerAddresses.has(from)) return false
		const authenticated = authenticatesFromAddress({
			verdict: resolveInboundEmailAuthVerdict(message.authResults),
			fromAddress: from,
			envelopeFrom: message.envelopeFrom,
		})
		if (!authenticated) return false
		return [
			...addressList(message.toAddresses),
			...addressList(message.ccAddresses),
		].some(input.isKodyInboxAddress)
	})
}

/**
 * Reply-all recipients from the stored message only: Reply-To (or From) plus
 * To go on To, Cc stays on Cc, minus this inbox's own addresses. Callers may
 * drop recipients but never add one.
 */
export function deriveReplyAllRecipients(input: {
	original: EmailMessageRecord
	isKodyInboxAddress: KodyInboxAddressMatcher
	dropRecipients?: ReadonlyArray<string>
}): { to: Array<string>; cc: Array<string> } {
	const replyTo = addressList(input.original.replyToAddresses)
	const author =
		replyTo.length > 0
			? replyTo
			: addressList([
					input.original.fromAddress,
					input.original.envelopeFrom,
				]).slice(0, 1)
	const seen = new Set<string>()
	const collect = (values: ReadonlyArray<string>) => {
		const out: Array<string> = []
		for (const value of values) {
			const address = normalizeEmailAddress(value)
			if (!address || seen.has(address)) continue
			if (input.isKodyInboxAddress(address)) continue
			seen.add(address)
			out.push(address)
		}
		return out
	}
	let to = collect([...author, ...addressList(input.original.toAddresses)])
	let cc = collect(addressList(input.original.ccAddresses))

	const drop = new Set<string>()
	for (const value of input.dropRecipients ?? []) {
		const address = normalizeEmailAddress(value)
		if (!address || !seen.has(address)) {
			throw new McpCallerError(
				`drop_recipients can only remove recipients of the stored message. Not a recipient: ${value}. Reply-all recipients are: ${[...to, ...cc].join(', ') || '(none)'}.`,
			)
		}
		drop.add(address)
	}
	to = to.filter((address) => !drop.has(address))
	cc = cc.filter((address) => !drop.has(address))
	if (to.length === 0) {
		throw new McpCallerError(
			cc.length > 0
				? 'Reply-all needs at least one To recipient. Keep the sender or a To address, or reply to the sender only (omit reply_all).'
				: 'Reply-all has no recipients left after removing this inbox and drop_recipients.',
		)
	}
	return { to, cc }
}
