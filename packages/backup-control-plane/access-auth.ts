import {
	utf8ToBase64Url,
	base64UrlToBytes,
} from '@kody-internal/shared/base64.ts'
import { isRecord } from '@kody-internal/shared/is-record.ts'

import { BackupError } from './backup-policy.ts'
import type { BackupEnvironment } from './backup-types.ts'

const ACCESS_JWT_HEADER = 'cf-access-jwt-assertion'
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000
const JWKS_FORCE_REFRESH_COOLDOWN_MS = 60 * 1000
const CLOCK_SKEW_SECONDS = 60

type Jwk = JsonWebKey & {
	kid?: string
	kty: string
	alg?: string
	use?: string
}

type CachedJwks = {
	fetchedAt: number
	keysByKid: Map<string, CryptoKey>
}

let jwksCache: CachedJwks | null = null
let lastForcedJwksRefreshAt = 0

function decodeJwtPart(part: string): unknown {
	const text = new TextDecoder().decode(base64UrlToBytes(part))
	return JSON.parse(text) as unknown
}

async function importRsaJwk(jwk: Jwk): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'jwk',
		jwk,
		{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
		false,
		['verify'],
	)
}

const JWKS_FETCH_TIMEOUT_MS = 10_000

function isAbortOrTimeoutError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.name === 'AbortError' || error.name === 'TimeoutError')
	)
}

async function loadJwks(
	teamDomain: string,
	fetcher: typeof fetch,
): Promise<Map<string, CryptoKey>> {
	const now = Date.now()
	if (jwksCache !== null && now - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
		return jwksCache.keysByKid
	}
	let response: Response
	try {
		response = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`, {
			signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
		})
	} catch (error) {
		if (isAbortOrTimeoutError(error)) {
			throw new BackupError(
				'access-jwks-fetch-failed',
				'Access JWKS fetch timed out or was aborted',
			)
		}
		throw new BackupError(
			'access-jwks-fetch-failed',
			'Access JWKS fetch failed',
		)
	}
	if (!response.ok) {
		throw new BackupError(
			'access-jwks-fetch-failed',
			`Access JWKS fetch failed (${String(response.status)})`,
		)
	}
	const body = (await response.json()) as unknown
	if (!isRecord(body) || !Array.isArray(body.keys)) {
		throw new BackupError(
			'access-jwks-malformed',
			'Access JWKS response was malformed',
		)
	}
	const keysByKid = new Map<string, CryptoKey>()
	for (const entry of body.keys) {
		if (!isRecord(entry) || typeof entry.kid !== 'string') continue
		if (entry.kty !== 'RSA') continue
		if (entry.alg !== undefined && entry.alg !== 'RS256') continue
		keysByKid.set(entry.kid, await importRsaJwk(entry as unknown as Jwk))
	}
	if (keysByKid.size === 0) {
		throw new BackupError(
			'access-jwks-empty',
			'Access JWKS contained no usable RS256 keys',
		)
	}
	jwksCache = { fetchedAt: now, keysByKid }
	return keysByKid
}

async function verifyWithKey(
	key: CryptoKey,
	headerPart: string,
	payloadPart: string,
	signaturePart: string,
): Promise<boolean> {
	return crypto.subtle.verify(
		{ name: 'RSASSA-PKCS1-v1_5' },
		key,
		base64UrlToBytes(signaturePart),
		new TextEncoder().encode(`${headerPart}.${payloadPart}`),
	)
}

/** Test-only: clear the in-memory JWKS cache between cases. */
export function resetAccessJwksCacheForTests(): void {
	jwksCache = null
	lastForcedJwksRefreshAt = 0
}

export type AccessIdentity = {
	email: string
}

export async function verifyAccessJwt(
	env: BackupEnvironment,
	request: Request,
	fetcher: typeof fetch = fetch,
): Promise<AccessIdentity> {
	const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim()
	const audience = env.ACCESS_APP_AUD?.trim()
	const allowedEmail = env.ACCESS_ALLOWED_EMAIL?.trim()
	if (!teamDomain || !audience || !allowedEmail) {
		throw new BackupError(
			'access-config-missing',
			'Access authentication is not configured',
		)
	}
	const assertion = request.headers.get(ACCESS_JWT_HEADER)
	if (assertion === null || assertion.trim().length === 0) {
		throw new BackupError(
			'access-jwt-missing',
			'Cf-Access-Jwt-Assertion header is required',
		)
	}
	const parts = assertion.split('.')
	if (parts.length !== 3) {
		throw new BackupError('access-jwt-malformed', 'Access JWT is malformed')
	}
	const [headerPart, payloadPart, signaturePart] = parts
	let header: unknown
	let payload: unknown
	try {
		header = decodeJwtPart(headerPart)
		payload = decodeJwtPart(payloadPart)
	} catch {
		throw new BackupError('access-jwt-malformed', 'Access JWT is malformed')
	}
	if (
		!isRecord(header) ||
		header.alg !== 'RS256' ||
		typeof header.kid !== 'string' ||
		header.kid.length === 0
	) {
		throw new BackupError(
			'access-jwt-header-invalid',
			'Access JWT header is invalid',
		)
	}
	if (!isRecord(payload)) {
		throw new BackupError(
			'access-jwt-payload-invalid',
			'Access JWT payload is invalid',
		)
	}
	const keys = await loadJwks(teamDomain, fetcher)
	let verifyingKey = keys.get(header.kid)
	if (verifyingKey === undefined) {
		const now = Date.now()
		if (now - lastForcedJwksRefreshAt < JWKS_FORCE_REFRESH_COOLDOWN_MS) {
			throw new BackupError(
				'access-jwt-unknown-kid',
				'Access JWT kid was not found in JWKS',
			)
		}
		lastForcedJwksRefreshAt = now
		jwksCache = null
		const refreshed = await loadJwks(teamDomain, fetcher)
		verifyingKey = refreshed.get(header.kid)
		if (verifyingKey === undefined) {
			throw new BackupError(
				'access-jwt-unknown-kid',
				'Access JWT kid was not found in JWKS',
			)
		}
	}
	const ok = await verifyWithKey(
		verifyingKey,
		headerPart,
		payloadPart,
		signaturePart,
	)
	if (!ok) {
		throw new BackupError(
			'access-jwt-bad-signature',
			'Access JWT signature is invalid',
		)
	}

	const expectedIss = `https://${teamDomain}`
	if (payload.iss !== expectedIss) {
		throw new BackupError(
			'access-jwt-iss-mismatch',
			'Access JWT issuer is not accepted',
		)
	}

	const nowSeconds = Math.floor(Date.now() / 1000)
	if (
		typeof payload.exp !== 'number' ||
		!Number.isFinite(payload.exp) ||
		payload.exp < nowSeconds - CLOCK_SKEW_SECONDS
	) {
		throw new BackupError('access-jwt-expired', 'Access JWT is expired')
	}
	if (
		typeof payload.iat !== 'number' ||
		!Number.isFinite(payload.iat) ||
		payload.iat > nowSeconds + CLOCK_SKEW_SECONDS
	) {
		throw new BackupError('access-jwt-iat-invalid', 'Access JWT iat is invalid')
	}
	const audiences = Array.isArray(payload.aud)
		? payload.aud
		: typeof payload.aud === 'string'
			? [payload.aud]
			: []
	if (!audiences.some((entry) => entry === audience)) {
		throw new BackupError(
			'access-jwt-aud-mismatch',
			'Access JWT audience is not accepted',
		)
	}
	if (typeof payload.email !== 'string' || payload.email.trim().length === 0) {
		// Cloudflare Access service-token JWTs omit email and set common_name.
		// Accept them for operator automation (seal/drill) when a service-auth
		// Access policy admitted the request; identity is the allowlisted email.
		if (
			typeof payload.common_name === 'string' &&
			payload.common_name.trim().length > 0
		) {
			return { email: allowedEmail }
		}
		throw new BackupError(
			'access-jwt-email-missing',
			'Access JWT email claim is required',
		)
	}
	if (payload.email.trim().toLowerCase() !== allowedEmail.toLowerCase()) {
		throw new BackupError(
			'access-jwt-email-denied',
			'Access JWT email is not allowlisted',
		)
	}
	return { email: payload.email.trim() }
}

export function assertSameOriginMutation(request: Request): void {
	if (request.method !== 'POST') return
	const site = request.headers.get('sec-fetch-site')
	if (site !== 'same-origin') {
		throw new BackupError(
			'csrf-rejected',
			'Sec-Fetch-Site must be same-origin for mutating requests',
		)
	}
}

export function accessForbiddenResponse(error: unknown): Response {
	const code = error instanceof BackupError ? error.code : 'access-unauthorized'
	return Response.json(
		{ error: 'forbidden', code },
		{
			status: 403,
			headers: { 'cache-control': 'no-store' },
		},
	)
}

/** Encode a JWT part for tests / helpers. */
export function encodeJwtPartForTests(value: unknown): string {
	return utf8ToBase64Url(JSON.stringify(value))
}
