import { getDomain } from 'tldts'
import {
	buildPackageAppSubdomainOrigin,
	isDnsSafeUsername,
} from '@kody-internal/shared/public-urls.ts'
import { isNonProductionRuntime } from '#app/deployment-env.ts'
import { parseLegacyHosts } from '#worker/app-legacy-redirect.ts'

const DEFAULT_APP_BASE_URL = 'https://kody.codes'

type PackageAppBaseUrlEnv = {
	PACKAGE_APP_BASE_URL?: string | null
	PACKAGE_APP_LEGACY_HOSTS?: string | null
	PACKAGE_APP_LEGACY_REDIRECT?: string | null
	WRANGLER_IS_LOCAL_DEV?: string | undefined
}

type AppBaseUrlEnv = PackageAppBaseUrlEnv & {
	APP_BASE_URL?: string | null
	APP_LEGACY_HOSTS?: string | null
}

export type PackageAppOriginEnv = AppBaseUrlEnv & {
	SENTRY_ENVIRONMENT?: string | undefined
}

function isLocallyServableHostname(hostname: string) {
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '[::1]' ||
		hostname.endsWith('.localhost')
	)
}

/**
 * Resolve the origin hosted package apps are served from, or `null` when the
 * a non-production deployment serves them inline on the app origin.
 *
 * Production must set `PACKAGE_APP_BASE_URL` to a separate registrable domain so
 * author-supplied package code is cross-site from the first-party app origin
 * and can never receive the owner's `kody_session` cookie. Preview, tests, and
 * E2E may leave it unset and keep the path-based same-origin behavior.
 *
 * `npm run dev` runs against the **production** Wrangler environment, so the
 * committed production value reaches local dev too. A local server cannot serve
 * the real package-app domain, so local dev only honors an origin it can
 * actually answer on (`localhost`, `127.0.0.1`, `*.localhost`) — set
 * `PACKAGE_APP_BASE_URL=http://packages.localhost:<port>` in
 * `packages/worker/.env` to exercise the two-origin flow locally.
 */
export function getPackageAppBaseUrl(input: { env: PackageAppBaseUrlEnv }) {
	const configured = input.env.PACKAGE_APP_BASE_URL?.trim()
	if (!configured) return null

	try {
		const configuredUrl = new URL(configured)
		// Exact 'true' like `isNonProductionRuntime`: any other value must not be
		// able to switch package apps back to the app origin in a real deployment.
		if (
			input.env.WRANGLER_IS_LOCAL_DEV === 'true' &&
			!isLocallyServableHostname(configuredUrl.hostname)
		) {
			return null
		}
		return configuredUrl.origin
	} catch {
		// Runtime env validation should already catch this; fall back to the
		// same-origin behavior instead of routing to a bogus host.
		return null
	}
}

export function getRegistrableDomain(url: URL) {
	return getDomain(url.hostname) ?? url.hostname.toLowerCase()
}

/**
 * Registrable domains of every configured app and package-app origin,
 * including legacy dual-serve hosts. This is the single list both the
 * custom-hostname runtime guard and custom-hostname registration read, so the
 * two can never disagree about which parent domains belong to Kody.
 */
export function listKodyRegistrableDomains(env: AppBaseUrlEnv): Array<string> {
	const domains: Array<string> = []
	for (const raw of [
		env.APP_BASE_URL,
		env.PACKAGE_APP_BASE_URL,
		...parseLegacyHosts(env.APP_LEGACY_HOSTS),
		...parseLegacyHosts(env.PACKAGE_APP_LEGACY_HOSTS),
	]) {
		if (!raw) continue
		try {
			const value = raw.includes('://') ? raw : `https://${raw}`
			const domain = getRegistrableDomain(new URL(value))
			if (!domains.includes(domain)) domains.push(domain)
		} catch {
			// Ignore unparsable configured hosts.
		}
	}
	return domains
}

/**
 * True when `hostname` is on the same registrable domain as any configured
 * app or package-app origin (including legacy dual-serve hosts). Custom
 * hostnames must stay cross-site from those origins so author code cannot
 * ride `SameSite=Lax` first-party cookies.
 */
export function hostnameSharesKodyRegistrableDomain(input: {
	env: AppBaseUrlEnv
	hostname: string
}): boolean {
	const hostname = input.hostname.trim().toLowerCase().replace(/\.+$/, '')
	if (!hostname) return false
	const candidates = listKodyRegistrableDomains(input.env)
	const hostnameDomain = getDomain(hostname) ?? hostname
	return candidates.some(
		(domain) => hostnameDomain === domain || hostname === domain,
	)
}

/**
 * True when `hostname` can never serve package apps as a customer custom
 * hostname: it shares a registrable domain with a Kody origin (see
 * {@link hostnameSharesKodyRegistrableDomain}) or is a `*.workers.dev` host.
 * The package-app runtime refuses these hosts, so registration must refuse
 * them too instead of accepting a hostname that will only ever 404.
 */
export function isKodyReservedCustomHostname(input: {
	env: AppBaseUrlEnv
	hostname: string
}): boolean {
	const hostname = input.hostname.trim().toLowerCase().replace(/\.+$/, '')
	if (!hostname) return false
	if (hostname === 'workers.dev' || hostname.endsWith('.workers.dev')) {
		return true
	}
	return hostnameSharesKodyRegistrableDomain(input)
}

export type PackageAppHostRole = 'canonical' | 'legacy'

export type PackageAppRequestHost =
	/** The bare package-app origin: serves only redirects, never package code. */
	| { kind: 'apex'; role: PackageAppHostRole }
	/** One user's package-app subdomain: `{username}.<package-app host>`. */
	| { kind: 'user-subdomain'; username: string; role: PackageAppHostRole }
	/**
	 * A hostname under the package-app domain that is not a valid single
	 * username label (nested labels, invalid characters, wrong scheme/port).
	 * Wildcard DNS still routes it here, so it must fail closed.
	 */
	| { kind: 'unrecognized-subdomain'; role: PackageAppHostRole }

export type PackageAppOrigin = {
	origin: string
	hostname: string
	role: PackageAppHostRole
}

/**
 * Canonical package-app origin plus any `PACKAGE_APP_LEGACY_HOSTS` entries.
 * Legacy hosts are assumed `https` (production package-app traffic is always
 * TLS); they classify dual-served package-app zones the same way as the
 * canonical origin.
 */
export function listPackageAppOrigins(input: { env: PackageAppBaseUrlEnv }) {
	const origins: Array<PackageAppOrigin> = []
	const canonical = getPackageAppBaseUrl({ env: input.env })
	if (canonical) {
		const hostname = new URL(canonical).hostname.toLowerCase()
		origins.push({ origin: canonical, hostname, role: 'canonical' })
	}
	for (const hostname of parseLegacyHosts(input.env.PACKAGE_APP_LEGACY_HOSTS)) {
		if (origins.some((origin) => origin.hostname === hostname)) continue
		const origin = `https://${hostname}`
		origins.push({ origin, hostname, role: 'legacy' })
	}
	return origins
}

/**
 * Classify a request URL against one package-app origin, or `null` when the
 * URL is not on that origin's host at all.
 */
function classifyAgainstPackageAppOrigin(input: {
	url: URL
	packageAppOrigin: string
	role: PackageAppHostRole
}): PackageAppRequestHost | null {
	const base = new URL(input.packageAppOrigin)
	const rawHostname = input.url.hostname.toLowerCase()
	// `URL.hostname` preserves a trailing DNS dot, and `kody.run.` is the
	// same host as `kody.run` to resolvers. Letting the dotted form fall
	// through would route it as first-party traffic, so it fails closed as an
	// unrecognized package-app host instead.
	const hadTrailingDot = rawHostname.endsWith('.')
	const hostname = rawHostname.replace(/\.+$/, '')
	if (hostname === base.hostname) {
		if (hadTrailingDot)
			return { kind: 'unrecognized-subdomain', role: input.role }
		// Same hostname on a different scheme/port is another local service, not
		// the package-app origin (matches the previous exact-origin behavior).
		return input.url.origin === base.origin
			? { kind: 'apex', role: input.role }
			: null
	}
	if (!hostname.endsWith(`.${base.hostname}`)) return null
	if (hadTrailingDot)
		return { kind: 'unrecognized-subdomain', role: input.role }

	const label = hostname.slice(0, -(base.hostname.length + 1))
	// Strict DNS-label check: legacy underscore usernames cannot own a
	// subdomain, and nested labels never match.
	if (label.includes('.') || !isDnsSafeUsername(label)) {
		return { kind: 'unrecognized-subdomain', role: input.role }
	}
	const expectedOrigin = buildPackageAppSubdomainOrigin({
		packageAppOrigin: input.packageAppOrigin,
		username: label,
	})
	if (input.url.origin !== expectedOrigin) {
		return { kind: 'unrecognized-subdomain', role: input.role }
	}
	return { kind: 'user-subdomain', username: label, role: input.role }
}

/**
 * Classify a request URL against the configured package-app origin.
 *
 * Returns `null` when no package-app origin resolves or when the URL is not
 * on the package-app domain at all (ordinary first-party traffic). Dual-served
 * package-app hosts listed in `PACKAGE_APP_LEGACY_HOSTS` classify the same
 * way as the canonical origin so both zones share host classification (and
 * optional GET/HEAD subdomain redirects when enabled).
 */
export function parsePackageAppRequestHost(input: {
	env: PackageAppBaseUrlEnv
	url: URL
}): PackageAppRequestHost | null {
	for (const origin of listPackageAppOrigins({ env: input.env })) {
		const classified = classifyAgainstPackageAppOrigin({
			url: input.url,
			packageAppOrigin: origin.origin,
			role: origin.role,
		})
		if (classified) return classified
	}
	return null
}

/**
 * Return a clear production configuration failure instead of allowing package
 * apps to fall back to the first-party origin.
 */
export function getPackageAppOriginConfigurationError(
	env: PackageAppOriginEnv,
) {
	if (isNonProductionRuntime(env)) return null

	const packageAppOrigin = getPackageAppBaseUrl({ env })
	if (!packageAppOrigin) {
		return 'Production requires PACKAGE_APP_BASE_URL to be set to a valid, separate registrable origin.'
	}

	const configuredAppBaseUrl = env.APP_BASE_URL?.trim()
	if (!configuredAppBaseUrl) {
		return 'Production requires APP_BASE_URL when hosted package apps are enabled.'
	}

	let appOrigin: string
	try {
		appOrigin = new URL(configuredAppBaseUrl).origin
	} catch {
		return 'Production requires APP_BASE_URL to be a valid origin when hosted package apps are enabled.'
	}
	const packageAppUrl = new URL(packageAppOrigin)
	const appUrl = new URL(appOrigin)
	if (
		packageAppUrl.origin === appUrl.origin ||
		getRegistrableDomain(packageAppUrl) === getRegistrableDomain(appUrl)
	) {
		return 'Production requires PACKAGE_APP_BASE_URL to use a separate registrable domain from APP_BASE_URL.'
	}

	for (const origin of listPackageAppOrigins({ env })) {
		if (origin.role === 'canonical') continue
		const legacyUrl = new URL(origin.origin)
		if (
			legacyUrl.origin === appUrl.origin ||
			getRegistrableDomain(legacyUrl) === getRegistrableDomain(appUrl)
		) {
			return 'Production requires PACKAGE_APP_LEGACY_HOSTS to use a separate registrable domain from APP_BASE_URL.'
		}
	}

	return null
}

/**
 * Resolve the public app origin for request-scoped work.
 *
 * Prefer the request origin when a real request URL is available so MCP OAuth
 * metadata and app links match the host the client actually connected to.
 * Fall back to `APP_BASE_URL`, then the production default, for background work
 * (workflows, email, etc.) that has no inbound request.
 *
 * Requests that arrived on the package-app domain (the bare origin or any
 * per-user subdomain) are treated as having no usable request origin: those
 * hosts only serve author-supplied package apps, so first-party links and
 * package runtime callbacks must point at the app origin.
 */
export function getAppBaseUrl(input: {
	env: AppBaseUrlEnv
	requestUrl?: string | URL | null
}) {
	if (input.requestUrl != null && input.requestUrl !== '') {
		try {
			const requestUrl = new URL(input.requestUrl)
			if (!parsePackageAppRequestHost({ env: input.env, url: requestUrl })) {
				return requestUrl.origin
			}
		} catch {
			// Fall through to configured / default origin.
		}
	}

	const configuredBaseUrl = input.env.APP_BASE_URL?.trim()
	if (configuredBaseUrl) {
		try {
			return new URL(configuredBaseUrl).origin
		} catch {
			// Runtime env validation should already catch this; fall back defensively.
		}
	}

	return DEFAULT_APP_BASE_URL
}

/**
 * Resolve the canonical public app origin, preferring the configured
 * `APP_BASE_URL` over the request origin.
 *
 * This is the inverse preference of `getAppBaseUrl`: the Worker dual-serves
 * the canonical host plus any `APP_LEGACY_HOSTS`, and canonical URLs emitted
 * into HTML (`<link rel="canonical">`, OG/Twitter URLs) must point at the
 * configured canonical origin even when the page was served from a
 * dual-served host. Request-scoped protocol surfaces (MCP OAuth metadata,
 * app links) keep using `getAppBaseUrl` so they match the host the client
 * actually connected to.
 *
 * Falls back to the request origin (local dev and preview leave
 * `APP_BASE_URL` unset), then the production default.
 */
export function getCanonicalAppBaseUrl(input: {
	env: AppBaseUrlEnv
	requestUrl?: string | URL | null
}) {
	const configuredBaseUrl = input.env.APP_BASE_URL?.trim()
	if (configuredBaseUrl) {
		try {
			return new URL(configuredBaseUrl).origin
		} catch {
			// Runtime env validation should already catch this; fall back defensively.
		}
	}
	return getAppBaseUrl(input)
}

/**
 * Join a first-party app path onto the public origin. Cron and email
 * call sites must use this (or `getAppBaseUrl` + a path) instead of
 * `${APP_BASE_URL}/…`, because production `APP_BASE_URL` may include a
 * trailing slash and would otherwise emit `https://host//path`.
 */
export function joinAppUrl(input: {
	env: AppBaseUrlEnv
	path: string
	requestUrl?: string | URL | null
}) {
	const origin = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const path = input.path.startsWith('/') ? input.path : `/${input.path}`
	return `${origin}${path}`
}

/**
 * Redirect safe browser GET/HEAD from a legacy package-app *user subdomain*
 * (`{username}.<legacy-apex>`) to the matching canonical subdomain
 * (`{username}.kody.run`) with path and query preserved.
 *
 * Dual-serve is the default: `__Host-kody_pkg_session` is host-only, so
 * sessions, iframe embeds, and published package URLs on a dual-served
 * host stay on that host unless `PACKAGE_APP_LEGACY_REDIRECT` is exactly
 * `'true'`. Apex requests are never redirected onto the canonical
 * package-app apex — `handleApexRequest` already sends `/` to the app
 * origin.
 *
 * Returns `null` when the request should be served normally.
 */
export function getPackageAppLegacySubdomainRedirect(input: {
	request: Request
	env: PackageAppBaseUrlEnv
	requestHost: PackageAppRequestHost
}): Response | null {
	if (input.env.PACKAGE_APP_LEGACY_REDIRECT !== 'true') return null
	const method = input.request.method
	if (method !== 'GET' && method !== 'HEAD') return null
	if (input.requestHost.kind !== 'user-subdomain') return null
	if (input.requestHost.role !== 'legacy') return null

	const packageAppOrigin = getPackageAppBaseUrl({ env: input.env })
	if (!packageAppOrigin) return null

	let url: URL
	try {
		url = new URL(input.request.url)
	} catch {
		return null
	}

	const canonical = buildPackageAppSubdomainOrigin({
		packageAppOrigin,
		username: input.requestHost.username,
	})
	if (canonical === url.origin) return null

	return Response.redirect(`${canonical}${url.pathname}${url.search}`, 308)
}
