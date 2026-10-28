import { McpCallerError } from '#mcp/caller-error.ts'

/**
 * Stable code for agents. Sandbox `email.reply` only receives the message
 * string, so the code is also the last token of {@link quarantinedInboundReplyMessage}.
 * OpenAPI and the MCP `api` tool surface the same code on the error envelope.
 */
export const quarantinedInboundReplyErrorCode =
	'quarantined_inbound_reply' as const

export const quarantinedInboundReplyMessage =
	'This message is in quarantine, so Kody won\'t reply to it (replies to quarantined mail usually reach spoofed senders). If it\'s legitimate, release it from quarantine first: call emailMessageClassify with classification "accepted", or choose Not spam on the email inbox page, then reply. (quarantined_inbound_reply)'

export const spamInboundReplyMessage =
	'This message is marked as spam, so Kody won\'t reply to it (replies to spam usually reach spoofed senders). If it\'s legitimate, mark it as not spam first: call emailMessageClassify with classification "accepted", or choose Not spam on the email inbox page, then reply. (quarantined_inbound_reply)'

/**
 * Caller-fixable refusal for quarantined or spam mail. Replying would
 * backscatter to a From that often does not belong to the person who sent the
 * spam. Both share one code so agents handle a single refusal. Stays off
 * Sentry via {@link McpCallerError}.
 */
export class QuarantinedInboundReplyError extends McpCallerError {
	readonly code = quarantinedInboundReplyErrorCode

	constructor(classification: 'quarantined' | 'spam' = 'quarantined') {
		super(
			classification === 'spam'
				? spamInboundReplyMessage
				: quarantinedInboundReplyMessage,
		)
		this.name = 'QuarantinedInboundReplyError'
	}
}

export function isQuarantinedInboundReplyError(
	error: unknown,
): error is QuarantinedInboundReplyError {
	return (
		error instanceof QuarantinedInboundReplyError ||
		(error instanceof Error &&
			'code' in error &&
			error.code === quarantinedInboundReplyErrorCode)
	)
}
