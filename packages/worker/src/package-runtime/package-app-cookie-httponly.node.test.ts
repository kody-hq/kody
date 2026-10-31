import { expect, test } from 'vitest'
import {
	enforcePackageAppCookieHttpOnly,
	isPackageAppAuthCookie,
} from './package-app-cookie-httponly.ts'
import { scrubPackageAppSetCookieDomains } from './package-app-set-cookie.ts'

function responseWithCookies(
	cookies: ReadonlyArray<string>,
	init: ResponseInit = {},
) {
	const headers = new Headers(init.headers)
	for (const cookie of cookies) headers.append('Set-Cookie', cookie)
	return new Response(init.status === 204 ? null : 'ok', {
		...init,
		headers,
	})
}

test('classifies package-app auth cookies with the single naming rule', () => {
	for (const cookieName of [
		'connect.sid',
		'__kapp_0123456789ab_connect.sid',
		'PHPSESSID',
		'JSESSIONID',
		'ASP.NET_SessionId',
		'__session',
		'next-auth.session-token',
		'__Secure-next-auth.session-token',
		'authjs.session-token',
		'sb-project-auth-token',
		'laravel_session',
		'_session_id',
		'session',
		'sessionId',
		'__kapp_0123456789ab_sessionId',
		'idToken',
		'__Host-session',
		'refreshToken',
		'auth',
		'token',
		'jwt',
	]) {
		expect(isPackageAppAuthCookie({ cookieName }), cookieName).toBe(true)
	}
	for (const cookieName of [
		'theme',
		'lang',
		'csrf',
		'csrf_token',
		'xsrf-token',
		'xsrfSession',
		'__Host-__kapp_0123456789ab_theme',
		'my-cookie',
		'httponly',
	]) {
		expect(isPackageAppAuthCookie({ cookieName }), cookieName).toBe(false)
	}

	expect(
		isPackageAppAuthCookie({
			cookieName: 'session',
			clientReadable: ['session'],
		}),
	).toBe(false)
	expect(
		isPackageAppAuthCookie({
			cookieName: '__Host-__kapp_0123456789ab_session',
			clientReadable: ['session'],
		}),
	).toBe(false)
	expect(
		isPackageAppAuthCookie({
			cookieName: 'session',
			clientReadable: ['Session'],
		}),
	).toBe(true)
	expect(
		isPackageAppAuthCookie({
			cookieName: 'session',
			clientReadable: ['theme'],
		}),
	).toBe(true)
})

test('appends HttpOnly without changing the existing cookie attributes', () => {
	const original =
		'session=value; Path=/app; Domain=app.example.test; SameSite=None; Secure; Max-Age=3600'
	const { response, findings } = enforcePackageAppCookieHttpOnly(
		responseWithCookies([original]),
	)
	expect(response.headers.getSetCookie()).toEqual([`${original}; HttpOnly`])
	expect(findings).toEqual([
		{ cookieName: 'session', reason: 'added_httponly' },
	])
})

test('classifies the full cookie name before truncating its finding', () => {
	const cookieName = `__kapp_0123456789ab_${'a'.repeat(130)}_session`
	const result = enforcePackageAppCookieHttpOnly(
		responseWithCookies([`${cookieName}=v; Path=/`]),
	)

	expect(result.response.headers.getSetCookie()).toEqual([
		`${cookieName}=v; Path=/; HttpOnly`,
	])
	expect(result.findings).toEqual([
		{
			cookieName: cookieName.slice(0, 128),
			reason: 'added_httponly',
		},
	])
	expect(result.findings[0]?.cookieName).toHaveLength(128)
})

test('existing HttpOnly attributes are case-insensitive and do not rebuild', () => {
	const response = responseWithCookies([
		'session=value; Path=/; hTtPoNlY; Secure',
	])
	const result = enforcePackageAppCookieHttpOnly(response)
	expect(result.response).toBe(response)
	expect(result.findings).toEqual([])
	expect(result.response.headers.getSetCookie()).toEqual([
		'session=value; Path=/; hTtPoNlY; Secure',
	])
})

test('does not treat a cookie named httponly as an HttpOnly attribute', () => {
	const result = enforcePackageAppCookieHttpOnly(
		responseWithCookies(['httponly=value; Path=/']),
	)
	expect(result.response.headers.getSetCookie()).toEqual([
		'httponly=value; Path=/',
	])
	expect(result.findings).toEqual([
		{ cookieName: 'httponly', reason: 'missing_httponly' },
	])
})

test('handles multiple cookies and never includes their values in findings', () => {
	const result = enforcePackageAppCookieHttpOnly(
		responseWithCookies([
			'session=session-value-private; Path=/',
			'theme=theme-value-private; Path=/',
			'refresh=value-private; HttpOnly; Secure',
		]),
	)
	expect(result.response.headers.getSetCookie()).toEqual([
		'session=session-value-private; Path=/; HttpOnly',
		'theme=theme-value-private; Path=/',
		'refresh=value-private; HttpOnly; Secure',
	])
	expect(result.findings).toEqual([
		{ cookieName: 'session', reason: 'added_httponly' },
		{ cookieName: 'theme', reason: 'missing_httponly' },
	])
	expect(JSON.stringify(result.findings)).not.toContain('private')
})

test('deletion cookies have no finding but auth cookies still gain HttpOnly', () => {
	const result = enforcePackageAppCookieHttpOnly(
		responseWithCookies([
			'theme=; Max-Age=0; Path=/',
			'lang=; Max-Age=-1; Path=/',
			'notice=; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
			'session=; Max-Age=0; Path=/',
		]),
	)
	expect(result.response.headers.getSetCookie()).toEqual([
		'theme=; Max-Age=0; Path=/',
		'lang=; Max-Age=-1; Path=/',
		'notice=; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
		'session=; Max-Age=0; Path=/; HttpOnly',
	])
	expect(result.findings).toEqual([])
})

test('returns the same response when no cookie header changes', () => {
	const response = responseWithCookies(['theme=value; Path=/'])
	const result = enforcePackageAppCookieHttpOnly(response)
	expect(result.response).toBe(response)
	expect(result.findings).toEqual([
		{ cookieName: 'theme', reason: 'missing_httponly' },
	])
})

test('leaves an exempted auth cookie unchanged and records its finding', () => {
	const original = 'session=value; Path=/; SameSite=Lax'
	const response = responseWithCookies([original])
	const result = enforcePackageAppCookieHttpOnly(response, {
		clientReadable: ['session'],
	})
	expect(result.response).toBe(response)
	expect(result.response.headers.getSetCookie()).toEqual([original])
	expect(result.findings).toEqual([
		{ cookieName: 'session', reason: 'missing_httponly' },
	])
})

test('rebuilds a 204 response with a null body', () => {
	const response = responseWithCookies(['session=value; Path=/'], {
		status: 204,
	})
	const result = enforcePackageAppCookieHttpOnly(response)
	expect(result.response.status).toBe(204)
	expect(result.response.body).toBeNull()
	expect(result.response.headers.getSetCookie()).toEqual([
		'session=value; Path=/; HttpOnly',
	])
})

test('preserves the webSocket on a rebuilt handshake response', () => {
	const response = responseWithCookies(['session=value; Path=/'])
	const socket = { accept() {} } as unknown as WebSocket
	Object.defineProperty(response, 'webSocket', {
		value: socket,
		configurable: true,
	})
	const result = enforcePackageAppCookieHttpOnly(response)
	expect(result.response.status).toBe(200)
	expect(result.response.webSocket).toBe(socket)
	expect(result.response.headers.getSetCookie()).toEqual([
		'session=value; Path=/; HttpOnly',
	])
})

test('skips a 101 response without a webSocket', () => {
	const response = {
		status: 101,
		webSocket: undefined,
		headers: new Headers(),
	} as unknown as Response
	const result = enforcePackageAppCookieHttpOnly(response)
	expect(result.response).toBe(response)
	expect(result.findings).toEqual([])
})

test('composes after the package-app Domain scrub', () => {
	const scrubbed = scrubPackageAppSetCookieDomains(
		responseWithCookies([
			'session=value; Domain=kody.run; Path=/; SameSite=Lax',
		]),
		{
			responseHostname: 'demo.kody.run',
			packageAppApexHostnames: ['kody.run'],
		},
	)
	const result = enforcePackageAppCookieHttpOnly(scrubbed.response)
	expect(result.response.headers.getSetCookie()).toEqual([
		'session=value; Path=/; SameSite=Lax; HttpOnly',
	])
	expect(result.findings).toEqual([
		{ cookieName: 'session', reason: 'added_httponly' },
	])
})

test('caps the findings returned for a response at twenty', () => {
	const result = enforcePackageAppCookieHttpOnly(
		responseWithCookies(
			Array.from({ length: 25 }, (_, index) => `theme-${index}=value`),
		),
	)
	expect(result.findings).toHaveLength(20)
})
