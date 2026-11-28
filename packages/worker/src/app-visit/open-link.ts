import {
	base64UrlToBytes,
	bytesToBase64Url,
	utf8ToBase64Url,
} from '@kody-internal/shared/base64.ts'
import { parsePersonId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	isAppVisitSessionCredential,
	type AppVisitSessionCredential,
} from '#worker/app-visit/session-credential.ts'

/**
 * Open links: how an agent opens a hosted package app in its own browser.
 *
 * A browser on a package-app host can only hold that host's visit session
 * cookie, and API tokens are stripped before app code runs. `appOpenLink`
 * therefore authorizes the calling credential the way `appFetch` does and
 * mints a signed URL on the app's host. Opening it exchanges the token for
 * the host-only visit session cookie of that one app, carrying the same
 * person, token scopes, and profile chain. It never mints a Kody account
 * session.
 *
 * The token is a bearer credential in a URL, so it is deliberately weak:
 * five minutes of validity, bound to one app on one host, and burned on
 * first use. Unlike the person handoff, the burn is atomic and fails closed:
 * a link that cannot be recorded as used is refused.
 */

/** Query parameter that carries a freshly minted open-link token. */
export const packageAppOpenLinkQueryParam = '__kody_open_link'

/** How long an open link can be exchanged. */
export const packageAppOpenLinkTtlMs = 5 * 60_000
/** How long the visit session an open link starts lasts. */
export const packageAppOpenLinkSessionTtlMs = 60 * 60_000

const signaturePurpose = 'kody-package-app-open-link:v1'
// Outlives the token so a burned link stays burned for its whole life.
const redemptionRetentionMs = 60_000

export type PackageAppOpenLinkClaims = {
	stableUserId: string
	/** Handle of the org that owns the app. */
	username: string
	kodyId: string
	/** `URL.host` the link was minted for. */
	host: string
	credential: AppVisitSessionCredential
}

type StoredOpenLinkPayload = {
	v: 1
	sub: string
	usr: string
	pkg: string
	host: string
	exp: number
	jti: string
	cred: AppVisitSessionCredential
}

function isStoredOpenLinkPayload(
	value: unknown,
): value is StoredOpenLinkPayload {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	const isText = (field: unknown) =>
		typeof field === 'string' && field.length > 0
	return (
		record.v === 1 &&
		parsePersonId(record.sub) !== null &&
		isText(record.usr) &&
		isText(record.pkg) &&
		isText(record.host) &&
		typeof record.exp === 'number' &&
		Number.isFinite(record.exp) &&
		isText(record.jti) &&
		isAppVisitSessionCredential(record.cred)
	)
}

async function getSigningKey(env: Env) {
	const secret = env.COOKIE_SECRET?.trim()
	if (!secret) {
		throw new Error('Missing COOKIE_SECRET for package app open link signing.')
	}
	return await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	)
}

function signedMessage(payload: string) {
	return new TextEncoder().encode(`${signaturePurpose}.${payload}`)
}

export async function createPackageAppOpenLinkToken(input: {
	env: Env
	claims: PackageAppOpenLinkClaims
	now?: number
}) {
	const now = input.now ?? Date.now()
	const expiresAt = now + packageAppOpenLinkTtlMs
	const payload = utf8ToBase64Url(
		JSON.stringify({
			v: 1,
			sub: input.claims.stableUserId,
			usr: input.claims.username,
			pkg: input.claims.kodyId,
			host: input.claims.host,
			exp: expiresAt,
			jti: crypto.randomUUID(),
			cred: input.claims.credential,
		} satisfies StoredOpenLinkPayload),
	)
	const signature = await crypto.subtle.sign(
		'HMAC',
		await getSigningKey(input.env),
		signedMessage(payload),
	)
	return {
		token: `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`,
		expiresAt,
	}
}

function rejected(reason: string) {
	console.warn('Package app open link rejected.', { reason })
	return null
}

/**
 * Validate an open-link token for one app on one host and burn it.
 *
 * The app and host binding is checked before the burn, so a link opened on
 * the wrong address is refused without spending it. The burn is one D1 insert,
 * so of several concurrent exchanges exactly one wins; a failing insert
 * refuses the link.
 */
export async function consumePackageAppOpenLinkToken(input: {
	env: Env
	token: string
	expected: Pick<PackageAppOpenLinkClaims, 'username' | 'kodyId' | 'host'>
	now?: number
}): Promise<PackageAppOpenLinkClaims | null> {
	const now = input.now ?? Date.now()
	const [payload, signature, ...rest] = input.token.split('.')
	if (!payload || !signature || rest.length > 0) return rejected('malformed')

	const signingKey = await getSigningKey(input.env)
	let signatureValid: boolean
	try {
		signatureValid = await crypto.subtle.verify(
			'HMAC',
			signingKey,
			base64UrlToBytes(signature),
			signedMessage(payload),
		)
	} catch {
		return rejected('signature')
	}
	if (!signatureValid) return rejected('signature')

	let parsed: unknown
	try {
		parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)))
	} catch {
		return rejected('payload')
	}
	if (!isStoredOpenLinkPayload(parsed)) return rejected('payload')
	if (parsed.exp <= now || parsed.exp > now + packageAppOpenLinkTtlMs) {
		return rejected('expired')
	}
	if (
		parsed.usr.toLowerCase() !== input.expected.username.toLowerCase() ||
		parsed.pkg.toLowerCase() !== input.expected.kodyId.toLowerCase() ||
		parsed.host.toLowerCase() !== input.expected.host.toLowerCase()
	) {
		return rejected('app')
	}

	try {
		const expiresAt = new Date(parsed.exp + redemptionRetentionMs).toISOString()
		const [, burned] = await input.env.APP_DB.batch([
			input.env.APP_DB.prepare(
				`DELETE FROM package_app_open_link_redemptions WHERE expires_at <= ?`,
			).bind(new Date(now).toISOString()),
			// Atomic single use: only one concurrent exchange inserts the row.
			input.env.APP_DB.prepare(
				`INSERT INTO package_app_open_link_redemptions (jti, expires_at)
				 VALUES (?, ?) ON CONFLICT (jti) DO NOTHING`,
			).bind(parsed.jti, expiresAt),
		])
		if ((burned?.meta.changes ?? 0) !== 1) return rejected('replay')
	} catch (error) {
		console.warn('Package app open link replay check failed.', error)
		return null
	}

	return {
		stableUserId: parsed.sub,
		username: parsed.usr,
		kodyId: parsed.pkg,
		host: parsed.host,
		credential: parsed.cred,
	}
}
