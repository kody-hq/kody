import { sendGatedTransactionalEmail } from '#worker/email/transactional-send-policy.ts'
import { buildPlatformFeedbackOutcomeEmail } from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { buildPlatformFeedbackFollowUpMailMeta } from './email-threading.ts'
import { getPlatformFeedbackAcknowledgementMessageId } from './repo.ts'
import {
	describePlatformFeedbackSubmitterContact,
	isPlatformFeedbackSubmitterMailable,
	type PlatformFeedbackSubmitterUnreachableReason,
	readPlatformFeedbackSubmitterMailTarget,
	releasePlatformFeedbackEmailClaim,
} from './submitter-mail.ts'
import {
	platformFeedbackOutcomeStatuses,
	type PlatformFeedbackOutcomeStatus,
	type PlatformFeedbackRecord,
	type PlatformFeedbackStatus,
} from './types.ts'

export const platformFeedbackOutcomeEmailKvKeyPrefix =
	'platform-feedback-outcome-email:v1'
export const platformFeedbackOutcomeEmailClaimTtlSeconds = 30 * 24 * 60 * 60

export function platformFeedbackOutcomeEmailKvKey(input: {
	feedbackId: string
	status: PlatformFeedbackOutcomeStatus
	/** Distinct per stored follow-up note so each one mails exactly once. */
	followUpVersion?: string
}) {
	const base = `${platformFeedbackOutcomeEmailKvKeyPrefix}:${input.feedbackId}:${input.status}`
	return input.followUpVersion
		? `${base}:follow-up:${input.followUpVersion}`
		: base
}

export type PlatformFeedbackOutcomeEmailSkipReason =
	| 'status_mismatch'
	| 'email_not_configured'
	| PlatformFeedbackSubmitterUnreachableReason
	| 'already_sent'
	| 'claim_failed'
	| 'send_failed'
	| 'send_not_delivered'

export type PlatformFeedbackOutcomeEmailResult =
	| { sent: true }
	| { sent: false; reason: PlatformFeedbackOutcomeEmailSkipReason }

function notSent(
	reason: PlatformFeedbackOutcomeEmailSkipReason,
): PlatformFeedbackOutcomeEmailResult {
	return { sent: false, reason }
}

/** Caller-facing explanation for an outcome email that did not go out. */
export function describePlatformFeedbackOutcomeEmailSkip(
	reason: PlatformFeedbackOutcomeEmailSkipReason,
) {
	switch (reason) {
		case 'status_mismatch':
			return 'the feedback status changed before sending'
		case 'email_not_configured':
			return 'transactional email is not configured on this deployment'
		case 'account_not_found':
			return 'the submitter account no longer exists'
		case 'no_email':
			return 'the submitter account has no email address'
		case 'account_suspended':
			return 'the submitter account is suspended'
		case 'email_outbound_paused':
			return "the submitter's outbound email is paused"
		case 'already_sent':
			return 'this exact outcome email was already sent'
		case 'claim_failed':
			return 'the send claim could not be recorded'
		case 'send_failed':
			return 'the email provider request failed'
		case 'send_not_delivered':
			return 'the email provider did not accept the message'
	}
}

export function isPlatformFeedbackOutcomeStatus(
	status: PlatformFeedbackStatus,
): status is PlatformFeedbackOutcomeStatus {
	return (platformFeedbackOutcomeStatuses as ReadonlyArray<string>).includes(
		status,
	)
}

export function shouldSendPlatformFeedbackOutcomeEmail(input: {
	didChangeStatus: boolean
	status: PlatformFeedbackStatus
}): input is { didChangeStatus: true; status: PlatformFeedbackOutcomeStatus } {
	return input.didChangeStatus && isPlatformFeedbackOutcomeStatus(input.status)
}

/** True when outcome email can be sent at all (claim KV, sender, and API credentials). */
export function isPlatformFeedbackOutcomeEmailConfigured(env: Env): boolean {
	return Boolean(
		env.BUNDLE_ARTIFACTS_KV &&
		resolveTransactionalEmailConfig({ env }) &&
		env.CLOUDFLARE_API_TOKEN?.trim() &&
		env.CLOUDFLARE_ACCOUNT_ID?.trim(),
	)
}

export async function sendPlatformFeedbackOutcomeEmail(input: {
	env: Env
	feedback: PlatformFeedbackRecord
	status: PlatformFeedbackOutcomeStatus
	userMessage?: string
	prUrls?: Array<string>
	/**
	 * Follow-up on already-closed feedback: mails follow-up copy and claims a
	 * per-version key instead of the once-per-status outcome key.
	 */
	followUpVersion?: string
}): Promise<PlatformFeedbackOutcomeEmailResult> {
	if (input.feedback.status !== input.status) return notSent('status_mismatch')

	const kv = input.env.BUNDLE_ARTIFACTS_KV
	const emailConfig = resolveTransactionalEmailConfig({ env: input.env })
	if (!kv || !emailConfig) return notSent('email_not_configured')

	const submitter = await readPlatformFeedbackSubmitterMailTarget({
		db: input.env.APP_DB,
		stableUserId: input.feedback.submitterUserId,
	})
	if (!isPlatformFeedbackSubmitterMailable(submitter)) {
		return notSent(
			describePlatformFeedbackSubmitterContact(submitter).unreachableReason ??
				'no_email',
		)
	}

	const key = platformFeedbackOutcomeEmailKvKey({
		feedbackId: input.feedback.id,
		status: input.status,
		followUpVersion: input.followUpVersion,
	})
	if (await kv.get(key)) return notSent('already_sent')

	try {
		await kv.put(key, String(Date.now()), {
			expirationTtl: platformFeedbackOutcomeEmailClaimTtlSeconds,
		})
	} catch (error) {
		console.warn('platform-feedback-outcome-email-claim-failed', {
			feedbackId: input.feedback.id,
			status: input.status,
			error,
		})
		return notSent('claim_failed')
	}

	const email = buildPlatformFeedbackOutcomeEmail({
		appBaseUrl: emailConfig.appBaseUrl,
		status: input.status,
		summary: input.feedback.summary,
		userMessage: input.userMessage,
		prUrls: input.prUrls,
		followUp: Boolean(input.followUpVersion),
	})
	let acknowledgementMessageId: string | null = null
	try {
		acknowledgementMessageId =
			await getPlatformFeedbackAcknowledgementMessageId(
				input.env.APP_DB,
				input.feedback.id,
			)
	} catch (error) {
		console.warn('platform-feedback-acknowledgement-message-id-lookup-failed', {
			feedbackId: input.feedback.id,
			error,
		})
	}
	const followUp = buildPlatformFeedbackFollowUpMailMeta({
		acknowledgementMessageId,
		fallbackSubject: email.subject,
	})
	let sendResult: Awaited<ReturnType<typeof sendGatedTransactionalEmail>>
	try {
		sendResult = await sendGatedTransactionalEmail({
			db: input.env.APP_DB,
			config: {
				accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
				apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
				apiToken: input.env.CLOUDFLARE_API_TOKEN,
			},
			category: 'essential',
			kind: 'platform_feedback_outcome',
			message: {
				to: submitter.email,
				from: emailConfig.fromEmail,
				subject: followUp.subject,
				html: email.html,
				text: email.text,
				...(followUp.headers ? { headers: followUp.headers } : {}),
			},
		})
	} catch (error) {
		console.warn('platform-feedback-outcome-email-send-failed', {
			feedbackId: input.feedback.id,
			status: input.status,
			error,
		})
		await releasePlatformFeedbackEmailClaim(
			kv,
			key,
			'platform-feedback-outcome-email-claim-release-failed',
		)
		return notSent('send_failed')
	}
	if (!sendResult.ok) {
		console.warn('platform-feedback-outcome-email-send-skipped', {
			feedbackId: input.feedback.id,
			status: input.status,
			reason: sendResult.error ?? 'unconfigured',
		})
		await releasePlatformFeedbackEmailClaim(
			kv,
			key,
			'platform-feedback-outcome-email-claim-release-failed',
		)
		return notSent('send_not_delivered')
	}
	return { sent: true }
}
