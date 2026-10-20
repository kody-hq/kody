import { sendGatedTransactionalEmail } from '#worker/email/transactional-send-policy.ts'
import { buildPlatformFeedbackOutcomeEmail } from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import {
	isPlatformFeedbackSubmitterMailable,
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
}) {
	return `${platformFeedbackOutcomeEmailKvKeyPrefix}:${input.feedbackId}:${input.status}`
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

export async function sendPlatformFeedbackOutcomeEmail(input: {
	env: Env
	feedback: PlatformFeedbackRecord
	status: PlatformFeedbackOutcomeStatus
	userMessage?: string
	prUrls?: Array<string>
}): Promise<boolean> {
	if (input.feedback.status !== input.status) return false

	const kv = input.env.BUNDLE_ARTIFACTS_KV
	const emailConfig = resolveTransactionalEmailConfig({ env: input.env })
	if (!kv || !emailConfig) return false

	const submitter = await readPlatformFeedbackSubmitterMailTarget({
		db: input.env.APP_DB,
		stableUserId: input.feedback.submitterUserId,
	})
	if (!isPlatformFeedbackSubmitterMailable(submitter)) {
		return false
	}

	const key = platformFeedbackOutcomeEmailKvKey({
		feedbackId: input.feedback.id,
		status: input.status,
	})
	if (await kv.get(key)) return false

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
		return false
	}

	const email = buildPlatformFeedbackOutcomeEmail({
		appBaseUrl: emailConfig.appBaseUrl,
		status: input.status,
		summary: input.feedback.summary,
		userMessage: input.userMessage,
		prUrls: input.prUrls,
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
				subject: email.subject,
				html: email.html,
				text: email.text,
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
		return false
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
		return false
	}
	return true
}
