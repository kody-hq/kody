import { recordWhatsNewVerifiedAccount } from '#worker/newsletter/consent-outbox.ts'
import type { EmailVerificationResult } from '#universal/token-outcomes.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { verifyEmailToken } from '#app/email-verification.ts'
import { scheduleKitSubscriberSync } from '#worker/kit/subscriber-sync.ts'
import { sendFounderWelcomeEmail } from '#app/founder-welcome-email.ts'
import { openVerifiedNoMcpCampaignEvent } from '#app/user-usage-campaign-emails.ts'
import { resolveVerifyEmailSuccessCta } from '#universal/safe-redirect.ts'
import { waitUntil } from 'cloudflare:workers'
import { onEmailVerified } from '#worker/identity/email-verified.ts'
import { recordOnboardingFunnelEvent } from '#worker/identity/onboarding-funnel.ts'

function getVerifyEmailError(
	reason: 'missing_token' | 'invalid_token' | 'expired_token',
) {
	switch (reason) {
		case 'missing_token':
			return 'Verification token is required.'
		case 'invalid_token':
			return 'Verification link is invalid.'
		case 'expired_token':
			return 'Verification link has expired.'
		default: {
			const unreachable: never = reason
			return unreachable
		}
	}
}

export async function executeVerifyEmail({
	request,
	env,
	token,
	redirectTo,
}: {
	request: Request
	env: Env
	token: string | null
	redirectTo?: string | null
}): Promise<EmailVerificationResult> {
	const result = await verifyEmailToken({
		db: env.APP_DB,
		token: token,
	})
	const requestIp = getRequestIp(request) ?? undefined

	if (!result.ok) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'email_verify',
			result: 'failure',
			ip: requestIp,
			path: '/verify-email',
			reason: result.reason,
		})
		return {
			title: 'Verify email',
			status: 400,
			ok: false,
			kind: 'email_verify',
			error: getVerifyEmailError(result.reason),
		}
	}

	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'auth',
		action: 'email_verify',
		result: 'success',
		email: result.email,
		ip: requestIp,
		path: '/verify-email',
	})
	if (result.newlyVerified) {
		recordOnboardingFunnelEvent(env, {
			stage: 'email_verified',
			userId: result.stableUserId,
		})
	}
	if (result.newlyVerified) {
		// The sign-up checkbox only makes a recipient once the address is verified.
		waitUntil(
			recordWhatsNewVerifiedAccount({ env, stableUserId: result.stableUserId }),
		)
		// Kent's welcome goes out now; the connect-agent tip waits for the
		// usage campaign sweep's first-send dwell (about a day) so the two
		// do not land seconds apart.
		waitUntil(
			sendFounderWelcomeEmail({
				env,
				email: result.email,
				stableUserId: result.stableUserId,
				requestUrl: request.url,
			}).catch((error) => {
				console.warn('founder-welcome-email-failed', error)
			}),
		)
		waitUntil(
			openVerifiedNoMcpCampaignEvent({
				env,
				userId: result.stableUserId,
			}),
		)
		scheduleKitSubscriberSync({
			env,
			email: result.email,
			stableUserId: result.stableUserId,
		})
		await onEmailVerified({ env, stableUserId: result.stableUserId })
	}
	const cta = resolveVerifyEmailSuccessCta(redirectTo ?? null)
	return {
		title: 'Email verified',
		ok: true,
		kind: 'email_verify',
		message: cta.message,
		ctaHref: cta.href,
		ctaLabel: cta.label,
	}
}
