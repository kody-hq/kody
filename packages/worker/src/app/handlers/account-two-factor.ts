import {
	checkAuthRateLimit,
	checkRateLimit,
	twoFactorVerifyRateLimitConfig,
} from '#app/rate-limit.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	cancelTwoFactorSetup,
	confirmTwoFactorSetup,
	createTwoFactorSetup,
	disableTwoFactor,
	findTwoFactorVerification,
	isTwoFactorEnabled,
	twoFactorSetupVerificationType,
	twoFactorVerificationType,
	verifyTwoFactorCode,
} from '#app/two-factor.ts'
import { type AccountTwoFactorLoaderData } from '#universal/loader-data.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'

async function limitTwoFactorMutation(
	env: Env,
	request: Request,
	user: AuthenticatedAppUser,
	verifiesCode: boolean,
) {
	const ingress = await checkAuthRateLimit(
		env,
		`auth:ip:${getRequestIp(request) ?? 'unknown'}`,
	)
	const limit =
		!ingress.allowed || !verifiesCode
			? ingress
			: await checkRateLimit(
					env.APP_DB,
					`auth:2fa-manage:${user.sessionUserId}`,
					twoFactorVerifyRateLimitConfig,
				)
	if (limit.allowed) return null
	return {
		ok: false as const,
		error: 'Too many attempts. Please try again later.',
		retryAfter: String(limit.retryAfterSeconds ?? 60),
	}
}

export async function loadTwoFactorStatus(
	db: D1Database,
	userId: number,
): Promise<AccountTwoFactorLoaderData> {
	return {
		ok: true,
		enabled: await isTwoFactorEnabled(db, userId),
	}
}

export async function startAccountTwoFactorSetup({
	env,
	request,
	user,
}: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
}) {
	const limited = await limitTwoFactorMutation(env, request, user, false)
	if (limited) return limited

	const url = new URL(request.url)
	const requestIp = getRequestIp(request) ?? undefined
	// A hijacked session must not be able to swap out the active
	// factor: re-enrollment requires disabling first, which demands
	// a current code.
	if (await isTwoFactorEnabled(env.APP_DB, user.userId)) {
		return {
			ok: false,
			error:
				'Two-factor authentication is already enabled. Disable it first to set up a new authenticator.',
		}
	}
	const { otpUri, secret } = await createTwoFactorSetup({
		db: env.APP_DB,
		userId: user.userId,
		accountName: user.email,
		issuer: url.hostname,
	})
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'account',
		action: 'two_factor_setup_start',
		result: 'success',
		email: user.email,
		ip: requestIp,
		path: '/account/two-factor',
	})
	return { ok: true, otpUri, secret }
}
export async function confirmAccountTwoFactorSetup({
	env,
	request,
	user,
	code: rawCode,
}: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	code: string
}) {
	const limited = await limitTwoFactorMutation(env, request, user, true)
	if (limited) return limited

	const requestIp = getRequestIp(request) ?? undefined
	const code = rawCode.trim()
	if (!code) {
		return { ok: false, error: 'Verification code is required.' }
	}
	// A stale pending row must never replace an already-active
	// factor (same reasoning as the setup guard).
	if (await isTwoFactorEnabled(env.APP_DB, user.userId)) {
		return {
			ok: false,
			error: 'Two-factor authentication is already enabled.',
		}
	}
	const pendingSetup = await findTwoFactorVerification(
		env.APP_DB,
		user.userId,
		twoFactorSetupVerificationType,
	)
	if (!pendingSetup) {
		return { ok: false, error: 'No two-factor setup is in progress.' }
	}
	const codeValid = await verifyTwoFactorCode({
		db: env.APP_DB,
		userId: user.userId,
		code,
		type: twoFactorSetupVerificationType,
	})
	if (!codeValid) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'two_factor_enable',
			result: 'failure',
			email: user.email,
			ip: requestIp,
			path: '/account/two-factor',
			reason: 'invalid_code',
		})
		return { ok: false, error: 'Invalid code.' }
	}
	const promoted = await confirmTwoFactorSetup(env.APP_DB, user.userId)
	if (!promoted) {
		return { ok: false, error: 'No two-factor setup is in progress.' }
	}
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'account',
		action: 'two_factor_enable',
		result: 'success',
		email: user.email,
		ip: requestIp,
		path: '/account/two-factor',
	})
	return await loadTwoFactorStatus(env.APP_DB, user.userId)
}
export async function cancelAccountTwoFactorSetup({
	env,
	request,
	user,
}: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
}) {
	const limited = await limitTwoFactorMutation(env, request, user, false)
	if (limited) return limited

	await cancelTwoFactorSetup(env.APP_DB, user.userId)
	return await loadTwoFactorStatus(env.APP_DB, user.userId)
}
export async function disableAccountTwoFactor({
	env,
	request,
	user,
	code: rawCode,
}: {
	env: Env
	request: Request
	user: AuthenticatedAppUser
	code: string
}) {
	const limited = await limitTwoFactorMutation(env, request, user, true)
	if (limited) return limited

	const requestIp = getRequestIp(request) ?? undefined
	const code = rawCode.trim()
	// Disabling weakens account security, so require a fresh code
	// from the active authenticator (Epic Stack requires recent
	// re-verification; an inline code is the stateless equivalent).
	if (!code) {
		return { ok: false, error: 'Verification code is required.' }
	}
	const codeValid = await verifyTwoFactorCode({
		db: env.APP_DB,
		userId: user.userId,
		code,
		type: twoFactorVerificationType,
	})
	if (!codeValid) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'account',
			action: 'two_factor_disable',
			result: 'failure',
			email: user.email,
			ip: requestIp,
			path: '/account/two-factor',
			reason: 'invalid_code',
		})
		return { ok: false, error: 'Invalid code.' }
	}
	await disableTwoFactor(env.APP_DB, user.userId)
	void logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'account',
		action: 'two_factor_disable',
		result: 'success',
		email: user.email,
		ip: requestIp,
		path: '/account/two-factor',
	})
	return await loadTwoFactorStatus(env.APP_DB, user.userId)
}
