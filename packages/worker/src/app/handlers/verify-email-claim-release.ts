import { type EmailVerificationResult } from '#universal/token-outcomes.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { verifyEmailClaimReleaseToken } from '#app/email-claim-release.ts'

function getVerifyEmailClaimReleaseError(
	reason:
		| 'missing_token'
		| 'invalid_token'
		| 'expired_token'
		| 'not_claimed'
		| 'current_email'
		| 'daily_cap',
) {
	switch (reason) {
		case 'missing_token':
			return 'Verification token is required.'
		case 'invalid_token':
			return 'Release link is invalid.'
		case 'expired_token':
			return 'Release link has expired.'
		case 'not_claimed':
			return 'That address is not claimed by this account.'
		case 'current_email':
			return 'You cannot release the email this account currently uses to sign in.'
		case 'daily_cap':
			return 'You have released the maximum number of addresses for today. Try again tomorrow.'
		default: {
			const unreachable: never = reason
			return unreachable
		}
	}
}

export async function executeVerifyEmailClaimRelease({
	request,
	env,
	token,
}: {
	request: Request
	env: Env
	token: string | null
}): Promise<EmailVerificationResult> {
	const result = await verifyEmailClaimReleaseToken({
		db: env.APP_DB,
		token: token,
	})
	const requestIp = getRequestIp(request) ?? undefined

	if (!result.ok) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'email_claim_release_verify',
			result: result.reason === 'daily_cap' ? 'rate_limited' : 'failure',
			ip: requestIp,
			path: '/verify-email-claim-release',
			reason: result.reason,
		})
		return {
			title: 'Release email',
			status: result.reason === 'daily_cap' ? 429 : 400,
			ok: false,
			error: getVerifyEmailClaimReleaseError(result.reason),
		}
	}

	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'account',
		action: 'email_claim_release_verify',
		result: 'success',
		ip: requestIp,
		path: '/verify-email-claim-release',
		reason: 'released',
	})
	return {
		title: 'Email released',
		ok: true,
		kind: 'email_claim_release',
		message:
			'That former address is no longer tied to this account. It can be used to create a new Kody account.',
		ctaHref: '/account',
		ctaLabel: 'Go to account',
	}
}
