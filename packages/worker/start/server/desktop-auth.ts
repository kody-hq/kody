import {
	auditDatabaseFromEnv,
	getRequestIp,
	logAuditEvent,
} from '#worker/audit-log.ts'
import { createServerFn } from '@tanstack/react-start'
import { redirect } from '@tanstack/react-router'
import {
	parseDesktopAuthRequest,
	desktopAuthHash,
	desktopAuthSecret,
} from '#app/desktop-auth-request.ts'
import { getRequest } from '@tanstack/react-start/server'
import { getStartRequestEnv } from './request-env.ts'
import { withWebsiteRead, withWebsiteMutation } from './mutation-context.ts'
import { publicAuthContext } from './auth-mutation-context.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	readParsedAuthSession,
	getAuthSessionExpiresAtMs,
	setAuthSessionSecret,
	createAuthCookie,
	isSecureRequest,
} from '#app/auth-session.ts'
import { isCredentialInvalidatedByStoredPasswordChange } from '#worker/password-change-lockout.ts'

export const loadDesktopLogin = createServerFn({ method: 'GET' })
	.validator(parseDesktopAuthRequest)
	.handler(async ({ data }) => {
		const env = getStartRequestEnv()
		const request = getRequest()
		setAuthSessionSecret(env.COOKIE_SECRET)
		if (!(await readAuthenticatedAppUser(request, env))) {
			const returnTo = `/desktop/login?${new URLSearchParams(data)}`
			throw redirect({
				href: `/${data.mode}?redirectTo=${encodeURIComponent(returnTo)}`,
				statusCode: 302,
			})
		}
		return withWebsiteRead({}, async ({ user }) => ({
			email: user.email,
			personId: user.sessionUserId,
		}))
	})
export const approveDesktopLogin = createServerFn({ method: 'POST' })
	.validator((input: unknown) => {
		const request = parseDesktopAuthRequest(input)
		const personId = (input as { personId?: unknown }).personId
		if (typeof personId !== 'string' || !/^[a-f0-9]{64}$/.test(personId))
			throw new Error('Please refresh this page and try again.')
		return { ...request, personId }
	})
	.handler(async ({ data }) => {
		await publicAuthContext()
		return withWebsiteMutation({}, async ({ request, env, user }) => {
			if (data.personId !== user.sessionUserId)
				throw new Error(
					'Your browser account changed. Please refresh this page and try again.',
				)
			const parsed = await readParsedAuthSession(request)
			if (!parsed?.issuedAt) throw new Error('Please sign in again.')
			const code = desktopAuthSecret()
			const now = Date.now()
			await env.APP_DB.prepare(
				'DELETE FROM desktop_login_grants WHERE expires_at < ?',
			)
				.bind(now)
				.run()
			await env.APP_DB.prepare(
				'INSERT INTO desktop_login_grants (code_hash, challenge, person_id, session_issued_at, session_expires_at, remember_me, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
			)
				.bind(
					await desktopAuthHash(code),
					data.challenge,
					user.sessionUserId,
					parsed.issuedAt,
					getAuthSessionExpiresAtMs({
						rememberMe: parsed.session.rememberMe,
						issuedAt: parsed.issuedAt,
					}),
					parsed.session.rememberMe ? 1 : 0,
					now + 90_000,
				)
				.run()
			const callback = new URL(data.callback)
			callback.searchParams.set('code', code)
			callback.searchParams.set('state', data.state)
			return { callback: callback.href }
		})
	})
export async function desktopSessionHttp({ request }: { request: Request }) {
	const env = getStartRequestEnv()
	const headers = { 'Cache-Control': 'private, no-store' }
	const reject = () =>
		Response.json(
			{ error: 'Desktop sign-in expired. Please try again.' },
			{ status: 400, headers },
		)
	if (
		request.headers.get('Content-Type')?.split(';')[0]?.trim() !==
			'application/json' ||
		(request.headers.has('Origin') &&
			request.headers.get('Origin') !== new URL(request.url).origin)
	)
		return reject()
	let data: { code?: unknown; verifier?: unknown }
	try {
		data = await request.json()
	} catch {
		return reject()
	}
	if (
		typeof data?.code !== 'string' ||
		!/^[A-Za-z0-9_-]{43}$/.test(data.code) ||
		typeof data.verifier !== 'string' ||
		!/^[A-Za-z0-9_-]{43}$/.test(data.verifier)
	)
		return reject()
	const now = Date.now()
	const grant = await env.APP_DB.prepare(
		'DELETE FROM desktop_login_grants WHERE code_hash = ? AND challenge = ? AND expires_at >= ? RETURNING *',
	)
		.bind(
			await desktopAuthHash(data.code),
			await desktopAuthHash(data.verifier),
			now,
		)
		.first<{
			person_id: string
			session_issued_at: number
			session_expires_at: number
			remember_me: number
		}>()
	if (!grant || grant.session_expires_at < now) return reject()
	const user = await env.APP_DB.prepare(
		'SELECT email, password_changed_at FROM users WHERE stable_user_id = ? AND deleted_at IS NULL AND deleting_at IS NULL AND suspended_at IS NULL',
	)
		.bind(grant.person_id)
		.first<{ email: string; password_changed_at: string | null }>()
	if (
		!user ||
		isCredentialInvalidatedByStoredPasswordChange({
			issuedAtMs: grant.session_issued_at,
			storedPasswordChangedAt: user.password_changed_at,
		})
	)
		return reject()
	setAuthSessionSecret(env.COOKIE_SECRET)
	const cookie = await createAuthCookie(
		{
			stableUserId: grant.person_id,
			email: user.email,
			rememberMe: grant.remember_me === 1,
		},
		isSecureRequest(request),
	)
	await logAuditEvent({
		db: auditDatabaseFromEnv(env),
		category: 'auth',
		action: 'login',
		result: 'success',
		email: user.email,
		ip: getRequestIp(request) ?? undefined,
		path: '/desktop/session',
	})
	return new Response(null, {
		status: 204,
		headers: { ...headers, 'Set-Cookie': cookie },
	})
}
