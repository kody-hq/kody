import { sendCloudflareEmail } from '#app/email/cloudflare-email.ts'

/**
 * Shared Cloudflare outbound send used by user mail (`emailSend` /
 * `emailReply`) and destination-verification mail. Prefer the Workers
 * `EMAIL` binding (the path that already delivers from
 * `{username}@inbox…`), then fall back to Email Sending REST.
 */

export type ProviderSendAttachment = {
	filename: string
	contentType: string
	bytes: Uint8Array
	contentBase64: string
}

export type ProviderSendEnv = {
	EMAIL?: SendEmail
	CLOUDFLARE_ACCOUNT_ID?: string
	CLOUDFLARE_API_BASE_URL?: string
	CLOUDFLARE_API_TOKEN?: string
}

export type ProviderSendInput = {
	env: ProviderSendEnv
	from: string
	to: Array<string>
	/** Visible Cc recipients (reply-all). Bcc is never sent. */
	cc?: Array<string>
	subject: string
	text?: string | null
	html?: string | null
	replyTo?: string | null
	headers?: Record<string, string>
	attachments?: Array<ProviderSendAttachment>
}

export type ProviderSendResult = {
	messageId: string | null
	via: 'binding' | 'rest'
}

async function sendViaBinding(
	input: ProviderSendInput,
): Promise<{ sent: false } | { sent: true; messageId: string | null }> {
	const binding = input.env.EMAIL
	if (!binding) return { sent: false }
	const attachments = input.attachments ?? []
	const headers = input.headers ?? {}
	const cc = input.cc ?? []
	const result = await binding.send({
		from: input.from,
		to: input.to.length === 1 ? input.to[0]! : input.to,
		...(cc.length > 0 ? { cc } : {}),
		subject: input.subject,
		...(input.replyTo ? { replyTo: input.replyTo } : {}),
		headers,
		...(input.text ? { text: input.text } : {}),
		...(input.html ? { html: input.html } : {}),
		...(attachments.length > 0
			? {
					// The binding treats string content as raw text, so binary
					// payloads must go through as bytes rather than base64.
					attachments: attachments.map((attachment) => ({
						disposition: 'attachment' as const,
						filename: attachment.filename,
						type: attachment.contentType,
						content: attachment.bytes,
					})),
				}
			: {}),
	})
	return { sent: true, messageId: result.messageId ?? null }
}

async function sendViaRest(input: ProviderSendInput): Promise<string | null> {
	const html = input.html ?? input.text
	if (!html) {
		throw new Error('Email text or HTML body is required.')
	}
	const attachments = input.attachments ?? []
	const headers = input.headers ?? {}
	const result = await sendCloudflareEmail(
		{
			accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
			apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
			apiToken: input.env.CLOUDFLARE_API_TOKEN,
		},
		{
			from: input.from,
			to: input.to.length === 1 ? input.to[0]! : input.to,
			...(input.cc && input.cc.length > 0 ? { cc: input.cc } : {}),
			subject: input.subject,
			html,
			text: input.text ?? undefined,
			replyTo: input.replyTo ?? undefined,
			headers: Object.keys(headers).length > 0 ? headers : undefined,
			attachments:
				attachments.length > 0
					? // The REST API expects base64 string content.
						attachments.map((attachment) => ({
							content: attachment.contentBase64,
							filename: attachment.filename,
							type: attachment.contentType,
							disposition: 'attachment' as const,
							// The inferred schema output type requires this key even
							// when undefined; JSON.stringify drops it from the payload.
							contentId: undefined,
						}))
					: undefined,
		},
	)
	if (!result.ok) {
		if (result.skipped) {
			throw new CloudflareEmailProviderSkippedError()
		}
		throw new Error(result.error ?? 'Cloudflare email send failed.')
	}
	return result.messageId ?? null
}

/** REST fallback had no Cloudflare Email credentials configured. */
export class CloudflareEmailProviderSkippedError extends Error {
	override name = 'CloudflareEmailProviderSkippedError'
	constructor() {
		super(
			'Cloudflare email send was skipped because no Cloudflare Email credentials are configured.',
		)
	}
}

/**
 * Prefer the Workers Email binding; fall back to Email Sending REST when the
 * binding is missing or throws (preview workers and some cold-send failures).
 * Throws when neither path accepts the message.
 */
export async function sendViaCloudflareEmailProvider(
	input: ProviderSendInput,
): Promise<ProviderSendResult> {
	try {
		const bindingResult = await sendViaBinding(input)
		if (bindingResult.sent) {
			return { messageId: bindingResult.messageId, via: 'binding' }
		}
	} catch (error) {
		console.warn('cloudflare-email-binding-failed-falling-back-to-rest', error)
	}
	return { messageId: await sendViaRest(input), via: 'rest' }
}
