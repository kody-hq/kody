import { isSecureRequest } from '#app/auth-session.ts'
import {
	getAppBaseUrl,
	getPackageAppBaseUrl,
	parsePackageAppRequestHost,
} from '#worker/app-base-url.ts'
import { consumePackageAppOauthCode } from '#app/package-app-oauth-codes.ts'
import { formatPackageAppOauthClientId } from '#app/package-app-oauth-client-id.ts'
import { resolvePackageAppOauthClient } from '#app/package-app-oauth-client-resolve.ts'
import { findLivePackageAppOauthGrant } from '#app/package-app-oauth-grants.ts'
import {
	createPackageAppOauthCodeVerifier,
	createPackageAppOauthPkceCookie,
	createPackageAppOauthState,
	createS256CodeChallenge,
	destroyPackageAppOauthPkceCookie,
	readPackageAppOauthPkceState,
} from '#app/package-app-oauth-pkce-cookie.ts'
import {
	parsePackageAppOauthScopes,
	scopesIncludeEmail,
} from '#app/package-app-oauth-scopes.ts'
import {
	createPackageAppSessionCookie,
	destroyLegacyPackageAppSessionCookies,
	destroyPackageAppSessionCookie,
	readPackageAppSession,
} from '#app/package-app-session.ts'
import {
	destroyPackageAppTicketCookie,
	readPackageAppTicket,
} from '#app/package-app-ticket.ts'
import {
	resolvePackageAppOrgOwnerByHandle,
	resolvePackageAppOwnerByStableUserId,
} from '#app/package-app-owner.ts'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { viewerCanExecutePackageApp } from '#app/package-viewer-access.ts'
import { resolveSavedPackageForPackageAppSlug } from '#worker/package-invocations/module-artifacts.ts'
import {
	isPackageAppOauthHostAuthPathname,
	normalizePackageAppOauthHostAuthPathname,
	packageAppOauthPaths,
} from '#universal/package-app-oauth-paths.ts'
import {
	isVerifiedAppCustomHostname,
	isVerifiedOrgCustomHostname,
	normalizeCustomHostname,
} from '#worker/package-app-custom-hostnames/lookup.ts'
import { lookupCachedPackageAppCustomHostname } from '#worker/package-app-custom-hostnames/lookup-cache.ts'
import { isPackageAppCustomDomainsEnabled } from '#worker/package-app-custom-hostnames/feature-flag.ts'
import { buildUserAvatarUrl } from '#worker/community/public-urls.ts'
import { resolveDisplayName } from '#worker/identity/username.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { parsePackageAppSubdomainPath } from '#worker/package-runtime/package-app-serve.ts'
import { resolvePackageAppOauthInlineIdentity } from '#app/package-app-oauth-inline-identity.ts'

/**
 * Host-root `/-/auth/*` routes (and legacy `/_kody/auth/*`) on package-app origins and verified custom
 * domains (and on the app origin when `PACKAGE_APP_BASE_URL` is unset for
 * preview / path-based inline serving). Starts PKCE, exchanges the
 * authorization code for a per-app host-only package-app session cookie, clears
 * only that app's session on logout (shared hosts keep sibling app sessions),
 * and exposes `/me`.
 */

function redirectResponse(location: string, setCookies: Array<string> = []) {
	const headers = new Headers({
		Location: location,
		'Cache-Control': 'no-store',
	})
	for (const cookie of setCookies) headers.append('Set-Cookie', cookie)
	return new Response(null, { status: 302, headers })
}

function badRequest(message: string, status = 400) {
	return new Response(message, {
		status,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}

function normalizeReturnTo(raw: string | null, origin: string): string {
	if (!raw) return '/'
	try {
		if (raw.startsWith('/')) {
			if (raw.startsWith('//') || raw.includes('\\')) return '/'
			return raw
		}
		const url = new URL(raw)
		if (url.origin !== origin) return '/'
		return `${url.pathname}${url.search}`
	} catch {
		return '/'
	}
}

function readAppSlugParam(url: URL) {
	const raw = (
		url.searchParams.get('app') ??
		url.searchParams.get('package') ??
		url.searchParams.get('kody_id')
	)?.trim()
	return raw ? raw.toLowerCase() : undefined
}

/** Best-effort leaf from a host-root `return_to` like `/packages/{leaf}/…`. */
function readAppSlugFromReturnTo(returnTo: string) {
	const match = /^\/packages\/([^/?#]+)/i.exec(returnTo)
	const raw = match?.[1]?.trim()
	return raw ? raw.toLowerCase() : undefined
}

async function resolveVerifiedHostApp(input: {
	env: Env
	orgUsername: string
	kodyId: string
}): Promise<{ orgUsername: string; kodyId: string } | null> {
	// Never trust a raw subdomain label or query param as the OAuth owner —
	// the package must exist and be served under that handle.
	const resolved = await resolvePackageAppOauthClient({
		env: input.env,
		username: input.orgUsername,
		kodyId: input.kodyId,
	})
	if (!resolved) return null
	return {
		orgUsername: resolved.client.username,
		kodyId: resolved.client.kodyId,
	}
}

/**
 * Leaf from a same-origin `Referer` path `/{leaf}/…` or the legacy
 * `/packages/{leaf}/…`. Used on shared hosts so logout binds to the app that
 * initiated the navigation, not an attacker-chosen `?app=` on a sibling
 * package. Only package-app hosts mount packages at `/{leaf}`; on the app
 * origin (inline serving) only the legacy form is a package path.
 */
function readAppSlugFromSameOriginReferer(
	request: Request,
	requestUrl: URL,
	input: { packageAppHost: boolean },
) {
	const referer = request.headers.get('Referer')
	if (!referer) return undefined
	try {
		const refererUrl = new URL(referer)
		if (refererUrl.origin !== requestUrl.origin) return undefined
		if (!input.packageAppHost) {
			return readAppSlugFromReturnTo(refererUrl.pathname)
		}
		return parsePackageAppSubdomainPath({
			pathname: refererUrl.pathname,
			username: '',
		})?.kodyId.toLowerCase()
	} catch {
		return undefined
	}
}

/**
 * Which package leaf logout should clear on this host.
 *
 * On shared multi-app hosts (`{user}.kody.run` and org custom hostnames), only
 * a same-origin Referer `/{leaf}` (or legacy `/packages/{leaf}`) may select a per-app cookie —
 * `?app=` / `return_to` are attacker-chosen on a top-level GET. Verified
 * single-app custom hostnames trust the hostname mapping. Shared-host logout
 * never waits on `APP_DB` (custom-domain lookup) so a D1 outage cannot block
 * cookie clearing. When nothing trusted resolves, callers clear only the
 * legacy host-wide cookie.
 */
async function resolveLogoutAppSlug(input: {
	request: Request
	env: Env
	url: URL
	returnTo: string
}): Promise<string | null> {
	const requestHost = parsePackageAppRequestHost({
		env: input.env,
		url: input.url,
	})
	const inlineServing = !getPackageAppBaseUrl({ env: input.env })
	const fromReferer = readAppSlugFromSameOriginReferer(
		input.request,
		input.url,
		{ packageAppHost: !inlineServing },
	)
	if (requestHost?.kind === 'user-subdomain') {
		return fromReferer ?? null
	}

	// Preview / path-based inline serving: no separate package-app zone, so
	// query / return_to remain useful when Referer is absent.
	if (inlineServing) {
		return (
			fromReferer ??
			readAppSlugParam(input.url) ??
			readAppSlugFromReturnTo(input.returnTo) ??
			null
		)
	}

	const hostname = normalizeCustomHostname(input.url.hostname)
	if (hostname && (await isPackageAppCustomDomainsEnabled(input.env.APP_DB))) {
		const mapping = await lookupCachedPackageAppCustomHostname({
			db: input.env.APP_DB,
			hostname,
		})
		if (mapping && isVerifiedAppCustomHostname(mapping)) {
			return mapping.kodyId.toLowerCase()
		}
		if (mapping && isVerifiedOrgCustomHostname(mapping)) {
			// Multi-app org custom host: same sibling rule as user subdomains.
			return fromReferer ?? null
		}
	}

	return fromReferer ?? null
}

async function resolveHostApp(input: {
	request: Request
	env: Env
	url: URL
}): Promise<{ orgUsername: string; kodyId: string } | null> {
	const requestHost = parsePackageAppRequestHost({
		env: input.env,
		url: input.url,
	})
	if (requestHost?.kind === 'user-subdomain') {
		const app = readAppSlugParam(input.url)
		if (!app) return null
		return await resolveVerifiedHostApp({
			env: input.env,
			orgUsername: requestHost.username,
			kodyId: app,
		})
	}

	const hostname = normalizeCustomHostname(input.url.hostname)
	if (hostname && (await isPackageAppCustomDomainsEnabled(input.env.APP_DB))) {
		const mapping = await lookupCachedPackageAppCustomHostname({
			db: input.env.APP_DB,
			hostname,
		})
		if (mapping) {
			if (isVerifiedAppCustomHostname(mapping)) {
				return await resolveVerifiedHostApp({
					env: input.env,
					orgUsername: mapping.username,
					kodyId: mapping.kodyId.toLowerCase(),
				})
			}
			if (isVerifiedOrgCustomHostname(mapping)) {
				const app = readAppSlugParam(input.url)
				if (!app) return null
				return await resolveVerifiedHostApp({
					env: input.env,
					orgUsername: mapping.username,
					kodyId: app,
				})
			}
		}
	}

	// Preview / path-based inline serving: no package-app origin, so resolve
	// from query params or return_to on the app origin itself.
	if (!getPackageAppBaseUrl({ env: input.env })) {
		const inline = resolvePackageAppOauthInlineIdentity(input.url)
		if (!inline) return null
		return await resolveVerifiedHostApp({
			env: input.env,
			orgUsername: inline.orgUsername,
			kodyId: inline.kodyId,
		})
	}
	return null
}

async function handleLogin(input: { request: Request; env: Env; url: URL }) {
	const app = await resolveHostApp(input)
	if (!app) {
		return badRequest(
			'Unknown or unpublished package app for this host. On *.kody.run pass ?app={leaf} for a published package under this owner.',
		)
	}
	const { scopes, error: scopeError } = parsePackageAppOauthScopes(
		input.url.searchParams.get('scope'),
	)
	if (scopeError) return badRequest(scopeError)

	const secure = isSecureRequest(input.request)
	const verifier = createPackageAppOauthCodeVerifier()
	const state = createPackageAppOauthState()
	const returnTo = normalizeReturnTo(
		input.url.searchParams.get('return_to'),
		input.url.origin,
	)
	const clientId = formatPackageAppOauthClientId({
		username: app.orgUsername,
		kodyId: app.kodyId,
	})
	const redirectUri = `${input.url.origin}${packageAppOauthPaths.callback}`
	const challenge = await createS256CodeChallenge(verifier)
	const authorize = new URL(
		packageAppOauthPaths.authorize,
		getAppBaseUrl({ env: input.env }),
	)
	authorize.searchParams.set('response_type', 'code')
	authorize.searchParams.set('client_id', clientId)
	authorize.searchParams.set('redirect_uri', redirectUri)
	authorize.searchParams.set('state', state)
	authorize.searchParams.set('code_challenge', challenge)
	authorize.searchParams.set('code_challenge_method', 'S256')
	authorize.searchParams.set('scope', scopes.join(' '))

	const pkceCookie = await createPackageAppOauthPkceCookie({
		env: input.env,
		secure,
		state: {
			v: 1,
			verifier,
			state,
			returnTo,
			orgUsername: app.orgUsername,
			kodyId: app.kodyId,
			scopes,
			clientId,
		},
	})
	return redirectResponse(authorize.toString(), [pkceCookie])
}

async function handleCallback(input: { request: Request; env: Env; url: URL }) {
	const code = input.url.searchParams.get('code')
	const state = input.url.searchParams.get('state')
	const oauthError = input.url.searchParams.get('error')
	const secure = isSecureRequest(input.request)
	const pkce = await readPackageAppOauthPkceState({
		request: input.request,
		env: input.env,
	})
	if (!pkce) {
		return badRequest('Missing sign-in state. Start again from the app.')
	}
	// Only clear the PKCE cookie when `state` matches — an unauthenticated
	// `?error=` navigation must not cancel a different pending sign-in.
	if (!state || state !== pkce.state) {
		return badRequest('Sign-in state mismatch. Start again from the app.')
	}
	const clearPkce = await destroyPackageAppOauthPkceCookie({
		env: input.env,
		secure,
	})

	if (oauthError) {
		return redirectResponse(
			normalizeReturnTo(pkce.returnTo, input.url.origin),
			[clearPkce],
		)
	}
	if (!code) {
		return badRequest('Missing authorization code.', 400)
	}

	// Echo the callback path the browser used so codes issued for a legacy
	// `/_kody/auth/callback` redirect URI still exchange.
	const redirectUri = `${input.url.origin}${input.url.pathname}`
	const record = await consumePackageAppOauthCode({
		env: input.env,
		code,
		redirectUri,
		codeVerifier: pkce.verifier,
	})
	if (!record) {
		return badRequest('Authorization code was invalid or already used.', 403)
	}
	if (
		record.orgUsername !== pkce.orgUsername ||
		record.kodyId !== pkce.kodyId
	) {
		return badRequest('Authorization code was issued for a different app.', 403)
	}

	const sessionCookies = await createPackageAppSessionCookie({
		env: input.env,
		session: {
			stableUserId: record.personId,
			username: record.orgUsername,
		},
		slug: record.kodyId,
		secure,
		expiresAt: record.sessionExpiresAt,
	})
	return redirectResponse(normalizeReturnTo(pkce.returnTo, input.url.origin), [
		clearPkce,
		...sessionCookies,
	])
}

async function handleLogout(input: { request: Request; env: Env; url: URL }) {
	const secure = isSecureRequest(input.request)
	const returnTo = normalizeReturnTo(
		input.url.searchParams.get('return_to'),
		input.url.origin,
	)
	// Shared hosts clear only the requesting leaf. Prefer same-origin Referer
	// `/packages/{leaf}` over `?app=` so a sibling package cannot navigate the
	// browser into clearing another app. Verified app custom domains resolve
	// from the hostname mapping. When no leaf is known (older kit clients with
	// `return_to=/` and no Referer), clear only the legacy host-wide cookie so
	// pre-per-app sessions still end.
	const kodyId = await resolveLogoutAppSlug({ ...input, returnTo })
	const cookies = [
		...(kodyId
			? await destroyPackageAppSessionCookie({
					env: input.env,
					slug: kodyId,
					secure,
				})
			: await destroyLegacyPackageAppSessionCookies({
					env: input.env,
					secure,
				})),
		await destroyPackageAppOauthPkceCookie({ env: input.env, secure }),
	]
	if (kodyId) {
		cookies.push(
			await destroyPackageAppTicketCookie({
				env: input.env,
				slug: kodyId,
				secure,
			}),
		)
	}
	return redirectResponse(returnTo, cookies)
}

async function readAvatarKeyForPerson(input: {
	env: Env
	stableUserId: string
}) {
	const row = await input.env.APP_DB.prepare(
		`SELECT avatar_key FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
	)
		.bind(input.stableUserId)
		.first<{ avatar_key: string | null }>()
	return row?.avatar_key ?? null
}

async function handleMe(input: { request: Request; env: Env; url: URL }) {
	const app = await resolveHostApp(input)
	const slug = app?.kodyId ?? readAppSlugParam(input.url)
	if (!slug) {
		return Response.json(
			{ error: 'missing_app', message: 'Pass ?app={leaf} on this host.' },
			{ status: 400, headers: { 'Cache-Control': 'no-store' } },
		)
	}

	const parsedSession = await readPackageAppSession({
		request: input.request,
		env: input.env,
		slug,
	})
	if (!parsedSession) {
		return Response.json(
			{ error: 'unauthorized' },
			{ status: 401, headers: { 'Cache-Control': 'no-store' } },
		)
	}

	const person = await resolvePackageAppOwnerByStableUserId({
		env: input.env,
		stableUserId: parsedSession.session.stableUserId,
		issuedAt: parsedSession.issuedAt,
	})
	if (!person) {
		return Response.json(
			{ error: 'unauthorized' },
			{ status: 401, headers: { 'Cache-Control': 'no-store' } },
		)
	}

	const handle = (
		app?.orgUsername ?? parsedSession.session.username
	).toLowerCase()

	const grant = await findLivePackageAppOauthGrant({
		db: input.env.APP_DB,
		personId: parsedSession.session.stableUserId,
		orgUsername: handle,
		kodyId: slug,
	})

	let role: string | null = null
	const ticket = await readPackageAppTicket({
		request: input.request,
		env: input.env,
		host: input.url.host,
		slug,
		session: {
			stableUserId: parsedSession.session.stableUserId,
			issuedAt: parsedSession.issuedAt,
		},
		secure: isSecureRequest(input.request),
	})
	if (ticket) {
		role = ticket.visitor.role
	} else if (!grant) {
		// No ticket and no OAuth grant: only package executors (owners /
		// collaborators with app:execute) may read /me.
		const org = await resolvePackageAppOrgOwnerByHandle({
			env: input.env,
			handle,
		})
		if (!org) {
			return Response.json(
				{ error: 'forbidden' },
				{ status: 403, headers: { 'Cache-Control': 'no-store' } },
			)
		}
		const lookup = await resolveSavedPackageForPackageAppSlug({
			db: input.env.APP_DB,
			userId: org.userId,
			slug,
		})
		const canExecute = await viewerCanExecutePackageApp({
			env: input.env,
			viewer: {
				userId: personIdFromStored(parsedSession.session.stableUserId),
				username: person.username,
			},
			ownerId: org.userId,
			appId: lookup?.savedPackage.id ?? null,
		})
		if (!canExecute) {
			return Response.json(
				{ error: 'forbidden' },
				{ status: 403, headers: { 'Cache-Control': 'no-store' } },
			)
		}
	}

	const avatarKey = await readAvatarKeyForPerson({
		env: input.env,
		stableUserId: parsedSession.session.stableUserId,
	})
	const relativeAvatar = buildUserAvatarUrl({
		username: person.username,
		avatarKey,
	})
	const avatarUrl = relativeAvatar
		? new URL(relativeAvatar, getAppBaseUrl({ env: input.env })).toString()
		: undefined

	let emailClaim: string | undefined
	if (grant && scopesIncludeEmail(grant.scopes)) {
		emailClaim = person.email
	}

	return Response.json(
		{
			userId: parsedSession.session.stableUserId,
			username: person.username,
			displayName: resolveDisplayName({
				email: person.email,
				username: person.username,
			}),
			...(avatarUrl ? { avatarUrl } : {}),
			...(emailClaim ? { email: emailClaim } : {}),
			role,
		},
		{ headers: { 'Cache-Control': 'no-store' } },
	)
}

/**
 * Dispatch `/-/auth/*` and legacy `/_kody/auth/*` on a package-app host with
 * no redirect between them. Returns null when the path is not an auth route so
 * the caller can continue serving the package.
 */
export async function handlePackageAppOauthHostAuth(input: {
	request: Request
	env: Env
	url: URL
}): Promise<Response | null> {
	if (!isPackageAppOauthHostAuthPathname(input.url.pathname)) return null
	const pathname = normalizePackageAppOauthHostAuthPathname(input.url.pathname)

	if (pathname === packageAppOauthPaths.login) {
		if (input.request.method !== 'GET' && input.request.method !== 'HEAD') {
			return badRequest('Method not allowed.', 405)
		}
		return await handleLogin(input)
	}
	if (pathname === packageAppOauthPaths.callback) {
		if (input.request.method !== 'GET' && input.request.method !== 'HEAD') {
			return badRequest('Method not allowed.', 405)
		}
		return await handleCallback(input)
	}
	if (pathname === packageAppOauthPaths.logout) {
		if (
			input.request.method !== 'GET' &&
			input.request.method !== 'HEAD' &&
			input.request.method !== 'POST'
		) {
			return badRequest('Method not allowed.', 405)
		}
		return await handleLogout(input)
	}
	if (pathname === packageAppOauthPaths.me) {
		if (input.request.method !== 'GET' && input.request.method !== 'HEAD') {
			return badRequest('Method not allowed.', 405)
		}
		return await handleMe(input)
	}
	return badRequest('Unknown auth path.', 404)
}

/** True when a package-app origin request targets `/-/auth/*` or `/_kody/auth/*`. */
export function isPackageAppOauthHostAuthPath(pathname: string) {
	return isPackageAppOauthHostAuthPathname(pathname)
}
