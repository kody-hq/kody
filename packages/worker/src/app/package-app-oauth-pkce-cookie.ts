import { createCookie } from 'remix/cookie'
import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import { bytesToBase64Url } from '@kody-internal/shared/base64.ts'
import {
	packageAppOauthPkceCookieName,
	packageAppOauthPkceCookieNameInsecure,
} from '#universal/package-app-oauth-paths.ts'
import type { PackageAppOauthScope } from '#app/package-app-oauth-scopes.ts'

const pkceSecretPurpose = 'kody-package-app-oauth-pkce:v1'
const pkceMaxAgeSeconds = 600

export type PackageAppOauthPkceState = {
	v: 1
	verifier: string
	state: string
	returnTo: string
	orgUsername: string
	kodyId: string
	scopes: Array<PackageAppOauthScope>
	clientId: string
}

let cached: {
	sourceSecret: string
	secure: ReturnType<typeof createCookie>
	insecure: ReturnType<typeof createCookie>
} | null = null

async function getCookies(env: Env) {
	const secret = env.COOKIE_SECRET?.trim()
	if (!secret) {
		throw new Error('Missing COOKIE_SECRET for package app OAuth PKCE.')
	}
	if (cached?.sourceSecret === secret) return cached
	const derived = await sha256Base64Url(`${pkceSecretPurpose}:${secret}`)
	const shared = {
		httpOnly: true,
		sameSite: 'Lax' as const,
		path: '/',
		maxAge: pkceMaxAgeSeconds,
		secrets: [derived],
	}
	cached = {
		sourceSecret: secret,
		secure: createCookie(packageAppOauthPkceCookieName, {
			...shared,
			secure: true,
		}),
		insecure: createCookie(packageAppOauthPkceCookieNameInsecure, {
			...shared,
		}),
	}
	return cached
}

export function resetPackageAppOauthPkceCookieForTests() {
	cached = null
}

export function createPackageAppOauthCodeVerifier() {
	const bytes = new Uint8Array(32)
	crypto.getRandomValues(bytes)
	return bytesToBase64Url(bytes)
}

export function createPackageAppOauthState() {
	const bytes = new Uint8Array(16)
	crypto.getRandomValues(bytes)
	return bytesToBase64Url(bytes)
}

export async function createPackageAppOauthPkceCookie(input: {
	env: Env
	secure: boolean
	state: PackageAppOauthPkceState
}) {
	const cookies = await getCookies(input.env)
	const cookie = input.secure ? cookies.secure : cookies.insecure
	return await cookie.serialize(JSON.stringify(input.state), {
		secure: input.secure,
		maxAge: pkceMaxAgeSeconds,
	})
}

export async function destroyPackageAppOauthPkceCookie(input: {
	env: Env
	secure: boolean
}) {
	const cookies = await getCookies(input.env)
	const cookie = input.secure ? cookies.secure : cookies.insecure
	return await cookie.serialize('', {
		secure: input.secure,
		maxAge: 0,
		expires: new Date(0),
	})
}

export async function readPackageAppOauthPkceState(input: {
	request: Request
	env: Env
}): Promise<PackageAppOauthPkceState | null> {
	const header = input.request.headers.get('Cookie')
	if (!header) return null
	const cookies = await getCookies(input.env)
	for (const cookie of [cookies.secure, cookies.insecure]) {
		const raw = await cookie.parse(header)
		if (!raw || typeof raw !== 'string') continue
		try {
			const parsed = JSON.parse(raw) as PackageAppOauthPkceState
			if (
				parsed?.v === 1 &&
				typeof parsed.verifier === 'string' &&
				typeof parsed.state === 'string' &&
				typeof parsed.returnTo === 'string' &&
				typeof parsed.orgUsername === 'string' &&
				typeof parsed.kodyId === 'string' &&
				typeof parsed.clientId === 'string' &&
				Array.isArray(parsed.scopes)
			) {
				return parsed
			}
		} catch {
			continue
		}
	}
	return null
}

export async function createS256CodeChallenge(verifier: string) {
	return await sha256Base64Url(verifier)
}
