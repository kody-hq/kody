import {
	isolateCollection,
	isolateState,
} from '@kody-internal/shared/isolate-state.ts'
import { createCookie } from 'remix/cookie'
import { isSecureRequest } from '#app/auth-session.ts'
import { sha256Base64Url } from '@kody-internal/shared/sha256.ts'
import { parsePersonId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	isAppVisitSessionCredential,
	type AppVisitSessionCredential,
} from '#worker/app-visit/session-credential.ts'

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
 * The handoff or OAuth exchange supplies the expiration. This module requires
 * it when issuing a cookie and checks it when reading one.
 *
 * Reads require a per-app cookie name and a `v: 3` payload for the same leaf.
 *
 * A session an agent opened with an `appOpenLink` URL also carries the
 * credential that minted the link (`credential`): its token scopes and
 * profile chain. Every request under that cookie is authorized as that
 * credential, the way `appFetch` authorizes the same token, and never as
 * the person's whole account.
 */

const securePackageAppSessionCookiePrefix = '__Host-kody_pkg_session_'
const insecurePackageAppSessionCookiePrefix = 'kody_pkg_session_'
/** Default Max-Age when serialize omits an explicit remaining lifetime. */
const packageAppSessionDefaultMaxAgeSeconds = 60 * 60 * 12
const packageAppSessionSecretPurpose = 'kody-package-app-session:v2'

export type PackageAppSession = {
	stableUserId: string
	username: string
	/** Set for an agent's visit; absent for a person's own browser session. */
	credential?: AppVisitSessionCredential
	/**
	 * Host the agent's visit was opened on. Required with `credential`: an
	 * agent's session is good for one app on one host, never a same-named
	 * app on another host.
	 */
	host?: string
}

type StoredPackageAppSession = {
	v: 3
	stableUserId: string
	pkgUsername: string
	/** Lowercased package leaf this cookie authorizes. */
	app: string
	issuedAt: number
	expiresAt: number
	credential?: AppVisitSessionCredential
	/** Lowercased host an agent's session is bound to. */
	host?: string
}

export type ParsedPackageAppSession = {
	session: PackageAppSession
	issuedAt: number
	expiresAt: number
}

export function remainingCookieMaxAgeSeconds(
	expiresAt: number,
	now = Date.now(),
) {
	const remaining = Math.floor((expiresAt - now) / 1000)
	return remaining > 0 ? remaining : null
}

const cachedSecret = isolateState(
	(): { sourceSecret: string; derivedSecret: string } | null => null,
)

const cookieCache = isolateCollection(
	new Map<string, ReturnType<typeof createCookie>>(),
)

async function getDerivedSecret(env: Env) {
	const secret = env.COOKIE_SECRET?.trim()
	if (!secret) {
		throw new Error('Missing COOKIE_SECRET for package app session signing.')
	}
	if (cachedSecret.current?.sourceSecret === secret)
		return cachedSecret.current.derivedSecret
	const derivedSecret = await sha256Base64Url(
		`${packageAppSessionSecretPurpose}:${secret}`,
	)
	cachedSecret.current = { sourceSecret: secret, derivedSecret }
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
		maxAge: packageAppSessionDefaultMaxAgeSeconds,
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

function isStoredPackageAppSession(
	value: unknown,
): value is StoredPackageAppSession {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	return (
		record.v === 3 &&
		parsePersonId(record.stableUserId) !== null &&
		typeof record.pkgUsername === 'string' &&
		record.pkgUsername.length > 0 &&
		typeof record.app === 'string' &&
		record.app.length > 0 &&
		typeof record.issuedAt === 'number' &&
		Number.isFinite(record.issuedAt) &&
		record.issuedAt > 0 &&
		typeof record.expiresAt === 'number' &&
		Number.isFinite(record.expiresAt) &&
		record.expiresAt > 0 &&
		(record.credential === undefined ||
			(isAppVisitSessionCredential(record.credential) &&
				typeof record.host === 'string' &&
				record.host.length > 0))
	)
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
	const { credential } = input.session
	const host = input.session.host?.trim().toLowerCase()
	if (credential && !host) {
		throw new Error('An agent package app session needs the host it is for.')
	}
	const cookie = await getPackageAppSessionCookie(input.env, slug, input.secure)
	const setCookie = await cookie.serialize(
		JSON.stringify({
			v: 3,
			stableUserId: input.session.stableUserId,
			pkgUsername: input.session.username,
			app: slug,
			issuedAt: now,
			expiresAt: input.expiresAt,
			...(credential ? { credential, host } : {}),
		} satisfies StoredPackageAppSession),
		{ secure: input.secure, maxAge },
	)
	return [setCookie]
}

/** Clears the per-app session cookie for `slug`. */
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
	return [await expireCookieHeader(cookie, input.secure)]
}

function parseStoredPackageAppSession(
	stored: unknown,
	now: number,
	expectedSlug: string,
	requestHost: string,
): ParsedPackageAppSession | null {
	if (!stored || typeof stored !== 'string') return null
	try {
		const parsed: unknown = JSON.parse(stored)
		if (!isStoredPackageAppSession(parsed)) return null
		if (parsed.app !== expectedSlug) return null
		if (parsed.credential && parsed.host !== requestHost) return null
		if (parsed.expiresAt <= now) {
			return null
		}
		return {
			session: {
				stableUserId: parsed.stableUserId,
				username: parsed.pkgUsername,
				...(parsed.credential
					? { credential: parsed.credential, host: parsed.host }
					: {}),
			},
			issuedAt: parsed.issuedAt,
			expiresAt: parsed.expiresAt,
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

	// Only the names for this request's scheme. On HTTPS the `__Host-` prefix
	// is what stops a sibling subdomain from tossing a `Domain`-wide cookie;
	// the unprefixed hashed names exist only for plain-HTTP local dev.
	const secure = isSecureRequest(input.request)
	const slug = input.slug.trim().toLowerCase()
	const appCookieName = await packageAppSessionCookieName(slug, secure)
	if (!cookieHeaderHasName(cookieHeader, appCookieName)) {
		return null
	}

	const now = input.now ?? Date.now()
	const appCookie = await getPackageAppSessionCookie(input.env, slug, secure)
	return parseStoredPackageAppSession(
		await appCookie.parse(cookieHeader),
		now,
		slug,
		new URL(input.request.url).host.toLowerCase(),
	)
}
