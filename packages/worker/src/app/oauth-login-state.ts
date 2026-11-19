import { createCookie } from 'remix/cookie'
import {
	isOauthProviderId,
	type OauthProviderId,
} from '#app/oauth-providers.ts'

/**
 * Short-lived signed cookie that carries the social-login round-trip state:
 * the CSRF `state` value, the PKCE code verifier, the post-login redirect
 * target, and an optional guest claim.
 * Written when the flow starts and cleared by the callback.
 */
const oauthLoginStateMaxAgeSeconds = 60 * 10

export type OauthLoginState = {
	provider: OauthProviderId
	state: string
	codeVerifier: string
	redirectTo: string | null
	/** Set when the round trip claims a guest account from `/claim/<code>`. */
	guestClaim?: { code: string; username: string | null } | null
}

let stateCookie: ReturnType<typeof createCookie> | null = null
let stateSecret: string | null = null

export function setOauthLoginStateSecret(secret: string) {
	if (!secret) {
		throw new Error('Missing COOKIE_SECRET for OAuth login state signing.')
	}

	if (stateCookie && stateSecret === secret) {
		return
	}

	stateSecret = secret
	stateCookie = createCookie('kody_oauth_login', {
		httpOnly: true,
		sameSite: 'Lax',
		path: '/',
		maxAge: oauthLoginStateMaxAgeSeconds,
		secrets: [secret],
	})
}

function getStateCookie() {
	if (!stateCookie) {
		throw new Error(
			'OAuth login state cookie not configured. Call setOauthLoginStateSecret.',
		)
	}

	return stateCookie
}

function isOauthLoginState(value: unknown): value is OauthLoginState {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	return (
		typeof record.provider === 'string' &&
		isOauthProviderId(record.provider) &&
		typeof record.state === 'string' &&
		record.state.length > 0 &&
		typeof record.codeVerifier === 'string' &&
		record.codeVerifier.length > 0 &&
		(record.redirectTo === null || typeof record.redirectTo === 'string') &&
		isGuestClaimField(record.guestClaim)
	)
}

function isGuestClaimField(value: unknown) {
	if (value === undefined || value === null) return true
	if (typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	return (
		typeof record.code === 'string' &&
		record.code.length > 0 &&
		(record.username === null || typeof record.username === 'string')
	)
}

export async function createOauthLoginStateCookie(
	state: OauthLoginState,
	secure: boolean,
) {
	return getStateCookie().serialize(JSON.stringify(state), { secure })
}

export async function destroyOauthLoginStateCookie(secure: boolean) {
	return getStateCookie().serialize('', {
		secure,
		maxAge: 0,
		expires: new Date(0),
	})
}

export async function readOauthLoginState(
	request: Request,
): Promise<OauthLoginState | null> {
	const cookieHeader = request.headers.get('Cookie')
	if (!cookieHeader) return null

	const stored = await getStateCookie().parse(cookieHeader)
	if (!stored || typeof stored !== 'string') return null

	try {
		const parsed = JSON.parse(stored)
		if (isOauthLoginState(parsed)) return parsed
	} catch {
		return null
	}

	return null
}
