import { personalOrgIdFromUserRow } from '#worker/orgs/personal-org-id.ts'
import { authOperationResult } from './auth-operation-result.ts'
import { object, parseSafe, string } from 'remix/data-schema'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import {
	createAuthCookie,
	isSecureRequest,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import {
	twoFactorVerificationType,
	verifyTwoFactorCode,
} from '#app/two-factor.ts'
import {
	destroyVerifySessionCookie,
	readVerifySession,
	setVerifySessionSecret,
} from '#app/verify-session.ts'
import {
	checkRateLimit,
	releaseRateLimit,
	twoFactorVerifyRateLimitConfig,
} from '#app/rate-limit.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { touchLastActiveAt } from '#worker/identity/activation-stamps.ts'
import { reconcileSignupWelcomeCreditsIfPending } from '#worker/billing/signup-welcome-credits.ts'

const verifyRequestSchema = object({
	code: string(),
})

export async function verifyWebsiteTwoFactor({
	env,
	request,
	url,
	body,
}: {
	env: Env
	request: Request
	url: URL
	body: Record<string, unknown>
}) {
	setVerifySessionSecret(env.COOKIE_SECRET)
	setAuthSessionSecret(env.COOKIE_SECRET)

	const requestIp = getRequestIp(request) ?? undefined
	const pendingSession = await readVerifySession(request)
	if (!pendingSession) {
		return authOperationResult(
			{
				ok: false,
				code: 'expired',
				error: 'Your verification session expired. Please log in again.',
			},
			401,
		)
	}

	const parsed = parseSafe(verifyRequestSchema, body)
	const code = parsed.success ? parsed.value.code.trim() : ''
	if (!code) {
		return authOperationResult(
			{ ok: false, error: 'Verification code is required.' },
			400,
		)
	}

	// Per-account budget for code guesses. The pending cookie is a
	// stateless 10-minute credential that can be re-minted by logging in
	// again, so the attempt counter has to live outside it.
	const rateLimitKey = `auth:2fa-verify:${pendingSession.stableUserId}`
	const rateLimit = await checkRateLimit(
		env.APP_DB,
		rateLimitKey,
		twoFactorVerifyRateLimitConfig,
	)
	if (!rateLimit.allowed) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'login_2fa_verify',
			result: 'rate_limited',
			email: pendingSession.email,
			ip: requestIp,
			path: url.pathname,
		})
		return authOperationResult(
			{
				ok: false,
				code: 'locked',
				error:
					'Too many verification attempts. Please log in again in a few minutes.',
			},
			{
				status: 429,
				headers: {
					'Retry-After': String(
						rateLimit.retryAfterSeconds ??
							twoFactorVerifyRateLimitConfig.windowSeconds,
					),
					'Set-Cookie': await destroyVerifySessionCookie(
						isSecureRequest(request),
					),
				},
			},
		)
	}

	const db = createDb(env.APP_DB)
	const userRecord = await db.findOne(usersTable, {
		where: { stable_user_id: pendingSession.stableUserId },
	})
	const liveUserRecord = userRecord?.deleted_at ? null : userRecord
	const codeValid =
		liveUserRecord != null &&
		(await verifyTwoFactorCode({
			db: env.APP_DB,
			userId: liveUserRecord.id,
			code,
			type: twoFactorVerificationType,
		}))
	if (!liveUserRecord || !codeValid) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'login_2fa_verify',
			result: 'failure',
			email: pendingSession.email,
			ip: requestIp,
			path: url.pathname,
			reason: 'invalid_code',
		})
		return authOperationResult({ ok: false, error: 'Invalid code.' }, 400)
	}

	// A completed sign-in should not leave the account's remaining
	// attempt budget spent.
	await releaseRateLimit(env.APP_DB, rateLimitKey).catch(() => undefined)

	const secure = isSecureRequest(request)
	const headers = new Headers({
		'Cache-Control': 'no-store',
		'Content-Type': 'application/json; charset=utf-8',
	})
	headers.append(
		'Set-Cookie',
		await createAuthCookie(
			{
				stableUserId: pendingSession.stableUserId,
				email: pendingSession.email,
				rememberMe: pendingSession.rememberMe,
			},
			secure,
		),
	)
	headers.append('Set-Cookie', await destroyVerifySessionCookie(secure))

	await touchLastActiveAt(env.APP_DB, {
		stableUserId: pendingSession.stableUserId,
	})
	await reconcileSignupWelcomeCreditsIfPending({
		db: env.APP_DB,
		userId: personalOrgIdFromUserRow(liveUserRecord),
	})
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'auth',
		action: 'login_2fa_verify',
		result: 'success',
		email: pendingSession.email,
		ip: requestIp,
		path: url.pathname,
	})
	return authOperationResult(
		{ ok: true },
		{
			status: 200,
			headers,
		},
	)
}
