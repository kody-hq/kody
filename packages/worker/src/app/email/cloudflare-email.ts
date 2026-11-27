import { parseSafe } from 'remix/data-schema'
import { toCloudflareSendBody } from '@kody-internal/shared/cloudflare-send-body.ts'
import {
	outboundEmailSchema,
	type OutboundEmail,
} from '@kody-internal/shared/outbound-email.ts'
import { resolveTransactionalSenderReplyTo } from '@kody-internal/shared/transactional-sender-reply-to.ts'
import { redactEmailRecipient } from '#worker/audit-log.ts'

type CloudflareEmailClientConfig = {
	accountId?: string
	apiBaseUrl?: string
	apiToken?: string
	retryTransportErrors?: boolean
}

const defaultCloudflareApiBaseUrl = 'https://api.cloudflare.com'

type CloudflareApiEnvelope = {
	success: boolean
	errors?: Array<{
		code?: number | string
		message?: string
	}>
	result?: {
		message_id?: string
		delivered?: string[]
		permanent_bounces?: string[]
		queued?: string[]
	}
}

/** Visible Cc recipients (user reply-all). Bcc is never sent. */
type OutboundEmailCc = { cc?: Array<string> }

type CloudflareSendResult = {
	ok: boolean
	skipped?: boolean
	error?: string
	messageId?: string | null
	/** HTTP status of a Cloudflare API error response. */
	status?: number
	/** First `errors[].code` of a Cloudflare API error response. */
	providerCode?: number | string
}

function normalizeEmailPayload(message: OutboundEmail) {
	const result = parseSafe(outboundEmailSchema, message)
	if (!result.success) {
		const issueMessage = result.issues
			.map((issue) => {
				const path =
					Array.isArray(issue.path) && issue.path.length > 0
						? issue.path.join('.')
						: 'payload'
				return `${path}: ${issue.message}`
			})
			.join(', ')
		throw new Error(`Invalid outbound email payload: ${issueMessage}`)
	}
	return result.value
}

function redactRecipients(to: string | Array<string>) {
	if (Array.isArray(to)) return to.map(redactEmailRecipient)
	return redactEmailRecipient(to)
}

function logSkippedEmail(reason: string, message: OutboundEmail) {
	// Informational: callers decide whether a skipped send is a problem (the
	// verification flow throws in production), so an unconfigured client in
	// local dev / e2e runs must not surface as a warning.
	console.info(
		reason,
		JSON.stringify({
			to: redactRecipients(message.to),
			from: message.from,
			subject: message.subject,
		}),
	)
}

function normalizeApiBaseUrl(apiBaseUrl: string) {
	return apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`
}

function isRetryableFetchError(error: unknown) {
	return (
		error instanceof Error &&
		(error as Error & { retryable?: unknown }).retryable === true
	)
}

async function sendViaCloudflareApi(
	config: Required<
		Pick<CloudflareEmailClientConfig, 'accountId' | 'apiBaseUrl' | 'apiToken'>
	> &
		Pick<CloudflareEmailClientConfig, 'retryTransportErrors'>,
	message: OutboundEmail & OutboundEmailCc,
): Promise<CloudflareSendResult> {
	const endpoint = new URL(
		`client/v4/accounts/${config.accountId}/email/sending/send`,
		normalizeApiBaseUrl(config.apiBaseUrl),
	)
	const send = () =>
		fetch(endpoint.toString(), {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${config.apiToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(toCloudflareSendBody(message)),
		})
	let response: Response
	try {
		response = await send().catch(async (error: unknown) => {
			// workerd flags transient transport drops ("Network connection
			// lost.") as retryable; retry those once (#5077).
			if (
				config.retryTransportErrors === false ||
				!isRetryableFetchError(error)
			)
				throw error
			console.warn('cloudflare-email-api-request-retrying', error)
			await new Promise((resolve) => setTimeout(resolve, 250))
			return send()
		})
	} catch (error) {
		console.warn('cloudflare-email-api-request-failed', error)
		return {
			ok: false,
			error:
				error instanceof Error
					? error.message
					: 'Cloudflare Email API request failed.',
		}
	}

	// A 2xx must parse: it may have queued mail. An unreadable error body is
	// still a definite rejection with its status.
	const payload = (
		response.ok
			? await response.json()
			: await response.json().catch(() => null)
	) as CloudflareApiEnvelope | null
	if (!response.ok || payload?.success !== true) {
		console.warn(
			'cloudflare-email-api-failed',
			JSON.stringify({
				status: response.status,
				body: payload,
				to: redactRecipients(message.to),
				from: message.from,
			}),
		)
		const providerCode = payload?.errors?.[0]?.code
		return {
			ok: false,
			error:
				payload?.errors?.[0]?.message ??
				'Cloudflare Email API returned an error response.',
			status: response.status,
			...(providerCode === undefined ? {} : { providerCode }),
		}
	}

	const bounceError = permanentBounceError(
		[
			...(Array.isArray(message.to) ? message.to : [message.to]),
			...(message.cc ?? []),
		],
		payload.result,
	)
	if (bounceError) {
		console.warn(
			'cloudflare-email-api-permanent-bounce',
			JSON.stringify({
				to: redactRecipients(message.to),
				from: message.from,
				subject: message.subject,
				permanent_bounces: redactRecipients(
					payload.result?.permanent_bounces ?? [],
				),
				message_id: payload.result?.message_id ?? null,
			}),
		)
		return {
			ok: false,
			error: bounceError,
			messageId: payload.result?.message_id ?? null,
		}
	}

	return {
		ok: true,
		messageId: payload.result?.message_id ?? null,
	}
}

const requestRejectionHints: Record<string, string> = {
	'10001':
		"The request does not match Cloudflare's send schema. Check the recipient, sender, subject, and body fields.",
	'10200':
		"The message is over Cloudflare's size limit. Shorten the HTML or text body.",
	'10201':
		'Cloudflare could not determine the message size. Check the body content and send again.',
	'10202':
		'Cloudflare refused the message content. Common causes: a custom header Cloudflare does not accept (Reply-To, From, To, Cc, Bcc, and Subject have their own fields, Message-ID and Date are generated by Cloudflare, and other names must be on its header allowlist or start with X-), a malformed header value such as a List-Unsubscribe without an angle-bracketed https or mailto URI, or a recipient address Cloudflare will not send to.',
}

/**
 * Cloudflare Email Sending answers HTTP 400 when the message itself is
 * unacceptable (invalid schema, too big, no content length, invalid email
 * content). Those are the sender's to fix, unlike auth (401/403), throttling
 * (429), or provider outages (5xx). Returns an actionable message for a 400
 * rejection, or null for any other result.
 * @see https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
 */
export function cloudflareRequestRejectionMessage(
	result: CloudflareSendResult,
): string | null {
	if (result.ok || result.status !== 400) return null
	const code =
		result.providerCode === undefined ? null : `${result.providerCode}`
	const hint =
		(code ? requestRejectionHints[code] : undefined) ??
		'Check the recipients, custom headers, and body.'
	const detail = code
		? `HTTP 400, code ${code}: ${result.error}`
		: `HTTP 400: ${result.error}`
	return `Cloudflare Email Sending rejected the message (${detail}). ${hint}`
}

const apiFieldHeaders: Record<string, string> = {
	from: 'from',
	to: 'to',
	cc: 'cc',
	bcc: 'bcc',
	subject: 'subject',
	'reply-to': 'reply-to',
}

const platformControlledHeaders = new Set([
	'date',
	'message-id',
	'mime-version',
	'content-type',
	'content-transfer-encoding',
	'dkim-signature',
	'return-path',
	'received',
	'feedback-id',
	'tls-required',
	'tls-report-domain',
	'tls-report-submitter',
	'cfbl-address',
	'cfbl-feedback-id',
])

const maxHeaderValueBytes = 2048

/**
 * Cloudflare rejects the whole send for a custom header that belongs to an
 * API field or that the platform generates, so catch those before sending.
 * Returns the first problem, or null when the headers are acceptable.
 * @see https://developers.cloudflare.com/email-service/reference/headers/
 */
export function cloudflareCustomHeaderProblem(
	headers: Record<string, string> | undefined,
): string | null {
	for (const [name, value] of Object.entries(headers ?? {})) {
		const lower = name.toLowerCase()
		if (!/^[A-Za-z0-9_-]{1,100}$/u.test(name)) {
			return `Header name "${name}" is invalid. Use 1 to 100 letters, digits, and hyphens.`
		}
		const apiField = apiFieldHeaders[lower]
		if (apiField) {
			return `Header "${name}" cannot be a custom header. Cloudflare sets it from the dedicated ${apiField} field, so remove it from headers.`
		}
		if (platformControlledHeaders.has(lower) || lower.startsWith('arc-')) {
			return `Header "${name}" cannot be a custom header. Cloudflare generates it, so remove it from headers.`
		}
		if (value.trim().length === 0) {
			return `Header "${name}" has an empty value.`
		}
		if (/[\r\n]/u.test(value)) {
			return `Header "${name}" value must not contain line breaks.`
		}
		if (new TextEncoder().encode(value).byteLength > maxHeaderValueBytes) {
			return `Header "${name}" value exceeds ${maxHeaderValueBytes} bytes.`
		}
	}
	return null
}

/**
 * Cloudflare Email Sending can return `success: true` with every recipient in
 * `permanent_bounces` (HTTP accepted, delivery rejected). Treat total bounce as
 * a send failure so callers do not report success. Partial bounce with at least
 * one delivered/queued recipient stays ok so multi-recipient outbound is not
 * marked failed and retried for addresses that already received the message.
 */
function permanentBounceError(
	to: string | Array<string>,
	result: CloudflareApiEnvelope['result'] | undefined,
): string | null {
	const recipients = (Array.isArray(to) ? to : [to]).map((value) =>
		value.trim().toLowerCase(),
	)
	if (recipients.length === 0) return null
	const permanentBounces = (result?.permanent_bounces ?? []).map((value) =>
		value.trim().toLowerCase(),
	)
	if (permanentBounces.length === 0) return null
	const bounced = new Set(permanentBounces)
	const accepted = new Set(
		[...(result?.delivered ?? []), ...(result?.queued ?? [])].map((value) =>
			value.trim().toLowerCase(),
		),
	)
	const failedRecipients = recipients.filter(
		(recipient) => bounced.has(recipient) && !accepted.has(recipient),
	)
	if (failedRecipients.length === 0) return null
	if (failedRecipients.length !== recipients.length) return null
	return `Cloudflare Email API permanently bounced every recipient (${failedRecipients.join(', ')}).`
}

export async function sendCloudflareEmail(
	config: CloudflareEmailClientConfig,
	message: Omit<
		OutboundEmail,
		'replyTo' | 'headers' | 'attachments' | 'fromName'
	> &
		Partial<
			Pick<OutboundEmail, 'replyTo' | 'headers' | 'attachments' | 'fromName'>
		> &
		OutboundEmailCc,
): Promise<CloudflareSendResult> {
	const normalized: OutboundEmail & OutboundEmailCc = {
		...normalizeEmailPayload({
			...message,
			replyTo: resolveTransactionalSenderReplyTo({
				from: message.from,
				replyTo: message.replyTo,
			}),
			fromName: message.fromName,
			headers: message.headers,
			attachments: message.attachments,
		}),
		...(message.cc && message.cc.length > 0 ? { cc: message.cc } : {}),
	}
	const apiBaseUrl =
		typeof config.apiBaseUrl === 'string' && config.apiBaseUrl.trim().length > 0
			? config.apiBaseUrl.trim()
			: defaultCloudflareApiBaseUrl
	const hasApiConfig =
		typeof config.apiToken === 'string' &&
		config.apiToken.trim().length > 0 &&
		typeof config.accountId === 'string' &&
		config.accountId.trim().length > 0

	if (hasApiConfig) {
		return sendViaCloudflareApi(
			{
				accountId: config.accountId!.trim(),
				apiBaseUrl,
				apiToken: config.apiToken!.trim(),
				retryTransportErrors: config.retryTransportErrors,
			},
			normalized,
		)
	}

	logSkippedEmail('cloudflare-email-unconfigured', normalized)
	return { ok: false, skipped: true }
}
