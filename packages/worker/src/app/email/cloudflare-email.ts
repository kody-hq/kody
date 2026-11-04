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

type CloudflareSendResult = {
	ok: boolean
	skipped?: boolean
	error?: string
	messageId?: string | null
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

async function sendViaCloudflareApi(
	config: Required<
		Pick<CloudflareEmailClientConfig, 'accountId' | 'apiBaseUrl' | 'apiToken'>
	>,
	message: OutboundEmail,
): Promise<CloudflareSendResult> {
	const endpoint = new URL(
		`client/v4/accounts/${config.accountId}/email/sending/send`,
		normalizeApiBaseUrl(config.apiBaseUrl),
	)
	let response: Response
	try {
		response = await fetch(endpoint.toString(), {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${config.apiToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(toCloudflareSendBody(message)),
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

	const payload = (await response.json()) as CloudflareApiEnvelope
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
		return {
			ok: false,
			error:
				payload?.errors?.[0]?.message ??
				'Cloudflare Email API returned an error response.',
		}
	}

	const bounceError = permanentBounceError(message.to, payload.result)
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
	message: Omit<OutboundEmail, 'replyTo' | 'headers' | 'attachments'> &
		Partial<Pick<OutboundEmail, 'replyTo' | 'headers' | 'attachments'>>,
): Promise<CloudflareSendResult> {
	const normalized = normalizeEmailPayload({
		...message,
		replyTo: resolveTransactionalSenderReplyTo({
			from: message.from,
			replyTo: message.replyTo,
		}),
		headers: message.headers,
		attachments: message.attachments,
	})
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
			},
			normalized,
		)
	}

	logSkippedEmail('cloudflare-email-unconfigured', normalized)
	return { ok: false, skipped: true }
}
