/**
 * Stateless mock OAuth provider for PR previews: RFC 8628 device
 * authorization, token (device_code, authorization_code, refresh_token),
 * authorize redirect, and a userinfo endpoint. Every grant is approved at
 * once; a `client_id` containing `deny` gets `access_denied` instead. Tokens
 * are random and never checked beyond their `mock-access-` prefix, so this
 * only stands in for a provider and must never hold real credentials.
 */

const accessTokenPrefix = 'mock-access-'
const refreshTokenPrefix = 'mock-refresh-'
const mockProfile = {
	id: 'mock-user-1',
	login: 'mock-user',
	name: 'Mock User',
	email: 'mock-user@example.com',
}

const endpoints = [
	{
		method: 'POST',
		path: '/device/code',
		note: 'RFC 8628 device authorization',
	},
	{
		method: 'POST',
		path: '/token',
		note: 'device_code, authorization_code, refresh_token',
	},
	{
		method: 'GET',
		path: '/authorize',
		note: 'redirects to redirect_uri with code and state',
	},
	{ method: 'GET', path: '/userinfo', note: 'Bearer mock access token' },
] as const

function json(body: unknown, status = 200) {
	return Response.json(body, {
		status,
		headers: { 'Cache-Control': 'no-store' },
	})
}

function randomToken(prefix: string) {
	return `${prefix}${crypto.randomUUID().replaceAll('-', '')}`
}

async function readForm(request: Request) {
	const type = request.headers.get('content-type') ?? ''
	if (type.includes('application/json')) {
		const body = (await request.json().catch(() => ({}))) as Record<
			string,
			unknown
		>
		return new URLSearchParams(
			Object.entries(body).map(([key, value]) => [key, String(value)]),
		)
	}
	return new URLSearchParams(await request.text())
}

function clientIdFrom(request: Request, form: URLSearchParams) {
	const fromForm = form.get('client_id')
	if (fromForm) return fromForm
	const auth = request.headers.get('authorization') ?? ''
	if (!auth.toLowerCase().startsWith('basic ')) return ''
	try {
		return atob(auth.slice(6).trim()).split(':')[0] ?? ''
	} catch {
		return ''
	}
}

function tokenResponse(scope: string | null) {
	return json({
		access_token: randomToken(accessTokenPrefix),
		refresh_token: randomToken(refreshTokenPrefix),
		token_type: 'Bearer',
		expires_in: 3600,
		...(scope ? { scope } : {}),
	})
}

async function handleDeviceCode(request: Request, url: URL) {
	const form = await readForm(request)
	if (!clientIdFrom(request, form)) {
		return json({ error: 'invalid_client' }, 401)
	}
	const verificationUri = `${url.origin}/device`
	return json({
		device_code: randomToken('mock-device-'),
		user_code: 'MOCK-0000',
		verification_uri: verificationUri,
		verification_uri_complete: `${verificationUri}?user_code=MOCK-0000`,
		expires_in: 600,
		interval: 1,
	})
}

async function handleToken(request: Request) {
	const form = await readForm(request)
	const clientId = clientIdFrom(request, form)
	if (!clientId) return json({ error: 'invalid_client' }, 401)
	const grantType = form.get('grant_type') ?? ''
	const scope = form.get('scope')
	switch (grantType) {
		case 'urn:ietf:params:oauth:grant-type:device_code': {
			if (!form.get('device_code')) {
				return json({ error: 'invalid_request' }, 400)
			}
			if (clientId.includes('deny')) {
				return json({ error: 'access_denied' }, 400)
			}
			return tokenResponse(scope)
		}
		case 'authorization_code': {
			if (!form.get('code')) return json({ error: 'invalid_request' }, 400)
			return tokenResponse(scope)
		}
		case 'refresh_token': {
			if (!form.get('refresh_token')?.startsWith(refreshTokenPrefix)) {
				return json({ error: 'invalid_grant' }, 400)
			}
			return tokenResponse(scope)
		}
		default:
			return json({ error: 'unsupported_grant_type' }, 400)
	}
}

function handleAuthorize(url: URL) {
	const redirectUri = url.searchParams.get('redirect_uri')
	if (!redirectUri) return json({ error: 'invalid_request' }, 400)
	let target: URL
	try {
		target = new URL(redirectUri)
	} catch {
		return json({ error: 'invalid_request' }, 400)
	}
	if (url.searchParams.get('client_id')?.includes('deny')) {
		target.searchParams.set('error', 'access_denied')
	} else {
		target.searchParams.set('code', randomToken('mock-code-'))
	}
	const state = url.searchParams.get('state')
	if (state) target.searchParams.set('state', state)
	return Response.redirect(target.toString(), 302)
}

function handleUserinfo(request: Request) {
	const auth = request.headers.get('authorization') ?? ''
	const token = auth.replace(/^Bearer\s+/i, '').trim()
	if (!token.startsWith(accessTokenPrefix)) {
		return json({ error: 'invalid_token' }, 401)
	}
	return json(mockProfile)
}

export default {
	async fetch(request: Request) {
		const url = new URL(request.url)
		const route = `${request.method} ${url.pathname.replace(/\/+$/, '') || '/'}`
		switch (route) {
			case 'POST /device/code':
				return handleDeviceCode(request, url)
			case 'POST /token':
				return handleToken(request)
			case 'GET /authorize':
				return handleAuthorize(url)
			case 'GET /userinfo':
				return handleUserinfo(request)
			case 'GET /device':
				return new Response(
					'Mock OAuth: device codes are approved automatically.',
				)
			case 'GET /':
			case 'GET /__mocks':
				return json({ service: 'oauth', profile: mockProfile, endpoints })
			default:
				return new Response('Not Found', { status: 404 })
		}
	},
} satisfies ExportedHandler
