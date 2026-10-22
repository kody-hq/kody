import {
	base64UrlToBytes,
	bytesToBase64Url,
} from '@kody-internal/shared/base64.ts'
import { createCookie } from 'remix/cookie'
import {
	isOauthProviderId,
	type OauthProviderId,
} from '#app/oauth-providers.ts'
import {
	hasFirstTouchAttribution,
	parseFirstTouchAttribution,
	type FirstTouchAttribution,
} from '#universal/first-touch-attribution.ts'

/**
 * Short-lived signed cookie that parks a verified social identity while the
 * person chooses a permanent username. Account creation waits until they
 * submit; the cookie alone never grants a session.
 *
 * Cleared on successful signup, expiry, or when the person abandons the flow.
 * `csrf` is echoed in the choose-username form so the POST must match this
 * cookie (single-use consume clears it).
 *
 * Provider bearer tokens (Discord `guilds.join`) are AES-GCM encrypted with
 * COOKIE_SECRET before the JSON is signed — Remix cookies are signed, not
 * sealed, so a plaintext token would be readable on every same-origin request.
 */
const oauthPendingSignupMaxAgeSeconds = 60 * 10
const accessTokenPurpose = 'oauth-pending-access-token'
const ciphertextVersion = 'v1'
const ivBytes = 12

export type OauthPendingSignup = {
	provider: OauthProviderId
	providerUserId: string
	email: string
	providerUsername: string | null
	displayName: string | null
	suggestedUsername: string
	redirectTo: string | null
	attribution: FirstTouchAttribution | null
	csrf: string
	/** Ephemeral Discord guild.join token; discarded after signup. */
	accessToken: string | null
	issuedAt: number
}

type StoredOauthPendingSignup = {
	v: 1
	provider: OauthProviderId
	providerUserId: string
	email: string
	providerUsername: string | null
	displayName: string | null
	suggestedUsername: string
	redirectTo: string | null
	attribution: FirstTouchAttribution | null
	csrf: string
	/** AES-GCM ciphertext (`v1.<iv>.<ct>`) or null when no token was parked. */
	accessTokenEnc: string | null
	issuedAt: number
}

let pendingCookie: ReturnType<typeof createCookie> | null = null
let pendingSecret: string | null = null

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()
const derivedEncryptionKeyCache = new Map<string, Promise<CryptoKey>>()

export function setOauthPendingSignupSecret(secret: string) {
	if (!secret) {
		throw new Error('Missing COOKIE_SECRET for OAuth pending signup signing.')
	}

	if (pendingCookie && pendingSecret === secret) {
		return
	}

	pendingSecret = secret
	derivedEncryptionKeyCache.clear()
	pendingCookie = createCookie('kody_oauth_pending', {
		httpOnly: true,
		sameSite: 'Lax',
		path: '/',
		maxAge: oauthPendingSignupMaxAgeSeconds,
		secrets: [secret],
	})
}

function getPendingCookie() {
	if (!pendingCookie) {
		throw new Error(
			'OAuth pending signup cookie not configured. Call setOauthPendingSignupSecret.',
		)
	}

	return pendingCookie
}

function requirePendingSecret() {
	if (!pendingSecret) {
		throw new Error(
			'OAuth pending signup cookie not configured. Call setOauthPendingSignupSecret.',
		)
	}
	return pendingSecret
}

function accessTokenContext(provider: OauthProviderId, providerUserId: string) {
	return `${provider}:${providerUserId}`
}

function buildAad(context: string) {
	return textEncoder.encode(
		`kody.${ciphertextVersion}|${accessTokenPurpose}|${context}`,
	)
}

function deriveEncryptionKey(secret: string) {
	const cacheKey = `${accessTokenPurpose}:${secret}`
	const cached = derivedEncryptionKeyCache.get(cacheKey)
	if (cached) return cached

	const derivationPromise = crypto.subtle
		.digest('SHA-256', textEncoder.encode(`${accessTokenPurpose}:${secret}`))
		.then((digest) =>
			crypto.subtle.importKey('raw', digest, 'AES-GCM', false, [
				'encrypt',
				'decrypt',
			]),
		)
		.catch((error) => {
			derivedEncryptionKeyCache.delete(cacheKey)
			throw error
		})
	derivedEncryptionKeyCache.set(cacheKey, derivationPromise)
	return derivationPromise
}

async function encryptAccessToken(token: string, context: string) {
	const key = await deriveEncryptionKey(requirePendingSecret())
	const iv = crypto.getRandomValues(new Uint8Array(ivBytes))
	const ciphertext = await crypto.subtle.encrypt(
		{
			name: 'AES-GCM',
			iv,
			additionalData: buildAad(context),
		},
		key,
		textEncoder.encode(token),
	)
	return `${ciphertextVersion}.${bytesToBase64Url(iv)}.${bytesToBase64Url(
		new Uint8Array(ciphertext),
	)}`
}

async function decryptAccessToken(payload: string, context: string) {
	const parts = payload.split('.')
	if (parts.length !== 3) {
		throw new Error('Invalid encrypted pending OAuth access token.')
	}
	const [version, ivPart, ciphertextPart] = parts
	if (version !== ciphertextVersion || !ivPart || !ciphertextPart) {
		throw new Error('Invalid encrypted pending OAuth access token.')
	}
	const key = await deriveEncryptionKey(requirePendingSecret())
	const plaintext = await crypto.subtle.decrypt(
		{
			name: 'AES-GCM',
			iv: base64UrlToBytes(ivPart),
			additionalData: buildAad(context),
		},
		key,
		base64UrlToBytes(ciphertextPart),
	)
	return textDecoder.decode(plaintext)
}

function parseAttributionField(value: unknown): FirstTouchAttribution | null {
	if (value == null) return null
	if (typeof value !== 'object') return null
	const attribution = parseFirstTouchAttribution({ body: value })
	return hasFirstTouchAttribution(attribution) ? attribution : null
}

function isStoredOauthPendingSignup(
	value: unknown,
): value is StoredOauthPendingSignup {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	const attributionOk =
		record.attribution === undefined ||
		record.attribution === null ||
		typeof record.attribution === 'object'
	return (
		record.v === 1 &&
		typeof record.provider === 'string' &&
		isOauthProviderId(record.provider) &&
		typeof record.providerUserId === 'string' &&
		record.providerUserId.length > 0 &&
		typeof record.email === 'string' &&
		record.email.length > 0 &&
		(record.providerUsername === null ||
			typeof record.providerUsername === 'string') &&
		(record.displayName === null || typeof record.displayName === 'string') &&
		typeof record.suggestedUsername === 'string' &&
		record.suggestedUsername.length > 0 &&
		(record.redirectTo === null || typeof record.redirectTo === 'string') &&
		attributionOk &&
		typeof record.csrf === 'string' &&
		record.csrf.length > 0 &&
		(record.accessTokenEnc === null ||
			typeof record.accessTokenEnc === 'string') &&
		typeof record.issuedAt === 'number' &&
		Number.isFinite(record.issuedAt)
	)
}

async function normalizePending(
	value: StoredOauthPendingSignup,
): Promise<OauthPendingSignup | null> {
	let accessToken: string | null = null
	if (value.accessTokenEnc) {
		try {
			accessToken = await decryptAccessToken(
				value.accessTokenEnc,
				accessTokenContext(value.provider, value.providerUserId),
			)
		} catch {
			return null
		}
	}
	return {
		provider: value.provider,
		providerUserId: value.providerUserId,
		email: value.email,
		providerUsername: value.providerUsername,
		displayName: value.displayName,
		suggestedUsername: value.suggestedUsername,
		redirectTo: value.redirectTo,
		attribution: parseAttributionField(value.attribution),
		csrf: value.csrf,
		accessToken,
		issuedAt: value.issuedAt,
	}
}

export async function createOauthPendingSignupCookie(
	state: OauthPendingSignup,
	secure: boolean,
) {
	const accessTokenEnc = state.accessToken
		? await encryptAccessToken(
				state.accessToken,
				accessTokenContext(state.provider, state.providerUserId),
			)
		: null
	const stored: StoredOauthPendingSignup = {
		v: 1,
		provider: state.provider,
		providerUserId: state.providerUserId,
		email: state.email,
		providerUsername: state.providerUsername,
		displayName: state.displayName,
		suggestedUsername: state.suggestedUsername,
		redirectTo: state.redirectTo,
		attribution: parseAttributionField(state.attribution),
		csrf: state.csrf,
		accessTokenEnc,
		issuedAt: state.issuedAt,
	}
	return getPendingCookie().serialize(JSON.stringify(stored), { secure })
}

export async function destroyOauthPendingSignupCookie(secure: boolean) {
	return getPendingCookie().serialize('', {
		secure,
		maxAge: 0,
		expires: new Date(0),
	})
}

export async function readOauthPendingSignup(
	request: Request,
): Promise<OauthPendingSignup | null> {
	const cookieHeader = request.headers.get('Cookie')
	if (!cookieHeader) return null

	const stored = await getPendingCookie().parse(cookieHeader)
	if (!stored || typeof stored !== 'string') return null

	try {
		const parsed = JSON.parse(stored)
		if (!isStoredOauthPendingSignup(parsed)) return null
		const pending = await normalizePending(parsed)
		if (!pending) return null
		const ageMs = Date.now() - pending.issuedAt
		if (ageMs < 0 || ageMs > oauthPendingSignupMaxAgeSeconds * 1000) {
			return null
		}
		return pending
	} catch {
		return null
	}
}

export const oauthPendingSignupMaxAgeMs = oauthPendingSignupMaxAgeSeconds * 1000
