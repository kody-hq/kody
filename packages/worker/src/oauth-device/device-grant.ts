import { bytesToBase64Url } from '@kody-internal/shared/base64.ts'
import { cliClientIdMetadataPath } from '#worker/cli-client-metadata.ts'

/** RFC 8628 grant type for `/oauth/token`. */
export const deviceCodeGrantType =
	'urn:ietf:params:oauth:grant-type:device_code'

/** How long a device_code and user_code stay usable. */
export const deviceCodeTtlSeconds = 10 * 60

/** Minimum poll interval the device must honor (RFC 8628 default). */
export const devicePollIntervalSeconds = 5

/** RFC 8628 section 3.5: every slow_down adds five seconds to the interval. */
export const deviceSlowDownIncrementSeconds = 5

/** Expired rows stay this long so a late poll still sees `expired_token`. */
export const deviceAuthorizationRetentionSeconds = 24 * 60 * 60

/**
 * Clients allowed to use the device grant, as paths on the app origin (CIMD
 * client ids are `${origin}${path}`). v1 is the official Kody CLI only
 * (ADR 0082). Allowing another public client later means adding its CIMD id
 * here; nothing else in the grant is client-specific.
 */
const deviceGrantClientIdPaths: ReadonlyArray<string> = [
	cliClientIdMetadataPath,
]

export function deviceGrantClientIds(appOrigin: string): Array<string> {
	const origin = new URL(appOrigin).origin
	return deviceGrantClientIdPaths.map((path) => `${origin}${path}`)
}

export function isDeviceGrantClientAllowed(
	appOrigin: string,
	clientId: string | null | undefined,
) {
	if (!clientId) return false
	return deviceGrantClientIds(appOrigin).includes(clientId)
}

/**
 * RFC 8628 section 6.1 alphabet: 20 consonants, no vowels (no words), and no
 * look-alikes such as 0/O or 1/I/L.
 */
export const userCodeAlphabet = 'BCDFGHJKLMNPQRSTVWXZ'
export const userCodeLength = 8

/** A fresh random user code, normalized (no separator). */
export function generateUserCode() {
	const limit = 256 - (256 % userCodeAlphabet.length)
	let code = ''
	while (code.length < userCodeLength) {
		const bytes = crypto.getRandomValues(new Uint8Array(userCodeLength * 2))
		for (const byte of bytes) {
			if (byte >= limit) continue
			code += userCodeAlphabet[byte % userCodeAlphabet.length]
			if (code.length === userCodeLength) break
		}
	}
	return code
}

/**
 * Normalize what a person typed: uppercase, drop spaces and dashes. Returns
 * null unless the result is exactly eight alphabet characters.
 */
export function normalizeUserCode(value: string | null | undefined) {
	if (typeof value !== 'string') return null
	const compact = value.toUpperCase().replace(/[\s-]+/g, '')
	if (compact.length !== userCodeLength) return null
	for (const char of compact) {
		if (!userCodeAlphabet.includes(char)) return null
	}
	return compact
}

/** `BCDFGHJK` -> `BCDF-GHJK` for display. */
export function formatUserCode(code: string) {
	return `${code.slice(0, 4)}-${code.slice(4)}`
}

export function generateDeviceCode() {
	return `kody_dc_${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`
}

export async function hashDeviceCode(deviceCode: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(deviceCode),
	)
	return bytesToBase64Url(new Uint8Array(digest))
}

export async function createServerPkcePair() {
	const verifier = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(verifier),
	)
	return { verifier, challenge: bytesToBase64Url(new Uint8Array(digest)) }
}
