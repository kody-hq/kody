import { authOperationResult } from './auth-operation-result.ts'
import { createOauthSignupAccount } from './oauth-signup-account.ts'
import {
	createAuthCookie,
	destroyAuthCookie,
	isSecureRequest,
	readAuthSessionResult,
} from '#app/auth-session.ts'
import {
	destroyOauthPendingSignupCookie,
	readOauthPendingSignup,
	setOauthPendingSignupSecret,
} from '#app/oauth-pending-signup.ts'
import { isTwoFactorEnabled } from '#app/two-factor.ts'
import {
	createVerifySessionCookie,
	setVerifySessionSecret,
} from '#app/verify-session.ts'
import { loadPersonalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { withAccountCreatedQuery } from '#universal/fathom-events.ts'
import { serializeReferralCookie } from '#universal/referral-cookie.ts'
import {
	defaultPostVerificationRedirect,
	normalizeRedirectTo,
	resolvePostAuthLandingPath,
} from '#universal/safe-redirect.ts'
import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { reconcileSignupWelcomeCreditsIfPending } from '#worker/billing/signup-welcome-credits.ts'
import { touchLastActiveAt } from '#worker/identity/activation-stamps.ts'
import {
	getEffectiveUsernameValidationError,
	normalizeUsername,
	usernameTakenError,
} from '#worker/identity/username.ts'
import {
	personIdFromStored,
	personalOrgId,
} from '@kody-internal/shared/owner-person-ids.ts'

function appendCookies(headers: Headers, cookies: Array<string>) {
	for (const cookie of cookies) {
		headers.append('Set-Cookie', cookie)
	}
}

export async function completeOauthPendingSignup({
	env,
	request,
	body,
}: {
	env: Env
	request: Request
	body: Record<string, unknown>
}) {
	setOauthPendingSignupSecret(env.COOKIE_SECRET)
	const secure = isSecureRequest(request)
	const clearPending = await destroyOauthPendingSignupCookie(secure)
	const requestIp = getRequestIp(request) ?? undefined
	const url = new URL(request.url)
	const { session } = await readAuthSessionResult(request)

	if (session) {
		return authOperationResult(
			{
				ok: false as const,
				error: 'Already signed in.',
				code: 'already_signed_in',
			},
			{ status: 400, headers: { 'Set-Cookie': clearPending } },
		)
	}

	const pending = await readOauthPendingSignup(request)
	if (!pending) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'oauth_signup',
			result: 'failure',
			ip: requestIp,
			path: url.pathname,
			reason: 'pending_missing_or_expired',
		})
		return authOperationResult(
			{
				ok: false as const,
				error:
					'Your sign-up session expired. Sign in with your provider again to choose a username.',
				code: 'pending_expired' as const,
			},
			{ status: 401, headers: { 'Set-Cookie': clearPending } },
		)
	}

	const csrf =
		typeof body.csrf === 'string'
			? body.csrf
			: typeof body.pendingCsrf === 'string'
				? body.pendingCsrf
				: ''
	if (!csrf || csrf !== pending.csrf) {
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'oauth_signup',
			result: 'failure',
			email: pending.email,
			ip: requestIp,
			path: url.pathname,
			reason: 'pending_csrf_mismatch',
		})
		return authOperationResult(
			{
				ok: false as const,
				error: 'Your sign-up session is invalid. Please try again.',
				code: 'pending_csrf' as const,
			},
			{ status: 403, headers: { 'Set-Cookie': clearPending } },
		)
	}

	const username = normalizeUsername(body.username)
	const usernameError = await getEffectiveUsernameValidationError(username, env)
	if (usernameError) {
		// Keep the pending cookie so they can fix the name without re-OAuth.
		return authOperationResult(
			{ ok: false as const, error: usernameError, code: 'invalid_username' },
			{ status: 400 },
		)
	}

	const created = await createOauthSignupAccount({
		env,
		provider: pending.provider,
		providerUserId: pending.providerUserId,
		providerDisplayName: pending.providerUsername ?? pending.displayName,
		email: pending.email,
		username,
		attribution: pending.attribution,
		accessToken: pending.accessToken,
		requestIp,
		path: url.pathname,
		cookieHeader: request.headers.get('Cookie'),
		searchParams: url.searchParams,
	})

	if (!created.ok) {
		if (
			created.reason === 'invalid_username' ||
			created.reason === 'username_exists'
		) {
			return authOperationResult(
				{
					ok: false as const,
					error:
						created.reason === 'username_exists'
							? usernameTakenError(username)
							: ((await getEffectiveUsernameValidationError(username, env)) ??
								'Invalid username.'),
					code: created.reason,
				},
				{ status: created.reason === 'username_exists' ? 409 : 400 },
			)
		}
		void logAuditEvent({
			db: auditDatabaseFromEnv(env),
			category: 'auth',
			action: 'oauth_signup',
			result: 'failure',
			email: pending.email,
			ip: requestIp,
			path: url.pathname,
			reason: created.reason,
		})
		return authOperationResult(
			{
				ok: false as const,
				error: 'We could not create your account. Please try again.',
				code: 'account_error' as const,
			},
			{ status: 500, headers: { 'Set-Cookie': clearPending } },
		)
	}

	const redirectTo = normalizeRedirectTo(pending.redirectTo)
	const rawPostLoginPath = redirectTo ?? defaultPostVerificationRedirect
	const postLoginPath =
		resolvePostAuthLandingPath(rawPostLoginPath) ?? rawPostLoginPath
	const destination = withAccountCreatedQuery(postLoginPath)
	const stableUserId = personalOrgId(
		personIdFromStored(created.user.stable_user_id),
	)

	const headers = new Headers()
	appendCookies(headers, [clearPending])

	if (await isTwoFactorEnabled(env.APP_DB, created.user.id)) {
		setVerifySessionSecret(env.COOKIE_SECRET)
		const verifyCookie = await createVerifySessionCookie(
			{
				stableUserId,
				email: created.user.email,
				rememberMe: false,
			},
			secure,
		)
		appendCookies(headers, [verifyCookie, await destroyAuthCookie(secure)])
		headers.append(
			'Set-Cookie',
			serializeReferralCookie({ code: null, secure }),
		)
		return authOperationResult(
			{
				ok: true as const,
				requiresTwoFactor: true as const,
				redirectTo: redirectTo
					? `/verify?redirectTo=${encodeURIComponent(redirectTo)}`
					: '/verify',
			},
			{ status: 200, headers },
		)
	}

	const sessionCookie = await createAuthCookie(
		{ stableUserId, email: created.user.email, rememberMe: false },
		secure,
	)
	await touchLastActiveAt(env.APP_DB, { stableUserId })
	await reconcileSignupWelcomeCreditsIfPending({
		db: env.APP_DB,
		userId: await loadPersonalOrgIdForPerson(
			env.APP_DB,
			personIdFromStored(created.user.stable_user_id),
		),
	})
	appendCookies(headers, [
		sessionCookie,
		serializeReferralCookie({ code: null, secure }),
	])

	return authOperationResult(
		{
			ok: true as const,
			requiresTwoFactor: false as const,
			redirectTo: destination,
			username: created.user.username,
		},
		{ status: 200, headers },
	)
}

/** Restart sign-up without dropping a pending OAuth authorization. */
export function buildSignupRestartPath(redirectTo: string | null | undefined) {
	const safeRedirectTo = normalizeRedirectTo(redirectTo)
	return safeRedirectTo
		? `/signup?${new URLSearchParams({ redirectTo: safeRedirectTo })}`
		: '/signup'
}

export async function loadOauthPendingSignupPage({
	env,
	request,
	fallbackRedirectTo = null,
}: {
	env: Env
	request: Request
	/** Unsigned query copy, used only when the pending cookie is gone. */
	fallbackRedirectTo?: string | null
}) {
	setOauthPendingSignupSecret(env.COOKIE_SECRET)
	const secure = isSecureRequest(request)
	const { session } = await readAuthSessionResult(request)
	if (session) {
		return {
			ok: false as const,
			code: 'already_signed_in' as const,
			redirectTo: '/account',
		}
	}

	const pending = await readOauthPendingSignup(request)
	if (!pending) {
		return {
			ok: false as const,
			code: 'pending_expired' as const,
			redirectTo: buildSignupRestartPath(fallbackRedirectTo),
			clearCookie: await destroyOauthPendingSignupCookie(secure),
		}
	}

	return {
		ok: true as const,
		csrf: pending.csrf,
		suggestedUsername: pending.suggestedUsername,
		email: pending.email,
		provider: pending.provider,
		providerUsername: pending.providerUsername,
		displayName: pending.displayName,
		redirectTo: pending.redirectTo,
	}
}
