import { createCookie } from 'remix/cookie'
import {
	isAuthSessionExpired,
	readParsedAuthSession,
	setAuthSessionSecret,
} from '../worker/src/app/auth-session.ts'
import { isCredentialInvalidatedByStoredPasswordChange } from '../worker/src/password-change-lockout.ts'

type Service = { fetch(request: Request): Promise<Response> }
export type RoutingEnv = {
	LEGACY: Service
	START: Service
	APP_DB: Pick<D1Database, 'prepare'>
	COOKIE_SECRET: string
	START_ROLLOUT_SECRET: string
	APP_BASE_URL: string
	START_ALLOWED_PERSON_IDS: string
	START_RELEASE: string
	START_ASSET_MANIFEST_SHA256: string
}
export type AssetManifest = {
	release: string
	assetPaths: ReadonlyArray<string>
	digest: string
}
type Config = {
	origin: string
	allowed: ReadonlySet<string>
	release: string
	prefix: string
	assets: ReadonlyMap<string, string>
}
type User = {
	stable_user_id: string
	password_changed_at: string | null
	suspended_at: string | null
	deleting_at: string | null
	deleted_at: string | null
}
const controlPrefix = '/__start/'
const preferenceCookieName = '__Host-kody_start'
const preferenceLifetime = 30 * 24 * 60 * 60

function config(
	env: RoutingEnv,
	manifest: AssetManifest,
	actualDigest: string,
): Config {
	const origin = new URL(env.APP_BASE_URL)
	if (origin.protocol !== 'https:' || origin.href !== `${origin.origin}/`)
		throw new Error('A canonical HTTPS origin is required')
	const ids: unknown = JSON.parse(env.START_ALLOWED_PERSON_IDS)
	if (
		!Array.isArray(ids) ||
		ids.length !== 2 ||
		ids.some((id) => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) ||
		new Set(ids).size !== 2
	)
		throw new Error('Configure both approved person IDs')
	if (!/^[a-f0-9]{40}$/.test(env.START_RELEASE))
		throw new Error('Configure an immutable release SHA')
	const prefix = `${controlPrefix}${env.START_RELEASE}/`
	if (
		manifest.release !== env.START_RELEASE ||
		!/^[a-f0-9]{64}$/.test(manifest.digest) ||
		manifest.digest !== actualDigest ||
		env.START_ASSET_MANIFEST_SHA256 !== actualDigest
	)
		throw new Error('Bundled asset manifest must match the reviewed release')
	const paths = manifest.assetPaths
	if (
		!Array.isArray(paths) ||
		paths.length === 0 ||
		new Set(paths).size !== paths.length ||
		paths.some(
			(path) =>
				typeof path !== 'string' ||
				!path ||
				/[\\%?#]/.test(path) ||
				[...path].some(
					(character) =>
						character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
				) ||
				path
					.split('/')
					.some((segment) => !segment || segment === '.' || segment === '..') ||
				path.startsWith('_serverFn/') ||
				path === '_serverFn',
		)
	)
		throw new Error('Configure an exact static asset manifest')
	if (
		!env.COOKIE_SECRET ||
		env.START_ROLLOUT_SECRET.length < 32 ||
		env.START_ROLLOUT_SECRET === env.COOKIE_SECRET
	)
		throw new Error('Configure session and rollout signing secrets')
	return {
		origin: origin.origin,
		allowed: new Set(ids),
		release: env.START_RELEASE,
		prefix,
		assets: new Map(
			paths.flatMap((path) => {
				const literal = prefix + path
				const canonical =
					prefix + path.split('/').map(encodeURIComponent).join('/')
				return [
					[literal, canonical],
					[canonical, canonical],
				] as const
			}),
		),
	}
}
function preferenceCookie(env: RoutingEnv) {
	return createCookie(preferenceCookieName, {
		httpOnly: true,
		secure: true,
		sameSite: 'Lax',
		path: '/',
		maxAge: preferenceLifetime,
		secrets: [env.START_ROLLOUT_SECRET],
	})
}
async function currentPerson(
	request: Request,
	env: RoutingEnv,
	settings: Config,
) {
	setAuthSessionSecret(env.COOKIE_SECRET)
	const parsed = await readParsedAuthSession(request)
	if (
		!parsed ||
		isAuthSessionExpired({
			issuedAt: parsed.issuedAt,
			rememberMe: parsed.session.rememberMe,
		})
	)
		return null
	const person = parsed.session.stableUserId
	if (!settings.allowed.has(person)) return null
	const user = await env.APP_DB.prepare(
		`SELECT stable_user_id, password_changed_at, suspended_at, deleting_at, deleted_at FROM users WHERE stable_user_id = ? LIMIT 1`,
	)
		.bind(person)
		.first<User>()
	if (
		!user ||
		user.stable_user_id !== person ||
		user.suspended_at ||
		user.deleting_at ||
		user.deleted_at ||
		isCredentialInvalidatedByStoredPasswordChange({
			issuedAtMs: parsed.issuedAt,
			storedPasswordChangedAt: user.password_changed_at,
		})
	)
		return null
	return person
}
function response(status: number, body: string, headers?: HeadersInit) {
	const resultHeaders = new Headers(headers)
	resultHeaders.set('Cache-Control', 'private, no-store')
	if (!resultHeaders.has('Content-Type'))
		resultHeaders.set('Content-Type', 'text/plain; charset=utf-8')
	return new Response(body, { status, headers: resultHeaders })
}
function control(request: Request) {
	const path = new URL(request.url).pathname
	return path === `${controlPrefix}opt-in`
		? 'in'
		: path === `${controlPrefix}opt-out`
			? 'out'
			: null
}
async function handleControl(
	request: Request,
	env: RoutingEnv,
	settings: Config,
	action: 'in' | 'out',
) {
	if (!['GET', 'POST'].includes(request.method))
		return response(405, 'Method not allowed.', { Allow: 'GET, POST' })
	if (
		request.method === 'POST' &&
		(request.headers.get('Origin') !== settings.origin ||
			request.headers.get('Sec-Fetch-Site') === 'cross-site')
	)
		return response(403, 'Use the form on this origin.')
	// Turning the preference off stays possible after the user's session expires.
	const person =
		action === 'in' ? await currentPerson(request, env, settings) : null
	if (action === 'in' && !person)
		return response(
			403,
			'This rollout is available only to the two approved accounts.',
		)
	if (request.method === 'GET') {
		const label =
			action === 'in' ? 'Use TanStack Start' : 'Use the existing app'
		return new Response(
			`<!doctype html><html><head><meta charset="utf-8"><title>${label}</title></head><body><form method="post"><button type="submit">${label}</button></form></body></html>`,
			{
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
					'Cache-Control': 'private, no-store',
					'Content-Security-Policy':
						"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
					'X-Content-Type-Options': 'nosniff',
				},
			},
		)
	}
	const cookie = preferenceCookie(env)
	const value =
		action === 'in'
			? {
					v: 1,
					person,
					release: settings.release,
					expiresAt: Date.now() + preferenceLifetime * 1000,
				}
			: ''
	const serialized = await cookie.serialize(
		JSON.stringify(value),
		action === 'out' ? { maxAge: 0, expires: new Date(0) } : {},
	)
	return response(303, '', { Location: '/', 'Set-Cookie': serialized })
}

/** Protocols and requests belonging to a mounted legacy app never switch lanes. */
export function isLegacyRequest(request: Request) {
	const url = new URL(request.url)
	const path = url.pathname
	if (
		!['GET', 'HEAD'].includes(request.method) ||
		request.headers.get('Upgrade')
	)
		return true
	if (
		/^\/(?:mcp|oauth|oidc|auth|session|api|webhooks|_kody\/auth|-\/auth|__maintenance|__platform|__runtime|__jobs)(?:\/|$)/.test(
			path,
		)
	)
		return true
	if (
		path.startsWith('/.well-known/') ||
		path.startsWith('/_serverFn/') ||
		path === '/health' ||
		path.startsWith('/health/') ||
		path === '/sentry-tunnel'
	)
		return true
	if (
		/^\/@[^/]+\/webhooks\//.test(path) ||
		/\.git(?:\/|$)/.test(path) ||
		/^\/@[^/]+\/packages\//.test(path)
	)
		return true
	if (
		path === '/account/mcp-servers/oauth/callback' ||
		/\/(?:raw|assets|icon)\//.test(path)
	)
		return true
	if (
		/\.(?:json|md|txt|xml|js|css|woff2?|png|ico|webp|svg|jpg|jpeg|gif|map)$/.test(
			path,
		)
	)
		return true
	if (url.searchParams.has('__frame') || url.searchParams.has('_data'))
		return true
	const destination = request.headers.get('Sec-Fetch-Dest')
	if (destination && destination !== 'document') return true
	return !request.headers.get('Accept')?.includes('text/html')
}
async function selectedStart(
	request: Request,
	env: RoutingEnv,
	settings: Config,
) {
	const signed = await preferenceCookie(env).parse(
		request.headers.get('Cookie'),
	)
	if (typeof signed !== 'string' || !signed) return false
	const preference: unknown = JSON.parse(signed)
	if (
		!preference ||
		typeof preference !== 'object' ||
		!('v' in preference) ||
		preference.v !== 1 ||
		!('person' in preference) ||
		typeof preference.person !== 'string' ||
		!('release' in preference) ||
		preference.release !== settings.release ||
		!('expiresAt' in preference) ||
		typeof preference.expiresAt !== 'number' ||
		preference.expiresAt <= Date.now()
	)
		return false
	if (!settings.allowed.has(preference.person)) return false
	return (await currentPerson(request, env, settings)) === preference.person
}
async function forward(service: Service, request: Request) {
	try {
		return await service.fetch(request)
	} catch {
		return response(502, 'The selected app is unavailable. Reload to retry.')
	}
}
async function routeRequest(
	request: Request,
	env: RoutingEnv,
	manifest: AssetManifest,
	digest: () => Promise<string>,
) {
	let settings: Config
	try {
		settings = config(env, manifest, await digest())
	} catch {
		return new URL(request.url).pathname.startsWith(controlPrefix)
			? response(503, 'Start rollout is not configured.')
			: forward(env.LEGACY, request)
	}
	if (new URL(request.url).origin !== settings.origin)
		return forward(env.LEGACY, request)
	const action = control(request)
	if (action) {
		try {
			return await handleControl(request, env, settings, action)
		} catch {
			return response(503, 'Rollout preference could not be updated.')
		}
	}
	const path = new URL(request.url).pathname
	// Public assets must exist in the build manifest, never fall through to SSR.
	const canonicalAssetPath = settings.assets.get(path)
	if (canonicalAssetPath) {
		if (!['GET', 'HEAD'].includes(request.method))
			return response(405, 'Method not allowed.', { Allow: 'GET, HEAD' })
		// Cloudflare assets canonicalize reserved filename characters, such as @.
		// Forward directly to that exact manifest-derived URL to avoid redirects.
		const assetUrl = new URL(request.url)
		assetUrl.pathname = canonicalAssetPath
		return forward(env.START, new Request(assetUrl, request))
	}
	if (path.startsWith(`${settings.prefix}_serverFn/`)) {
		if (request.headers.get('Upgrade'))
			return response(400, 'RPC endpoints do not accept WebSocket upgrades.')
		try {
			// Eligible mounted tabs remain functional after their preference is off.
			if (!(await currentPerson(request, env, settings)))
				return response(
					403,
					'This rollout is available only to the two approved accounts.',
				)
		} catch {
			return response(503, 'Session eligibility could not be verified.')
		}
		return privateResponse(await forward(env.START, request))
	}
	if (path.startsWith(controlPrefix))
		return response(404, 'Unknown Start release.')
	if (isLegacyRequest(request)) return forward(env.LEGACY, request)
	let start = false
	try {
		start = await selectedStart(request, env, settings)
	} catch {
		/* Authentication/configuration failure keeps documents on the existing app. */
	}
	// Never retry on the other app, even GET token links can have side effects.
	return start
		? privateResponse(await forward(env.START, request))
		: forward(env.LEGACY, request)
}

function privateResponse(source: Response) {
	const headers = new Headers(source.headers)
	headers.set('Cache-Control', 'private, no-store')
	headers.set('CDN-Cache-Control', 'no-store')
	headers.set('Cloudflare-CDN-Cache-Control', 'no-store')
	headers.delete('Surrogate-Control')
	const vary =
		headers
			.get('Vary')
			?.split(',')
			.map((value) => value.trim())
			.filter(Boolean) ?? []
	if (
		!vary.includes('*') &&
		!vary.some((value) => value.toLowerCase() === 'cookie')
	)
		vary.push('Cookie')
	headers.set('Vary', vary.join(', '))
	return new Response(source.body, {
		status: source.status,
		statusText: source.statusText,
		headers,
	})
}
/** Each immutable deployment bundles its exact assets, never a public path prefix. */
export function createRoutingWorker(input: AssetManifest) {
	const manifest = Object.freeze({
		release: input.release,
		digest: input.digest,
		assetPaths: Object.freeze([...input.assetPaths]),
	})
	let digest: Promise<string> | undefined
	const actualDigest = () =>
		(digest ??= crypto.subtle
			.digest(
				'SHA-256',
				new TextEncoder().encode(
					JSON.stringify([...manifest.assetPaths].sort()),
				),
			)
			.then((bytes) =>
				[...new Uint8Array(bytes)]
					.map((byte) => byte.toString(16).padStart(2, '0'))
					.join(''),
			))
	return {
		fetch: (request: Request, env: RoutingEnv) =>
			routeRequest(request, env, manifest, actualDigest),
	}
}

// The source config is inactive until a generated entry supplies a pinned manifest.
export default createRoutingWorker({ release: '', assetPaths: [], digest: '' })
