import { createCookie } from 'remix/cookie'
import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import { parsePersonId } from '@kody-internal/shared/owner-person-ids.ts'

/**
 * Host-only session for one package app on a package-app origin.
 *
 * Shared hosts (`{username}.kody.run`) serve many apps under
 * `/packages/{leaf}`. `__Host-` cookies must use `Path=/` and cannot set
 * `Domain`, so path scoping is unavailable. Sessions are therefore scoped by
 * cookie *name*: `__Host-kody_pkg_session_<sha256(leaf)[0:12]>` (same pattern
 * as package-app access tickets). Logout clears only that app's cookie.
 *
 * Verified custom domains keep working the same way: one app identity maps to
 * one hashed cookie name on that host.
 *
 * This cookie is deliberately *not* `kody_session`:
 *
 * - a different name family, so the app origin's session parser never sees it;
 * - a different signing secret (derived from `COOKIE_SECRET` with a purpose
 *   label), so a value signed for this cookie can never verify as an app
 *   session even if it were replayed under the other name;
 * - a different payload shape, so it cannot satisfy the app session schema.
 *
 * On secure requests the cookie is named with the `__Host-` prefix, which
 * browsers only accept when it is `Secure`, has no `Domain` attribute, and
 * has `Path=/`. Plain-HTTP local development falls back to an unprefixed name
 * because browsers refuse `__Host-` cookies on insecure origins.
 *
 * Lifetime matches the remaining `kody_session` that minted the handoff or
 * OAuth exchange, not a fixed cap.
 *
 * Pre-#3890 host-wide `__Host-kody_pkg_session` cookies are still accepted as
 * a read fallback so existing sessions keep working until the next
 * login/handoff (which writes a per-app cookie and clears the legacy name) or
 * logout (which clears both the per-app name and the legacy name).
 */

const securePackageAppSessionCookiePrefix = '__Host-kody_pkg_session_'
const insecurePackageAppSessionCookiePrefix = 'kody_pkg_session_'
/** Pre-per-app host-wide names (read fallback + clear on write/logout). */
const legacySecurePackageAppSessionCookieName = '__Host-kody_pkg_session'
const legacyInsecurePackageAppSessionCookieName = 'kody_pkg_session'
/** Fallback Max-Age for handoff tokens that omit `sessExp`. */
const legacyPackageAppSessionMaxAgeSeconds = 60 * 60 * 12
const packageAppSessionSecretPurpose = 'kody-package-app-session:v2'

export type PackageAppSession = {
	stableUserId: string
	username: string
}

type StoredPackageAppSessionV2 = {
	v: 2
	stableUserId: string
	pkgUsername: string
	issuedAt: number
	expiresAt?: number
}

type StoredPackageAppSessionV3 = {
	v: 3
	stableUserId: string
	pkgUsername: string
	/** Lowercased package leaf this cookie authorizes. */
	app: string
	issuedAt: number
	expiresAt?: number
}

type StoredPackageAppSession =
	| StoredPackageAppSessionV2
	| StoredPackageAppSessionV3

export type ParsedPackageAppSession = {
	session: PackageAppSession
	issuedAt: number
	expiresAt?: number
}

export function remainingCookieMaxAgeSeconds(
	expiresAt: number,
	now = Date.now(),
) {
	const remaining = Math.floor((expiresAt - now) / 1000)
	return remaining > 0 ? remaining : null
}

let cachedSecret: {
	sourceSecret: string
	derivedSecret: string
} | null = null

const cookieCache = new Map<string, ReturnType<typeof createCookie>>()

async function getDerivedSecret(env: Env) {
	const secret = env.COOKIE_SECRET?.trim()
	if (!secret) {
		throw new Error('Missing COOKIE_SECRET for package app session signing.')
	}
	if (cachedSecret?.sourceSecret === secret) return cachedSecret.derivedSecret
	const derivedSecret = await sha256Base64Url(
		`${packageAppSessionSecretPurpose}:${secret}`,
	)
	cachedSecret = { sourceSecret: secret, derivedSecret }
	cookieCache.clear()
	return derivedSecret
}

async function packageAppSessionCookieName(slug: string, secure: boolean) {
	const appTag = (await sha256Base64Url(slug.trim().toLowerCase())).slice(0, 12)
	return `${secure ? securePackageAppSessionCookiePrefix : insecurePackageAppSessionCookiePrefix}${appTag}`
}

async function getNamedPackageAppSessionCookie(
	env: Env,
	name: string,
	secure: boolean,
) {
	const derivedSecret = await getDerivedSecret(env)
	const cacheKey = `${secure ? 's' : 'i'}:${name}:${derivedSecret}`
	const cached = cookieCache.get(cacheKey)
	if (cached) return cached
	const cookie = createCookie(name, {
		httpOnly: true,
		sameSite: 'Lax',
		path: '/',
		maxAge: legacyPackageAppSessionMaxAgeSeconds,
		secrets: [derivedSecret],
		...(secure ? { secure: true } : {}),
	})
	cookieCache.set(cacheKey, cookie)
	return cookie
}

async function getPackageAppSessionCookie(
	env: Env,
	slug: string,
	secure: boolean,
) {
	return await getNamedPackageAppSessionCookie(
		env,
		await packageAppSessionCookieName(slug, secure),
		secure,
	)
}

async function getLegacyPackageAppSessionCookie(env: Env, secure: boolean) {
	return await getNamedPackageAppSessionCookie(
		env,
		secure
			? legacySecurePackageAppSessionCookieName
			: legacyInsecurePackageAppSessionCookieName,
		secure,
	)
}

/** Clears the derived cookie cache so tests can swap secrets. */
export function resetPackageAppSessionCookieForTests() {
	cachedSecret = null
	cookieCache.clear()
}

function isStoredPackageAppSession(
	value: unknown,
): value is StoredPackageAppSession {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	const baseOk =
		parsePersonId(record.stableUserId) !== null &&
		typeof record.pkgUsername === 'string' &&
		record.pkgUsername.length > 0 &&
		typeof record.issuedAt === 'number' &&
		Number.isFinite(record.issuedAt) &&
		record.issuedAt > 0 &&
		(record.expiresAt === undefined ||
			(typeof record.expiresAt === 'number' &&
				Number.isFinite(record.expiresAt) &&
				record.expiresAt > 0))
	if (!baseOk) return false
	if (record.v === 3) {
		return typeof record.app === 'string' && record.app.length > 0
	}
	return record.v === 2
}

function expireCookieHeader(
	cookie: ReturnType<typeof createCookie>,
	secure: boolean,
) {
	return cookie.serialize('', {
		secure,
		maxAge: 0,
		expires: new Date(0),
	})
}

/** Clears the pre-per-app host-wide session cookie names. */
export async function destroyLegacyPackageAppSessionCookies(input: {
	env: Env
	secure: boolean
}) {
	const cookie = await getLegacyPackageAppSessionCookie(input.env, input.secure)
	return [await expireCookieHeader(cookie, input.secure)]
}

export async function createPackageAppSessionCookie(input: {
	env: Env
	session: PackageAppSession
	/** Package leaf this session authorizes on this host. */
	slug: string
	secure: boolean
	expiresAt: number
	now?: number
}): Promise<Array<string>> {
	const now = input.now ?? Date.now()
	const maxAge = remainingCookieMaxAgeSeconds(input.expiresAt, now)
	if (maxAge == null) {
		throw new Error('Package app session expiresAt is not in the future.')
	}
	const slug = input.slug.trim().toLowerCase()
	const cookie = await getPackageAppSessionCookie(input.env, slug, input.secure)
	const setCookie = await cookie.serialize(
		JSON.stringify({
			v: 3,
			stableUserId: input.session.stableUserId,
			pkgUsername: input.session.username,
			app: slug,
			issuedAt: now,
			expiresAt: input.expiresAt,
		} satisfies StoredPackageAppSessionV3),
		{ secure: input.secure, maxAge },
	)
	// Eagerly drop the host-wide legacy cookie so sibling apps on the same
	// shared host cannot keep riding it after a per-app login/handoff.
	const legacyClears = await destroyLegacyPackageAppSessionCookies({
		env: input.env,
		secure: input.secure,
	})
	return [setCookie, ...legacyClears]
}

/**
 * Clears the per-app session cookie for `slug`, and the legacy host-wide
 * names so a leftover pre-per-app cookie cannot re-authorize this app.
 */
export async function destroyPackageAppSessionCookie(input: {
	env: Env
	slug: string
	secure: boolean
}): Promise<Array<string>> {
	const cookie = await getPackageAppSessionCookie(
		input.env,
		input.slug,
		input.secure,
	)
	const legacyClears = await destroyLegacyPackageAppSessionCookies({
		env: input.env,
		secure: input.secure,
	})
	return [await expireCookieHeader(cookie, input.secure), ...legacyClears]
}

function parseStoredPackageAppSession(
	stored: unknown,
	now: number,
	expectedSlug: string,
): ParsedPackageAppSession | null {
	if (!stored || typeof stored !== 'string') return null
	try {
		const parsed: unknown = JSON.parse(stored)
		if (!isStoredPackageAppSession(parsed)) return null
		if (parsed.v === 3 && parsed.app !== expectedSlug) return null
		const expiresAt =
			parsed.expiresAt ??
			parsed.issuedAt + legacyPackageAppSessionMaxAgeSeconds * 1000
		if (expiresAt <= now) {
			return null
		}
		return {
			session: {
				stableUserId: parsed.stableUserId,
				username: parsed.pkgUsername,
			},
			issuedAt: parsed.issuedAt,
			expiresAt,
		}
	} catch {
		return null
	}
}

function cookieHeaderHasName(cookieHeader: string, name: string) {
	return cookieHeader.split(';').some((cookie) => {
		const separator = cookie.indexOf('=')
		return separator >= 0 && cookie.slice(0, separator).trim() === name
	})
}

export async function readPackageAppSession(input: {
	request: Request
	env: Env
	/** Package leaf whose per-app session should be read. */
	slug: string
	now?: number
}): Promise<ParsedPackageAppSession | null> {
	const cookieHeader = input.request.headers.get('Cookie')
	if (!cookieHeader) return null

	const slug = input.slug.trim().toLowerCase()
	const appCookieNames = await Promise.all([
		packageAppSessionCookieName(slug, true),
		packageAppSessionCookieName(slug, false),
	])
	const cookieNames = [
		...appCookieNames,
		legacySecurePackageAppSessionCookieName,
		legacyInsecurePackageAppSessionCookieName,
	]
	if (!cookieNames.some((name) => cookieHeaderHasName(cookieHeader, name))) {
		return null
	}

	const now = input.now ?? Date.now()
	const secureCookie = await getPackageAppSessionCookie(input.env, slug, true)
	const insecureCookie = await getPackageAppSessionCookie(
		input.env,
		slug,
		false,
	)
	const secureSession = parseStoredPackageAppSession(
		await secureCookie.parse(cookieHeader),
		now,
		slug,
	)
	if (secureSession) return secureSession
	const insecureSession = parseStoredPackageAppSession(
		await insecureCookie.parse(cookieHeader),
		now,
		slug,
	)
	if (insecureSession) return insecureSession

	// Legacy host-wide cookie (pre-per-app). Accept for any app until the
	// next login/handoff or logout clears it.
	const legacySecure = await getLegacyPackageAppSessionCookie(input.env, true)
	const legacySecureSession = parseStoredPackageAppSession(
		await legacySecure.parse(cookieHeader),
		now,
		slug,
	)
	if (legacySecureSession) return legacySecureSession
	const legacyInsecure = await getLegacyPackageAppSessionCookie(
		input.env,
		false,
	)
	return parseStoredPackageAppSession(
		await legacyInsecure.parse(cookieHeader),
		now,
		slug,
	)
}
