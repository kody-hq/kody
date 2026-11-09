import { waitUntil } from 'cloudflare:workers'
import {
	buildFounderWelcomeEmail,
	founderWelcomeFromName,
} from '#app/email/messages.ts'
import { resolveTransactionalEmailConfig } from '#app/email/sender-config.ts'
import { sendGatedTransactionalEmail } from '#worker/email/transactional-send-policy.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

/** Replies to the founder welcome go to Kent, on the same domain as the sender. */
export function founderWelcomeReplyTo(fromEmail: string) {
	return `kent@${fromEmail.slice(fromEmail.indexOf('@') + 1)}`
}

/**
 * Sends Kent's one-time welcome note when an account first becomes verified
 * (password verify, OAuth signup, or a guest claim into a new account).
 * `users.founder_welcome_sent_at` is the durable once-per-user claim: it is
 * stamped before the send and cleared only if the send fails, so retries,
 * merges into an already welcomed account, and existing accounts (NULL, but
 * never routed here) cannot produce a second copy.
 */
export async function sendFounderWelcomeEmail(input: {
	env: Env
	email: string
	stableUserId: string
	requestUrl?: string | URL | null
	now?: Date
}): Promise<boolean> {
	const db = input.env.APP_DB
	const emailConfig = resolveTransactionalEmailConfig({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	if (!db || !emailConfig) return false

	const claimedAt = (input.now ?? new Date()).toISOString()
	const claim = await db
		.prepare(
			`UPDATE users
			 SET founder_welcome_sent_at = ?
			 WHERE stable_user_id = ? AND founder_welcome_sent_at IS NULL
			   AND email_verified_at IS NOT NULL AND guest_expires_at IS NULL
			   AND deleting_at IS NULL${andLiveDeletedAtSql()}`,
		)
		.bind(claimedAt, input.stableUserId)
		.run()
	if ((claim.meta?.changes ?? 0) !== 1) return false

	const email = buildFounderWelcomeEmail({
		appBaseUrl: emailConfig.appBaseUrl,
		onboardingUrl: new URL('/onboarding', emailConfig.appBaseUrl).toString(),
	})
	let failure: unknown = null
	try {
		const result = await sendGatedTransactionalEmail({
			db,
			config: {
				accountId: input.env.CLOUDFLARE_ACCOUNT_ID,
				apiBaseUrl: input.env.CLOUDFLARE_API_BASE_URL,
				apiToken: input.env.CLOUDFLARE_API_TOKEN,
			},
			category: 'essential',
			kind: 'founder_welcome',
			message: {
				to: input.email,
				from: emailConfig.fromEmail,
				fromName: founderWelcomeFromName,
				replyTo: founderWelcomeReplyTo(emailConfig.fromEmail),
				subject: email.subject,
				html: email.html,
				text: email.text,
			},
		})
		if (result.ok) return true
		failure = result.error ?? 'unconfigured'
	} catch (error) {
		failure = error
	}
	console.warn('founder-welcome-email-send-failed', { error: failure })
	try {
		await db
			.prepare(
				`UPDATE users SET founder_welcome_sent_at = NULL
				 WHERE stable_user_id = ? AND founder_welcome_sent_at = ?${andLiveDeletedAtSql()}`,
			)
			.bind(input.stableUserId, claimedAt)
			.run()
	} catch (error) {
		console.warn('founder-welcome-email-claim-release-failed', error)
	}
	return false
}

/** Fire-and-forget wrapper for request paths that must not wait on the send. */
export function scheduleFounderWelcomeEmail(
	input: Parameters<typeof sendFounderWelcomeEmail>[0],
) {
	waitUntil(
		sendFounderWelcomeEmail(input).catch((error) => {
			console.warn('founder-welcome-email-failed', error)
		}),
	)
}
