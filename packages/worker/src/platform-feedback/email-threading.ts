/**
 * Client threading for platform-feedback mail.
 *
 * Cloudflare Email Sending generates Message-ID (callers cannot set it) and
 * returns it on send. Follow-ups set In-Reply-To / References to that id and
 * use a stable Re: subject so Gmail-style clients keep the conversation on one
 * thread. When no acknowledgement Message-ID is stored (acks sent before this
 * column existed, or a provider response without an id), follow-ups keep their
 * standalone subject and omit threading headers.
 */

export const platformFeedbackAcknowledgementSubject =
	'We got your Kody feedback'

export const platformFeedbackFollowUpSubject = `Re: ${platformFeedbackAcknowledgementSubject}`

/** Normalize a provider Message-ID into RFC angle-bracket form, or null. */
export function normalizeRfcMessageId(
	value: string | null | undefined,
): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	if (!trimmed) return null
	const wrapped =
		trimmed.startsWith('<') && trimmed.endsWith('>') ? trimmed : `<${trimmed}>`
	// Reject empty or malformed ids that would break In-Reply-To.
	if (wrapped.length < 5 || !wrapped.includes('@')) return null
	if (wrapped.includes('\r') || wrapped.includes('\n')) return null
	if (wrapped.length > 998) return null
	return wrapped
}

export type PlatformFeedbackFollowUpMailMeta = {
	subject: string
	headers?: Record<string, string>
	threaded: boolean
}

/**
 * Subject and optional threading headers for a follow-up about one feedback
 * item. Pass the stored acknowledgement Message-ID when present.
 */
export function buildPlatformFeedbackFollowUpMailMeta(input: {
	acknowledgementMessageId: string | null | undefined
	fallbackSubject: string
}): PlatformFeedbackFollowUpMailMeta {
	const messageId = normalizeRfcMessageId(input.acknowledgementMessageId)
	if (!messageId) {
		return {
			subject: input.fallbackSubject,
			threaded: false,
		}
	}
	return {
		subject: platformFeedbackFollowUpSubject,
		headers: {
			'In-Reply-To': messageId,
			References: messageId,
		},
		threaded: true,
	}
}
