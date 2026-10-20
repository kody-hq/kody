import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { type RuntimePackageAppVisitor } from '@kody-internal/shared/runtime-worker.ts'
import { html } from 'remix/html-template'
import { createHtmlResponse } from 'remix/response/html'
import {
	buildPackageAppCustomHostnameUrl,
	buildPackageAppOpenPath,
	buildPackageAppSubdomainPath,
	buildPackageAppSubdomainUrl,
	buildPackagePagePath,
} from '@kody-internal/shared/public-urls.ts'
import {
	isPackageAppHostRobotsTxtPath,
	isPackageAppLegacySubdomainMountPath,
	packageAppHostDefaultRobotsTxt,
	packageAppHostDefaultRobotsTxtHeader,
	packageAppHostSystemPrefix,
} from '@kody-internal/shared/package-app-host-paths.ts'
import { parseLegacyHosts } from '#worker/app-legacy-redirect.ts'
import { isPackageAppCustomDomainsEnabled } from '#worker/package-app-custom-hostnames/feature-flag.ts'
import { lookupCachedPackageAppCustomHostname } from '#worker/package-app-custom-hostnames/lookup-cache.ts'
import {
	isVerifiedAppCustomHostname,
	isVerifiedOrgCustomHostname,
	lookupVerifiedAppCustomHostnameForPackage,
	lookupVerifiedOrgCustomHostnameForPackage,
	normalizeCustomHostname,
} from '#worker/package-app-custom-hostnames/lookup.ts'
import {
	type VerifiedAppCustomHostname,
	type VerifiedOrgCustomHostname,
	type VerifiedPackageAppCustomHostname,
} from '#worker/package-app-custom-hostnames/types.ts'
import { resolveSavedPackageForPackageAppSlug } from '#worker/package-invocations/module-artifacts.ts'
import { getCommunityListingByOwnerAndPackage } from '#worker/community/repo.ts'
import { getPackageNameLeaf } from '#worker/package-registry/package-name.ts'
import {
	getAppBaseUrl,
	getPackageAppBaseUrl,
	getPackageAppLegacySubdomainRedirect,
	getPackageAppOriginConfigurationError,
	hostnameSharesKodyRegistrableDomain,
	joinAppUrl,
	parsePackageAppRequestHost,
} from '#worker/app-base-url.ts'
import { redirectToLoginWhenUnauthenticated } from '#app/auth-redirect.ts'
import { readAuthenticatedAppUser } from '#app/authenticated-user.ts'
import {
	getAuthSessionExpiresAtMs,
	isSecureRequest,
	readParsedAuthSession,
} from '#app/auth-session.ts'
import {
	consumePackageAppHandoffToken,
	createPackageAppHandoffToken,
	packageAppHandoffQueryParam,
} from '#app/package-app-handoff.ts'
import { createHealthHandler } from '#app/handlers/health.ts'
import { handlePackageAppOauthHostAuth } from '#app/package-app-oauth-host-auth.ts'
import {
	resolvePackageAppOrgOwnerByHandle,
	resolvePackageAppOwnerByStableUserId,
} from '#app/package-app-owner.ts'
import { viewerCanExecutePackageApp } from '#app/package-viewer-access.ts'
import {
	createPackageAppSessionCookie,
	readPackageAppSession,
} from '#app/package-app-session.ts'
import {
	type PackageAppPath,
	parsePackageAppCustomHostnamePath,
	parsePackageAppPath,
	parsePackageAppSubdomainPath,
	servePackageAppRequest,
} from '#app/handlers/package-app.ts'
import { type PackageAppServeOwner } from '#worker/package-runtime/package-app-serve.ts'
import { applyPackageAppCacheHeaders } from '#worker/package-runtime/package-app-cache-headers.ts'
import { resolveInternetVisibleApprovedCommit } from '#app/package-app-internet-visible.ts'
import {
	mintPackageAppTicketCookie,
	readPackageAppTicket,
} from '#app/package-app-ticket.ts'
import {
	cachePackageAppAccessDecision,
	logPackageAppAccessEvent,
	logSampledPackageAppTicketAllow,
	readCachedPackageAppAccessDecision,
	readOrgAccessEpoch,
} from '#app/package-app-access-decision.ts'
import {
	maybeHandleLegacyPackageAppSubdomainMount,
	recordPackageAppLegacyMountHit,
} from '#worker/package-runtime/package-app-legacy-mount.ts'
import { buildUnmatchedPackageAppOriginPathMessage } from '#worker/package-runtime/package-app-synthetic.ts'
import {
	pushServerTiming,
	type ServerTimingEntry,
} from '#worker/server-timing.ts'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { runWithRequestContext } from '#worker/request-context.ts'
import { runWithDeferredWork } from '#worker/deferred-work.ts'
import { stripPackageAppRuntimeRunId } from '#worker/package-runtime/package-app-diagnostics.ts'
import { wantsJson } from '#worker/utils.ts'
import { resolvePublicPackageAppLocation } from '#worker/package-app-public-url.ts'

/**
 * Host-based isolation for hosted package apps.
 *
 * Package apps execute author-supplied HTML/JS. If they were served from the app
 * origin, that code would be same-site with `kody_session`: a package page could
 * call first-party endpoints with the owner's credentials, and the owner's
 * cookie was forwarded into the package worker. Serving them from a separate
 * registrable domain (`PACKAGE_APP_BASE_URL`) makes them cross-site, so the
 * `SameSite=Lax` session cookie never attaches.
 *
 * Within that domain, every user gets their own subdomain
 * (`{username}.<package-app host>`), so one user's package apps are a
 * different origin from every other user's: browser state (cookies, storage,
 * `document` access) never crosses accounts. The bare package-app origin (the
 * apex) serves no package code at all — it only redirects legacy path-based
 * URLs to the owning user's subdomain and sends the bare origin home.
 *
 * The app origin is the only host that can authenticate the owner, so a
 * signed-in person who may run the app still mints a short-lived single-use
 * handoff token and the user's package-app subdomain exchanges it for its own
 * host-scoped session cookie (named with the `__Host-` prefix on secure
 * requests so sibling subdomains cannot shadow it). The same host-only cookie
 * is set on a verified customer custom hostname. Anonymous visitors and
 * signed-in outsiders are not redirected there: `/@{username}/packages/…` on
 * the app origin stays on that origin and shows the saved-package page.
 *
 * When `package-app-custom-domains` is globally on, a verified app-level
 * custom hostname serves that package at `/` (assets at `/_assets/...`).
 * A verified org-level hostname serves private apps at
 * `/{kodyId}` like `{slug}.kody.run` (legacy `/packages/{kodyId}` is still
 * served). Kody-owned routes on package-app hosts live under `/-/` (auth,
 * health). The app origin hands off to
 * the custom host when a binding exists (app-level first, then org-level).
 * Unverified hostnames stay refused.
 *
 * Internet-visible apps (`saved_packages.is_internet_visible`, ADR 0069) also
 * serve visitors without a usable session, anonymously: no handoff, no
 * visitor, and bridge calls that need an actor fail closed. Responses served
 * to a signed-in visitor are forced `private` so no shared cache can hand
 * them to someone else (`package-app-cache-headers.ts`).
 *
 * The origins never redirect to each other in a cycle: the app origin only
 * redirects people who may run the app *to* a package-app subdomain (or a
 * verified custom hostname), the apex only redirects to a subdomain or the
 * app origin, and a subdomain only ever redirects within itself (dropping a
 * consumed token from the URL). A request that arrives without a usable
 * session gets a terminal 403 with a link back to the app origin, so a
 * browser that refuses the cookie fails visibly instead of bouncing between
 * hosts. Everyone else who hits `/@{username}/packages/…` on the app origin
 * stays there.
 *
 * `/@{username}/webhooks/*` deliberately stays on the app origin: it is a
 * machine API authenticated by its own URL secret, it is never called by
 * package browser code, and moving it would widen the package-app domain's
 * surface for no benefit. It 404s here. Retired
 * `/@{username}/connectors/*` paths also 404 here.
 */

function withoutHandoffToken(url: URL) {
	const cleaned = new URL(url)
	cleaned.searchParams.delete(packageAppHandoffQueryParam)
	return cleaned
}

function redirectResponse(input: {
	location: string
	status: 302 | 303 | 307 | 308
	setCookie?: string | Array<string>
	cacheControl?: string
}) {
	const headers = new Headers({
		Location: input.location,
		'Cache-Control': input.cacheControl ?? 'no-store',
	})
	const cookies =
		input.setCookie == null
			? []
			: Array.isArray(input.setCookie)
				? input.setCookie
				: [input.setCookie]
	for (const cookie of cookies) headers.append('Set-Cookie', cookie)
	return new Response(null, { status: input.status, headers })
}

function createPackageAppOriginConfigurationErrorResponse(message: string) {
	return new Response(`Hosted package apps are unavailable. ${message}`, {
		status: 500,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}

function createUnmatchedPackageAppPathResponse() {
	return new Response(buildUnmatchedPackageAppOriginPathMessage(), {
		status: 404,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}

/**
 * Hosted URL for a handoff redirect. Uses
 * {@link resolvePublicPackageAppLocation} (custom hostname or subdomain via
 * the shared public-urls helpers) so hosted path shape stays in one place.
 * Falls back to the subdomain builder when the public helper returns null.
 */
async function buildHandoffHostedTarget(input: {
	env: Env
	packageAppOrigin: string
	packagePath: PackageAppPath
	kodyId: string
	url: URL
}) {
	const restPath =
		input.packagePath.restPath === '/' ? null : input.packagePath.restPath
	const publicLocation = await resolvePublicPackageAppLocation({
		env: input.env,
		username: input.packagePath.username,
		kodyId: input.kodyId,
		restPath,
	})
	const target = new URL(
		publicLocation?.hostedUrl ??
			buildPackageAppSubdomainUrl({
				packageAppOrigin: input.packageAppOrigin,
				username: input.packagePath.username,
				kodyId: input.kodyId,
				restPath,
			}),
	)
	target.search = withoutHandoffToken(input.url).search
	return target
}

/**
 * Sync subdomain URL (tests and call sites that already know there is no
 * custom hostname). Prefer {@link buildHandoffHostedTarget} for handoff.
 */
function buildSubdomainTarget(input: {
	packageAppOrigin: string
	packagePath: PackageAppPath
	url: URL
}) {
	const target = new URL(
		buildPackageAppSubdomainUrl({
			packageAppOrigin: input.packageAppOrigin,
			username: input.packagePath.username,
			kodyId: input.packagePath.kodyId,
			restPath:
				input.packagePath.restPath === '/' ? null : input.packagePath.restPath,
		}),
	)
	target.search = withoutHandoffToken(input.url).search
	return target
}

/**
 * The app-origin Open app URL: `/@{user}/packages/{name}/open`, which
 * authenticates and starts a fresh handoff.
 */
function buildAppOriginEntryUrl(input: {
	appBaseUrl: string
	packagePath: PackageAppPath
	url: URL
}) {
	const entry = new URL(
		`${input.appBaseUrl.replace(/\/+$/, '')}${buildPackageAppOpenPath({
			username: input.packagePath.username,
			kodyId: input.packagePath.kodyId,
			restPath:
				input.packagePath.restPath === '/' ? null : input.packagePath.restPath,
		})}`,
	)
	entry.search = withoutHandoffToken(input.url).search
	return entry
}

/**
 * Terminal response for a package-app request with no usable package-app
 * session. Deliberately not a redirect back to the app origin: only the visitor
 * can decide to start a new handoff, so a broken cookie cannot loop.
 */
function createPackageAppSessionRequiredResponse(input: {
	request: Request
	appOriginUrl: URL
	handoffPresented: boolean
}) {
	const openUrl = input.appOriginUrl.toString()
	const headers = {
		'Cache-Control': 'no-store',
		'X-Kody-Handoff': input.handoffPresented ? 'rejected' : 'required',
	}
	const message = input.handoffPresented
		? 'Kody could not complete the session handoff. The link may have expired or already been used.'
		: 'Hosted package apps run on their own domain and need a Kody handoff before they can load.'
	if (wantsJson(input.request)) {
		return Response.json(
			{
				error: 'Package app session required',
				message,
				next_step: `Open the app from Kody at ${openUrl}.`,
			},
			{ status: 403, headers },
		)
	}
	const troubleshooting = input.handoffPresented
		? 'If Continue keeps bringing you back here with the handoff parameter still in the address bar, the package-app domain did not accept the token. That is not a cookie setting — try once more, and if it still fails this is a server-side handoff problem.'
		: "If you keep landing here, your browser is refusing this site's cookie. Allow cookies for this domain and try again."
	return createHtmlResponse(
		html`<!doctype html>
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<title>Open this package app from Kody</title>
					<style>
						:root {
							color-scheme: light dark;
							font-family: ui-sans-serif, system-ui, sans-serif;
							line-height: 1.5;
						}
						main {
							box-sizing: border-box;
							max-width: 34rem;
							margin: 0 auto;
							padding: min(12vh, 6rem) 1.25rem;
						}
					</style>
				</head>
				<body>
					<main>
						<h1>Open this package app from Kody</h1>
						<p>
							Hosted package apps run on their own domain, so Kody has to hand
							off your signed-in session before this app can load.
						</p>
						<p><a href="${openUrl}">Continue to this app</a></p>
						<p>${troubleshooting}</p>
					</main>
				</body>
			</html>`,
		{ status: 403, headers },
	)
}

function redirectToPackagePage(input: {
	env: Env
	request: Request
	packagePath: PackageAppPath
	status?: 302 | 303
}) {
	return redirectResponse({
		location: joinAppUrl({
			env: input.env,
			path: buildPackagePagePath({
				username: input.packagePath.username,
				kodyId: input.packagePath.kodyId,
			}),
			requestUrl: input.request.url,
		}),
		status: input.status ?? 302,
	})
}

type AuthorizedPackageAppServe =
	| {
			kind: 'ok'
			owner: PackageAppServeOwner
			visitor: RuntimePackageAppVisitor
			/** Org `access_epoch` the decision was made at. */
			epoch: number
			visitorEmail: string
			sessionIssuedAt: number
	  }
	| { kind: 'session-required' }
	| { kind: 'forbidden'; visitorEmail: string }

/**
 * Resolve the org named in the host/path, confirm the session person is still
 * live, and authorize `app:execute` in that org. The visitor keeps their live
 * org role; the owner is the org, not the visitor's personal account.
 *
 * The decision is cached in KV per org `access_epoch`
 * (`package-app-access-decision.ts`): the epoch is read first, so a decision
 * computed concurrently with an access write is stored under the epoch it
 * may already be stale for, never under the new one.
 */
async function authorizePackageAppVisitorForOrg(input: {
	env: Env
	stableUserId: string
	issuedAt: number
	handle: string
	/** Package slug so app:execute is checked on that app, not any grant. */
	kodyId?: string
}): Promise<AuthorizedPackageAppServe> {
	const person = await resolvePackageAppOwnerByStableUserId({
		env: input.env,
		stableUserId: input.stableUserId,
		issuedAt: input.issuedAt,
	})
	const org = await resolvePackageAppOrgOwnerByHandle({
		env: input.env,
		handle: input.handle,
	})
	if (!person || !org) return { kind: 'session-required' }

	const viewer = {
		userId: personIdFromStored(input.stableUserId),
		username: person.username,
	}
	let appId: string | null = null
	const kodyId = input.kodyId?.trim()
	if (kodyId) {
		const lookup = await resolveSavedPackageForPackageAppSlug({
			db: input.env.APP_DB,
			userId: org.userId,
			slug: kodyId,
		})
		appId = lookup?.savedPackage.id ?? null
	}
	const epoch = await readOrgAccessEpoch(input.env.APP_DB, org.userId)
	if (epoch === null) return { kind: 'session-required' }
	const decisionScope = {
		env: input.env,
		orgId: org.userId,
		epoch,
		visitorId: viewer.userId,
		appId,
	}
	let decision = await readCachedPackageAppAccessDecision(decisionScope)
	if (!decision) {
		const canExecute = await viewerCanExecutePackageApp({
			env: input.env,
			viewer,
			ownerId: org.userId,
			appId,
		})
		// Memoized per request: viewerCanExecutePackageApp loaded the same binding.
		const binding = canExecute
			? await loadOrgBindingForOrg(input.env.APP_DB, viewer.userId, org.userId)
			: null
		decision = { allowed: canExecute, role: binding?.role ?? null }
		cachePackageAppAccessDecision({ ...decisionScope, decision })
	}
	if (!decision.allowed) {
		return { kind: 'forbidden', visitorEmail: person.email }
	}

	// Team org entitlements resolve by org id alone. Pairing the visitor's
	// email with the team org id would miss the users row and fall to Free.
	const ownerEmail = org.userId === person.personalOrgId ? person.email : ''
	return {
		kind: 'ok',
		owner: {
			userId: org.userId,
			username: org.username,
			email: ownerEmail,
			displayName: org.displayName,
		},
		visitor: {
			userId: viewer.userId,
			username: person.username,
			role: decision.role,
		},
		epoch,
		visitorEmail: person.email,
		sessionIssuedAt: input.issuedAt,
	}
}

/**
 * When a package-app URL still uses a retired slug, permanent-308 to the
 * current leaf so handoff tokens and the served app stay on one canonical path.
 * Returns null when the slug is live or unknown (caller continues as today).
 */
async function redirectRetiredPackageAppSlug(input: {
	env: Env
	url: URL
	packagePath: PackageAppPath
	/**
	 * Build the Location path for the current leaf. App-origin handoff uses the
	 * path mount; subdomain serve uses the subdomain mount.
	 */
	buildLocation: (currentSlug: string) => string
}): Promise<Response | null> {
	const org = await resolvePackageAppOrgOwnerByHandle({
		env: input.env,
		handle: input.packagePath.username,
	})
	if (!org) return null
	const lookup = await resolveSavedPackageForPackageAppSlug({
		db: input.env.APP_DB,
		userId: org.userId,
		slug: input.packagePath.kodyId,
	})
	if (!lookup?.retired) return null
	// Location must use the name leaf (Kent: slug = package name leaf), not
	// savedPackage.kodyId — those can diverge until Phase 2's single writer.
	const currentSlug = getPackageNameLeaf(lookup.savedPackage.name)
	const target = new URL(input.buildLocation(currentSlug), input.url)
	target.search = withoutHandoffToken(input.url).search
	return redirectResponse({
		location: `${target.pathname}${target.search}`,
		status: 308,
		// Source slug can be reclaimed by a later package; positive freshness
		// would keep sending browsers to the wrong app.
		cacheControl: 'no-store',
	})
}

function requestHostname(url: URL) {
	return url.hostname.toLowerCase().replace(/\.+$/, '')
}

function configuredAppHostnames(env: Env) {
	const hostnames: Array<string> = []
	const configured = env.APP_BASE_URL?.trim()
	if (configured) {
		try {
			hostnames.push(requestHostname(new URL(configured)))
		} catch {
			// Ignore an unparsable app origin; custom-host lookup stays closed.
		}
	}
	for (const hostname of parseLegacyHosts(env.APP_LEGACY_HOSTS)) {
		if (!hostnames.includes(hostname)) hostnames.push(hostname)
	}
	return hostnames
}

/**
 * Verified app-level custom hostname for this request, when the flag is on.
 * Returns null for the app origin, package-app hosts, `*.workers.dev`, and
 * any hostname that is not both active and serving an app binding. Callers
 * that already refused the host can then let the request through.
 */
export async function resolveVerifiedCustomHostnameIfEnabled(
	request: Request,
	env: Env,
): Promise<VerifiedPackageAppCustomHostname | null> {
	let url: URL
	try {
		url = new URL(request.url)
	} catch {
		return null
	}
	const hostname = normalizeCustomHostname(url.hostname)
	if (!hostname) return null
	const appHostnames = configuredAppHostnames(env)
	// Custom domains are a hosted-origin feature. With no canonical app host
	// configured, skip the flag read so ordinary test traffic stays off D1.
	if (appHostnames.length === 0) return null
	if (appHostnames.includes(hostname)) return null
	if (hostname.endsWith('.workers.dev')) return null
	if (parsePackageAppRequestHost({ env, url })) return null
	// Author code on a customer host must stay cross-site from Kody cookies.
	if (hostnameSharesKodyRegistrableDomain({ env, hostname })) return null
	if (!(await isPackageAppCustomDomainsEnabled(env.APP_DB))) return null
	const mapping = await lookupCachedPackageAppCustomHostname({
		db: env.APP_DB,
		hostname,
	})
	if (!mapping) return null
	if (isVerifiedAppCustomHostname(mapping)) return mapping
	if (isVerifiedOrgCustomHostname(mapping)) return mapping
	return null
}

async function buildCustomHostnameHandoffTarget(input: {
	env: Env
	packagePath: PackageAppPath
	url: URL
}): Promise<{
	target: URL
	kodyId: string
	bindingKind: 'app' | 'org'
} | null> {
	if (!(await isPackageAppCustomDomainsEnabled(input.env.APP_DB))) return null
	const appMapping = await lookupVerifiedAppCustomHostnameForPackage({
		db: input.env.APP_DB,
		username: input.packagePath.username,
		kodyId: input.packagePath.kodyId,
	})
	const mapping =
		appMapping ??
		(await lookupVerifiedOrgCustomHostnameForPackage({
			db: input.env.APP_DB,
			username: input.packagePath.username,
			kodyId: input.packagePath.kodyId,
		}))
	if (!mapping) return null
	const target =
		mapping.bindingKind === 'app'
			? new URL(
					buildPackageAppCustomHostnameUrl({
						origin: `https://${mapping.hostname}`,
						restPath:
							input.packagePath.restPath === '/'
								? null
								: input.packagePath.restPath,
					}),
				)
			: new URL(
					buildPackageAppSubdomainPath({
						kodyId: input.packagePath.kodyId,
						restPath:
							input.packagePath.restPath === '/'
								? null
								: input.packagePath.restPath,
					}),
					`https://${mapping.hostname}`,
				)
	target.search = withoutHandoffToken(input.url).search
	const handoffKodyId =
		mapping.bindingKind === 'app' ? mapping.kodyId : input.packagePath.kodyId
	return { target, kodyId: handoffKodyId, bindingKind: mapping.bindingKind }
}

/**
 * App-origin `/@{username}/packages/…` when a separate package-app origin is
 * configured. The app origin never executes package code.
 *
 * People who may run the app still hand off (302 + token on GET/HEAD, 307
 * without a token on other methods) because `*.kody.run` and custom domains
 * authenticate only with the host-scoped cookie that token mints. Everyone
 * else stays on the app origin: the saved-package page, or a same-origin
 * landing that links to the real origin when the package page itself would
 * hide a private internet-visible app. Nothing here redirects anonymous
 * visitors or signed-in outsiders off the app origin.
 */
async function handleAppOriginPackageAppPath(input: {
	request: Request
	env: Env
	url: URL
	packagePath: PackageAppPath
	packageAppOrigin: string
}) {
	const { request, env, url, packagePath, packageAppOrigin } = input

	// Resolve retired slugs before minting a handoff bound to the URL slug.
	// The 308 stays on the app origin.
	const retiredRedirect = await redirectRetiredPackageAppSlug({
		env,
		url,
		packagePath,
		buildLocation: (currentSlug) =>
			buildPackageAppOpenPath({
				username: packagePath.username,
				kodyId: currentSlug,
				restPath: packagePath.restPath === '/' ? null : packagePath.restPath,
			}),
	})
	if (retiredRedirect) return retiredRedirect

	const org = await resolvePackageAppOrgOwnerByHandle({
		env,
		handle: packagePath.username,
	})
	const slugLookup = org
		? await resolveSavedPackageForPackageAppSlug({
				db: env.APP_DB,
				userId: org.userId,
				slug: packagePath.kodyId,
			})
		: null
	const internetVisible = Boolean(
		await resolveInternetVisibleApprovedCommit({
			env,
			lookup: slugLookup,
			requestUrl: request.url,
		}),
	)
	const user = await readAuthenticatedAppUser(request, env)
	const canExecute =
		user && org
			? await viewerCanExecutePackageApp({
					env,
					viewer: user.mcpUser,
					ownerId: org.userId,
					appId: slugLookup?.savedPackage.id ?? null,
				})
			: false

	if (!user || !org || !canExecute) {
		// A session-gated app has no anonymous page. Login stays on the app
		// origin and returns the visitor to this path, so an expired owner
		// session can still hand off. It does not reveal whether the package
		// exists.
		if (
			!user &&
			!internetVisible &&
			(request.method === 'GET' || request.method === 'HEAD')
		) {
			return await redirectToLoginWhenUnauthenticated(request, env)
		}
		return await stayOnAppOriginPackagePage({
			request,
			env,
			url,
			packagePath,
			packageAppOrigin,
			internetVisible,
			savedPackage: slugLookup?.savedPackage ?? null,
			signedIn: Boolean(user),
		})
	}

	const customHandoff = await buildCustomHostnameHandoffTarget({
		env,
		packagePath,
		url,
	})
	// Org-level custom hostnames serve only session-gated apps, so an
	// internet-visible app keeps its app-level hostname or the subdomain.
	const usableCustomHandoff =
		customHandoff && !(internetVisible && customHandoff.bindingKind === 'org')
			? customHandoff
			: null
	// Custom-host consume binds to the mapping leaf/slug (lowercased). Mint
	// with that id so a mixed-case app-origin URL cannot fail the path check.
	const handoffKodyId = usableCustomHandoff?.kodyId ?? packagePath.kodyId
	const target =
		usableCustomHandoff?.target ??
		(await buildHandoffHostedTarget({
			env,
			packageAppOrigin,
			packagePath,
			kodyId: handoffKodyId,
			url,
		}))

	// A non-safe method cannot carry a handoff token. Preserve the method and
	// let the package-app host authorize it with a cookie the visitor already
	// holds. This runs only after we know they may run the app.
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return redirectResponse({ location: target.toString(), status: 307 })
	}

	const parsedSession = await readParsedAuthSession(request)
	if (!parsedSession) {
		return await redirectToLoginWhenUnauthenticated(request, env)
	}

	target.searchParams.set(
		packageAppHandoffQueryParam,
		await createPackageAppHandoffToken({
			env,
			claims: {
				// Visitor person; the org handle lives in `username`.
				stableUserId: user.mcpUser.userId,
				username: packagePath.username,
				kodyId: handoffKodyId,
			},
			sessionExpiresAt: getAuthSessionExpiresAtMs({
				rememberMe: parsedSession.session.rememberMe,
				issuedAt: parsedSession.issuedAt,
			}),
		}),
	)
	return redirectResponse({ location: target.toString(), status: 302 })
}

/**
 * The saved-package page includes a hosted-app link for a signed-in viewer of
 * a private or hidden package (the no-access page) and for anyone when the
 * package is public and listed. An unlisted public package renders
 * unauthorized and has no link.
 */
async function packagePageShowsHostedAppLink(input: {
	env: Env
	savedPackage: {
		id: string
		userId: string
		isPrivate: boolean
		hidden: boolean
	} | null
	signedIn: boolean
}) {
	const saved = input.savedPackage
	if (!saved) return false
	if (saved.isPrivate || saved.hidden) return input.signedIn
	try {
		const listing = await getCommunityListingByOwnerAndPackage(
			input.env.APP_DB,
			{
				ownerUserId: saved.userId,
				packageId: saved.id,
			},
		)
		return listing?.status === 'active'
	} catch {
		return false
	}
}

/**
 * Anonymous visitors and signed-in outsiders never leave the app origin.
 * GET/HEAD of a package page that can show the app goes there. A page that
 * cannot (anonymous private or hidden, or a public package with no listing)
 * renders a same-origin landing that links to the real origin. Other methods
 * 303 to the package page so a body is not replayed onto an author-controlled
 * host.
 */
async function stayOnAppOriginPackagePage(input: {
	request: Request
	env: Env
	url: URL
	packagePath: PackageAppPath
	packageAppOrigin: string
	internetVisible: boolean
	savedPackage: {
		id: string
		userId: string
		isPrivate: boolean
		hidden: boolean
	} | null
	signedIn: boolean
}) {
	const packagePageRedirect = () =>
		redirectToPackagePage({
			env: input.env,
			request: input.request,
			packagePath: input.packagePath,
			status:
				input.request.method === 'GET' || input.request.method === 'HEAD'
					? 302
					: 303,
		})
	if (input.request.method !== 'GET' && input.request.method !== 'HEAD') {
		return packagePageRedirect()
	}
	if (input.internetVisible && !(await packagePageShowsHostedAppLink(input))) {
		const restPath =
			input.packagePath.restPath === '/' ? null : input.packagePath.restPath
		const location = await resolvePublicPackageAppLocation({
			env: input.env,
			username: input.packagePath.username,
			kodyId: input.packagePath.kodyId,
			restPath,
		})
		const target = location
			? new URL(location.hostedUrl)
			: buildSubdomainTarget({
					packageAppOrigin: input.packageAppOrigin,
					packagePath: input.packagePath,
					url: input.url,
				})
		target.search = withoutHandoffToken(input.url).search
		return createPackageAppOriginLinkResponse({
			request: input.request,
			appUrl: target.toString(),
			packagePagePath: buildPackagePagePath({
				username: input.packagePath.username,
				kodyId: input.packagePath.kodyId,
			}),
			packageName: `@${input.packagePath.username}/${input.packagePath.kodyId}`,
		})
	}
	return packagePageRedirect()
}

/**
 * Same-origin page for an old `/@{username}/packages/…` link whose package
 * page would not show the app. The visitor chooses the real origin; nothing
 * redirects them there.
 */
function createPackageAppOriginLinkResponse(input: {
	request: Request
	appUrl: string
	packagePagePath: string
	packageName: string
}) {
	const headers = {
		'Cache-Control': 'no-store',
		'X-Robots-Tag': 'noindex',
	}
	if (input.request.method === 'HEAD') {
		return new Response(null, { status: 200, headers })
	}
	return createHtmlResponse(
		html`<!doctype html>
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<title>${input.packageName}</title>
					<style>
						:root {
							color-scheme: light dark;
							font-family: ui-sans-serif, system-ui, sans-serif;
							line-height: 1.5;
						}
						main {
							box-sizing: border-box;
							max-width: 34rem;
							margin: 0 auto;
							padding: min(12vh, 6rem) 1.25rem;
						}
					</style>
				</head>
				<body>
					<main data-testid="package-app-landing">
						<h1>${input.packageName}</h1>
						<p>
							This package app is hosted on its own site. Kody does not open it
							for you.
						</p>
						<p>
							<a href="${input.appUrl}" data-testid="package-app-origin-link"
								>Open the app</a
							>
						</p>
						<p>
							<a href="${input.packagePagePath}">View the package on Kody</a>
						</p>
					</main>
				</body>
			</html>`,
		{ status: 200, headers },
	)
}

/**
 * The bare package-app origin serves no package code: it sends the bare origin
 * home and redirects legacy path-based package URLs to the owning user's
 * subdomain. Everything else fails closed.
 */
function handleApexRequest(input: {
	request: Request
	env: Env
	url: URL
	packagePath: PackageAppPath | null
	packageAppOrigin: string
}) {
	const { request, env, url, packagePath, packageAppOrigin } = input
	const health = handlePackageAppHostHealth({ request, env, url })
	if (health) return health
	if (packagePath) {
		const target = buildSubdomainTarget({ packageAppOrigin, packagePath, url })
		return redirectResponse({
			location: target.toString(),
			status: request.method === 'GET' || request.method === 'HEAD' ? 302 : 307,
		})
	}
	if (url.pathname === '/') {
		return redirectResponse({
			location: `${getAppBaseUrl({ env })}/`,
			status: 302,
		})
	}
	return createUnmatchedPackageAppPathResponse()
}

/**
 * Serve an internet-visible app to a visitor who is not acting as themselves
 * (no session, or a session that cannot run the app). Returns null when the
 * app is not internet-visible or has no approved commit. The handle, slug,
 * and approved-commit lookups are per-isolate freshness caches, so a warm
 * anonymous request reads nothing from storage.
 */
async function serveInternetVisiblePackageApp(input: {
	request: Request
	env: Env
	handle: string
	packagePath: PackageAppPath
	serverTiming: Array<ServerTimingEntry>
}): Promise<Response | null> {
	const org = await resolvePackageAppOrgOwnerByHandle({
		env: input.env,
		handle: input.handle,
	})
	if (!org) return null
	const lookup = await resolveSavedPackageForPackageAppSlug({
		db: input.env.APP_DB,
		userId: org.userId,
		slug: input.packagePath.kodyId,
	})
	const approvedPublishedCommit = await resolveInternetVisibleApprovedCommit({
		env: input.env,
		lookup,
		requestUrl: input.request.url,
	})
	if (!approvedPublishedCommit) return null
	const response = await servePackageAppRequest({
		request: input.request,
		env: input.env,
		owner: {
			userId: org.userId,
			username: org.username,
			email: '',
			displayName: org.displayName,
		},
		visitor: null,
		approvedPublishedCommit,
		packagePath: input.packagePath,
		serverTiming: input.serverTiming,
	})
	return applyPackageAppCacheHeaders(response, 'anonymous')
}

function withSetCookie(response: Response, setCookie: string) {
	if (response.webSocket || response.status === 101) return response
	const headers = new Headers(response.headers)
	headers.append('Set-Cookie', setCookie)
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

/**
 * Shared tail of the per-user subdomain and app-level custom hostname:
 * exchange a handoff token for the host-only session cookie, authorize the
 * session visitor, and serve. A visitor without a usable session (or one who
 * cannot run the app) still gets an internet-visible app anonymously.
 */
async function servePackageAppForSession(input: {
	request: Request
	env: Env
	url: URL
	appBaseUrl: string
	handle: string
	packagePath: PackageAppPath
}) {
	const { request, env, url, appBaseUrl, handle, packagePath } = input
	const handoffToken = url.searchParams.get(packageAppHandoffQueryParam)
	if (handoffToken) {
		const now = Date.now()
		const claims = await consumePackageAppHandoffToken({
			env,
			token: handoffToken,
			expected: {
				username: packagePath.username,
				kodyId: packagePath.kodyId,
			},
			now,
		})
		if (claims) {
			return redirectResponse({
				location: withoutHandoffToken(url).toString(),
				status: 302,
				setCookie: await createPackageAppSessionCookie({
					env,
					session: {
						stableUserId: claims.stableUserId,
						username: claims.username,
					},
					slug: packagePath.kodyId,
					secure: isSecureRequest(request),
					expiresAt: claims.sessionExpiresAt,
					now,
				}),
			})
		}
	}

	// A token that reaches here is stale, forged, or for another package, so
	// it is still worthless — but it is still an internal auth artifact, and
	// package code has no business seeing one. Serve the request as if it
	// never carried a token, including when the parameter is present but empty.
	const servedRequest = url.searchParams.has(packageAppHandoffQueryParam)
		? new Request(withoutHandoffToken(url), request)
		: request
	const parsedSession = await readPackageAppSession({
		request,
		env,
		slug: packagePath.kodyId,
	})
	const serverTiming: Array<ServerTimingEntry> = []
	const secure = isSecureRequest(request)
	if (parsedSession) {
		const ticket = await readPackageAppTicket({
			request,
			env,
			host: url.host,
			slug: packagePath.kodyId,
			session: {
				stableUserId: parsedSession.session.stableUserId,
				issuedAt: parsedSession.issuedAt,
			},
			secure,
		})
		if (ticket) {
			logSampledPackageAppTicketAllow({
				orgHandle: handle,
				appSlug: packagePath.kodyId,
				role: ticket.visitor.role,
			})
			const response = await servePackageAppRequest({
				request: servedRequest,
				env,
				owner: ticket.owner,
				visitor: ticket.visitor,
				packagePath,
				serverTiming,
			})
			return applyPackageAppCacheHeaders(response, 'signed-in')
		}
	}
	const authorized: AuthorizedPackageAppServe = parsedSession
		? await pushServerTiming(serverTiming, 'owner', () =>
				authorizePackageAppVisitorForOrg({
					env,
					stableUserId: parsedSession.session.stableUserId,
					issuedAt: parsedSession.issuedAt,
					handle,
					kodyId: packagePath.kodyId,
				}),
			)
		: { kind: 'session-required' }

	if (authorized.kind === 'ok') {
		const response = await servePackageAppRequest({
			request: servedRequest,
			env,
			owner: authorized.owner,
			visitor: authorized.visitor,
			packagePath,
			serverTiming,
		})
		const ticketCookie = await mintPackageAppTicketCookie({
			env,
			host: url.host,
			slug: packagePath.kodyId,
			sessionIssuedAt: authorized.sessionIssuedAt,
			grant: {
				owner: authorized.owner,
				visitor: authorized.visitor,
				epoch: authorized.epoch,
			},
			secure,
		})
		logPackageAppAccessEvent({
			env,
			request,
			outcome: 'ticket-minted',
			visitorEmail: authorized.visitorEmail,
			orgHandle: handle,
			appSlug: packagePath.kodyId,
			reason: `role ${authorized.visitor.role ?? 'grant'}, epoch ${authorized.epoch}`,
		})
		return withSetCookie(
			applyPackageAppCacheHeaders(response, 'signed-in'),
			ticketCookie,
		)
	}

	const anonymous = await serveInternetVisiblePackageApp({
		request: servedRequest,
		env,
		handle,
		packagePath,
		serverTiming,
	})
	if (anonymous) return anonymous

	switch (authorized.kind) {
		case 'session-required':
			return createPackageAppSessionRequiredResponse({
				request,
				appOriginUrl: buildAppOriginEntryUrl({ appBaseUrl, packagePath, url }),
				handoffPresented: Boolean(handoffToken),
			})
		case 'forbidden':
			logPackageAppAccessEvent({
				env,
				request,
				outcome: 'denied',
				visitorEmail: authorized.visitorEmail,
				orgHandle: handle,
				appSlug: packagePath.kodyId,
				reason: 'no app:execute',
			})
			return redirectToPackagePage({ env, request, packagePath })
		default: {
			authorized satisfies never
			return createPackageAppSessionRequiredResponse({
				request,
				appOriginUrl: buildAppOriginEntryUrl({ appBaseUrl, packagePath, url }),
				handoffPresented: Boolean(handoffToken),
			})
		}
	}
}

/**
 * Sibling package-app subdomains are same-site, so until the package-app
 * domain is on the Public Suffix List a `SameSite=Lax` session cookie still
 * attaches to their cross-origin requests. A browser that holds sessions
 * for two accounts (shared machine, multiple sign-ins) could therefore let
 * one user's package code send a credentialed mutating request to another
 * user's app — CORS blocks the response, not the side effect. Mutating
 * browser requests must originate from this host itself; requests without
 * an `Origin` header (non-browser clients, synthetic dispatch) authenticate
 * through their own paths and are unaffected.
 *
 * OPTIONS is the CORS preflight and is not a mutation. It is forwarded to
 * the app, which answers with its own headers, or with a platform 204 when
 * the handler throws.
 */
function rejectCrossOriginMutatingPackageAppRequest(input: {
	request: Request
	url: URL
	message: string
}): Response | null {
	if (
		input.request.method === 'GET' ||
		input.request.method === 'HEAD' ||
		input.request.method === 'OPTIONS'
	) {
		return null
	}
	const originHeader = input.request.headers.get('Origin')
	if (originHeader === null || originHeader === input.url.origin) return null
	return new Response(input.message, {
		status: 403,
		headers: {
			'Cache-Control': 'no-store',
			'Content-Type': 'text/plain; charset=utf-8',
		},
	})
}

const packageAppHostHealthPath = `${packageAppHostSystemPrefix}/health`

/**
 * `/-/health` on a package-app host answers with the same report as the app
 * origin so deploy tooling can verify the SHA behind `*.kody.run`. Returns null
 * for every other request.
 */
function handlePackageAppHostHealth(input: {
	request: Request
	env: Env
	url: URL
}): Promise<Response> | null {
	if (input.url.pathname !== packageAppHostHealthPath) return null
	if (input.request.method !== 'GET' && input.request.method !== 'HEAD') {
		return null
	}
	return createHealthHandler(input.env)({ request: input.request })
}

/**
 * Root files on short-path package-app hosts (user subdomain and org custom
 * hostname): exact `/robots.txt` gets a platform default that allows all.
 * Unknown `/.well-known/...` is not answered here; it falls through to the
 * unmatched 404 (app-origin discovery docs are not invented on this host).
 */
function handlePackageAppHostRootFiles(input: {
	request: Request
	url: URL
}): Response | null {
	if (!isPackageAppHostRobotsTxtPath(input.url.pathname)) return null
	if (input.request.method !== 'GET' && input.request.method !== 'HEAD') {
		return new Response('Method Not Allowed', {
			status: 405,
			headers: {
				Allow: 'GET, HEAD',
				'Cache-Control': 'no-store',
				'Content-Type': 'text/plain; charset=utf-8',
			},
		})
	}
	const headers = {
		'Cache-Control': 'public, max-age=300',
		'Content-Type': 'text/plain; charset=utf-8',
		'x-kody-default': packageAppHostDefaultRobotsTxtHeader,
	}
	if (input.request.method === 'HEAD') {
		return new Response(null, { status: 200, headers })
	}
	return new Response(packageAppHostDefaultRobotsTxt, { status: 200, headers })
}

async function handleUserSubdomainRequest(input: {
	request: Request
	env: Env
	url: URL
	username: string
}) {
	const { request, env, url, username } = input
	const health = handlePackageAppHostHealth({ request, env, url })
	if (health) return await health
	const rootFiles = handlePackageAppHostRootFiles({ request, url })
	if (rootFiles) return rootFiles
	const appBaseUrl = getAppBaseUrl({ env })
	const hostAuth = await handlePackageAppOauthHostAuth({ request, env, url })
	if (hostAuth) return hostAuth
	const packagePath = parsePackageAppSubdomainPath({
		pathname: url.pathname,
		username,
	})

	if (!packagePath) {
		// Nothing first-party is reachable here. The bare subdomain is a
		// plausible typo or bookmark, so send it home; everything else fails
		// closed (including unknown /.well-known/... on this host).
		if (url.pathname === '/') {
			return redirectResponse({ location: `${appBaseUrl}/`, status: 302 })
		}
		return createUnmatchedPackageAppPathResponse()
	}

	// Resolve retired slugs before the legacy `/packages` HTML 308 so a
	// renamed leaf becomes one hop to `/{current}` instead of `/packages/old`
	// → `/{old}` → `/{current}`.
	const retiredRedirect = await redirectRetiredPackageAppSlug({
		env,
		url,
		packagePath,
		buildLocation: (currentSlug) =>
			buildPackageAppSubdomainPath({
				kodyId: currentSlug,
				restPath: packagePath.restPath === '/' ? null : packagePath.restPath,
			}),
	})
	if (retiredRedirect) {
		// Still count legacy `/packages/{old}` hits when the retired slug
		// redirects in one hop to `/{current}` before the legacy handler runs.
		if (isPackageAppLegacySubdomainMountPath(url.pathname)) {
			recordPackageAppLegacyMountHit({
				env,
				username: packagePath.username,
				kodyId: packagePath.kodyId,
				method: request.method,
				disposition: 'redirect',
			})
		}
		return retiredRedirect
	}

	const legacyMount = maybeHandleLegacyPackageAppSubdomainMount({
		request,
		env,
		url,
		packagePath,
	})
	if (legacyMount) return legacyMount

	const crossOriginMutating = rejectCrossOriginMutatingPackageAppRequest({
		request,
		url,
		message:
			'Cross-origin mutating requests to a package-app subdomain are not allowed.',
	})
	if (crossOriginMutating) return crossOriginMutating

	return await servePackageAppForSession({
		request,
		env,
		url,
		appBaseUrl,
		handle: username,
		packagePath,
	})
}

/**
 * Serve the package bound to a verified custom hostname at the host root.
 * Session handoff matches the per-user subdomain: the cookie stays host-only
 * (`__Host-` prefix, no Domain), and a missing session links back to the
 * app-origin entry URL instead of redirecting.
 */
async function handleOrgCustomHostnameRequest(input: {
	request: Request
	env: Env
	url: URL
	mapping: VerifiedOrgCustomHostname
}) {
	const { request, env, url, mapping } = input
	const health = handlePackageAppHostHealth({ request, env, url })
	if (health) return await health
	const rootFiles = handlePackageAppHostRootFiles({ request, url })
	if (rootFiles) return rootFiles
	const appBaseUrl = getAppBaseUrl({ env })
	const hostAuth = await handlePackageAppOauthHostAuth({ request, env, url })
	if (hostAuth) return hostAuth
	const packagePath = parsePackageAppSubdomainPath({
		pathname: url.pathname,
		username: mapping.username,
	})
	if (!packagePath) {
		if (url.pathname === '/') {
			return redirectResponse({ location: `${appBaseUrl}/`, status: 302 })
		}
		return createUnmatchedPackageAppPathResponse()
	}

	const slugLookup = await resolveSavedPackageForPackageAppSlug({
		db: env.APP_DB,
		userId: mapping.orgId,
		slug: packagePath.kodyId,
	})
	if (
		!slugLookup ||
		!slugLookup.savedPackage.hasApp ||
		slugLookup.savedPackage.isInternetVisible
	) {
		return createUnmatchedPackageAppPathResponse()
	}

	return await handleUserSubdomainRequest({
		request,
		env,
		url,
		username: mapping.username,
	})
}

async function handleCustomHostnameRequest(input: {
	request: Request
	env: Env
	url: URL
	mapping: VerifiedAppCustomHostname
}) {
	const { request, env, url, mapping } = input
	const appBaseUrl = getAppBaseUrl({ env })
	const hostAuth = await handlePackageAppOauthHostAuth({ request, env, url })
	if (hostAuth) return hostAuth
	const packagePath = parsePackageAppCustomHostnamePath({
		pathname: url.pathname,
		username: mapping.username,
		kodyId: mapping.kodyId,
	})

	const crossOriginMutating = rejectCrossOriginMutatingPackageAppRequest({
		request,
		url,
		message:
			'Cross-origin mutating requests to a package-app custom hostname are not allowed.',
	})
	if (crossOriginMutating) return crossOriginMutating

	return await servePackageAppForSession({
		request,
		env,
		url,
		appBaseUrl,
		handle: mapping.username,
		packagePath,
	})
}

/**
 * Route a request according to the configured package-app origin.
 *
 * Returns `null` when a non-production deployment has no separate package-app
 * origin, or when the request is ordinary first-party traffic on the app origin.
 * A production package-app request with unsafe origin configuration fails closed.
 */
export async function handlePackageAppOriginRequest(
	request: Request,
	env: Env,
	ctx?: Pick<ExecutionContext, 'waitUntil'>,
) {
	// One request context per package-app request so per-request memos (org
	// binding, handle) dedupe across the auth gate and serve. Audit rows and
	// access-decision writes run after the response via `ctx.waitUntil`.
	const response = await runWithDeferredWork(
		ctx ? (promise) => ctx.waitUntil(promise) : undefined,
		() =>
			runWithRequestContext(request, () =>
				dispatchPackageAppOriginRequest(request, env),
			),
	)
	if (!response) return null
	// servePackageAppRequest logs x-kody-runtime-run-id, then this boundary
	// strips it so a browser on the package-app origin never sees the header.
	return stripPackageAppRuntimeRunId(response).response
}

async function dispatchPackageAppOriginRequest(request: Request, env: Env) {
	const url = new URL(request.url)
	const requestHost = parsePackageAppRequestHost({ env, url })
	const packagePath = parsePackageAppPath(url.pathname)
	const configurationError = getPackageAppOriginConfigurationError(env)
	if (configurationError && (packagePath || requestHost)) {
		return createPackageAppOriginConfigurationErrorResponse(configurationError)
	}

	if (!requestHost) {
		const customHostname = await resolveVerifiedCustomHostnameIfEnabled(
			request,
			env,
		)
		if (customHostname) {
			if (customHostname.bindingKind === 'org') {
				return handleOrgCustomHostnameRequest({
					request,
					env,
					url,
					mapping: customHostname,
				})
			}
			return handleCustomHostnameRequest({
				request,
				env,
				url,
				mapping: customHostname,
			})
		}
	}

	const packageAppOrigin = getPackageAppBaseUrl({ env })
	if (!packageAppOrigin) return null

	if (requestHost) {
		switch (requestHost.kind) {
			case 'apex':
				return handleApexRequest({
					request,
					env,
					url,
					packagePath,
					packageAppOrigin,
				})
			case 'user-subdomain': {
				const legacyRedirect = getPackageAppLegacySubdomainRedirect({
					request,
					env,
					requestHost,
				})
				if (legacyRedirect) return legacyRedirect
				return await handleUserSubdomainRequest({
					request,
					env,
					url,
					username: requestHost.username,
				})
			}
			case 'unrecognized-subdomain':
				return createUnmatchedPackageAppPathResponse()
			default: {
				requestHost satisfies never
				return createUnmatchedPackageAppPathResponse()
			}
		}
	}
	if (!packagePath) return null

	return await handleAppOriginPackageAppPath({
		request,
		env,
		url,
		packagePath,
		packageAppOrigin,
	})
}
