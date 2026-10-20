import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RuntimePackageAppVisitor } from '@kody-internal/shared/runtime-worker.ts'
import * as Sentry from '@sentry/cloudflare'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { html } from 'remix/html-template'
import { createHtmlResponse } from 'remix/response/html'
import {
	buildPackageAppCustomHostnamePath,
	buildPackageAppPath,
	buildPackageAppSubdomainPath,
	packageAppOpenPathSegment,
	type PackageAppMount,
} from '@kody-internal/shared/public-urls.ts'
import {
	isPackageAppHostNonLeafFirstSegment,
	packageAppHostLegacyMountSegment,
} from '@kody-internal/shared/package-app-host-paths.ts'
import { accountCreditsPath } from '#universal/compute-overage.ts'
import { renderErrorAgentPromptStaticHtml } from '#universal/error-agent-prompt.ts'
import { buildPackageAppErrorAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import { packageAppHandoffQueryParam } from '#app/package-app-handoff.ts'
import {
	getAppBaseUrl,
	getCanonicalAppBaseUrl,
	parsePackageAppRequestHost,
} from '#worker/app-base-url.ts'
import {
	isPackageAppRuntimeThrownResponse,
	logPackageAppHttpError,
	packageAppRuntimeRunIdHeader,
	runtimeRunIdFromError,
} from '#worker/package-runtime/package-app-diagnostics.ts'
import { isComputeOverageLimitError } from '#worker/entitlements/errors.ts'
import { getUsernameFormatValidationError } from '#worker/identity/username.ts'
import {
	loadInvokeManifestBySourceId,
	resolveSavedPackageForPackageAppSlug,
} from '#worker/package-invocations/module-artifacts.ts'
import { getPackageNameLeaf } from '#worker/package-registry/package-name.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import {
	buildPackageAppWorker,
	createPackageAppCallerContext,
} from '#worker/package-runtime/package-app.ts'
import {
	parsePackageAppAssetRequestPath,
	servePackageAppAssetRequest,
} from '#worker/package-runtime/package-app-assets.ts'
import {
	buildPackageAppNotFoundMessage,
	isPackageAppSyntheticRequest,
	packageAppSyntheticHeaderName,
	packageAppSyntheticHeaderValue,
	type PackageAppTrustedDispatch,
} from '#worker/package-runtime/package-app-synthetic.ts'
import { packageRealtimeSessionRpc } from '#worker/package-runtime/realtime-session.ts'
import { isWebSocketUpgradeRequest } from '#worker/package-runtime/websocket-upgrade.ts'
import {
	anonymousRefusalResponse,
	refuseUnapprovedAnonymousServe,
} from '#worker/package-runtime/package-app-anonymous-serve.ts'
import { wantsJson } from '#worker/utils.ts'
import {
	applyServerTimingHeader,
	pushServerTiming,
	type ServerTimingEntry,
} from '#worker/server-timing.ts'
import {
	getRuntimeWorkerService,
	hasLocalPackageAppRuntimeBridge,
	packageAppRuntimeForwardUnavailableMessage,
} from '#worker/runtime-worker-service.ts'

export type PackageAppServeOwner = {
	userId: OwnerId
	username: string
	email: string
	displayName: string
}

export { type PackageAppMount }

export type PackageAppPath = {
	username: string
	kodyId: string
	restPath: string
	mount: PackageAppMount
	/**
	 * True when the app-origin path used `/open` after the package leaf
	 * (`/@user/packages/{name}/open/...`). The segment is platform handoff
	 * markup, not part of the hosted app path.
	 */
	openHandoff?: boolean
}

export function parsePackageAppPath(pathname: string): PackageAppPath | null {
	const parts = pathname.split('/').filter(Boolean)
	const rawUsername = parts[0]?.startsWith('@') ? parts[0].slice(1) : ''
	if (!rawUsername || parts[1] !== 'packages') return null
	const rawKodyId = parts[2]?.trim()
	if (!rawKodyId) return null
	let username: string
	let kodyId: string
	try {
		username = decodeURIComponent(rawUsername)
		kodyId = decodeURIComponent(rawKodyId)
	} catch {
		return null
	}
	if (getUsernameFormatValidationError(username)) return null
	const afterLeaf = parts.slice(3)
	const openHandoff = afterLeaf[0] === packageAppOpenPathSegment
	const restParts = openHandoff ? afterLeaf.slice(1) : afterLeaf
	return {
		username,
		kodyId,
		restPath: restParts.length > 0 ? `/${restParts.join('/')}` : '/',
		mount: 'username-path',
		...(openHandoff ? { openHandoff: true } : {}),
	}
}

/**
 * Parse the path shape served on a per-user package-app subdomain, where the
 * username comes from the hostname. The canonical shape is `/{kodyId}/{rest}`;
 * the legacy `/packages/{kodyId}/{rest}` mount is still accepted. Reserved
 * first segments (`-`, `.well-known`, ...) are Kody-owned and never parse as a
 * package, and a bare `/packages` has no leaf. The caller must already have
 * validated the subdomain's username label.
 */
export function parsePackageAppSubdomainPath(input: {
	pathname: string
	username: string
}): PackageAppPath | null {
	const parts = input.pathname.split('/').filter(Boolean)
	const rawFirst = parts[0]?.trim()
	if (!rawFirst) return null
	const legacyMount = rawFirst === packageAppHostLegacyMountSegment
	const leafIndex = legacyMount ? 1 : 0
	const rawKodyId = parts[leafIndex]?.trim()
	if (!rawKodyId) return null
	let kodyId: string
	try {
		kodyId = decodeURIComponent(rawKodyId)
	} catch {
		return null
	}
	if (!legacyMount && isPackageAppHostNonLeafFirstSegment(kodyId)) return null
	return {
		username: input.username,
		kodyId,
		restPath:
			parts.length > leafIndex + 1
				? `/${parts.slice(leafIndex + 1).join('/')}`
				: '/',
		mount: 'user-subdomain',
	}
}

/**
 * Path on a verified custom hostname. The username and package slug come from
 * the hostname mapping; the request path is the app path. An empty pathname
 * is `/`.
 */
export function parsePackageAppCustomHostnamePath(input: {
	pathname: string
	username: string
	kodyId: string
}): PackageAppPath {
	const pathname = input.pathname.trim()
	const parts = pathname.split('/').filter(Boolean)
	return {
		username: input.username,
		kodyId: input.kodyId,
		restPath: parts.length > 0 ? `/${parts.join('/')}` : '/',
		mount: 'custom-hostname',
	}
}

function packageAppBasePath(input: {
	mount: PackageAppMount
	username: string
	kodyId: string
}): string {
	switch (input.mount) {
		case 'user-subdomain':
			return buildPackageAppSubdomainPath({ kodyId: input.kodyId })
		case 'username-path':
			return buildPackageAppPath({
				username: input.username,
				kodyId: input.kodyId,
			})
		case 'custom-hostname':
			return ''
		default: {
			input.mount satisfies never
			throw new Error(`Unknown package app mount: ${String(input.mount)}`)
		}
	}
}

function packageAppLocationPath(input: {
	mount: PackageAppMount
	username: string
	kodyId: string
	restPath?: string | null
}): string {
	switch (input.mount) {
		case 'user-subdomain':
			return buildPackageAppSubdomainPath({
				kodyId: input.kodyId,
				restPath: input.restPath,
			})
		case 'username-path':
			return buildPackageAppPath({
				username: input.username,
				kodyId: input.kodyId,
				restPath: input.restPath,
			})
		case 'custom-hostname':
			return buildPackageAppCustomHostnamePath({ restPath: input.restPath })
		default: {
			input.mount satisfies never
			throw new Error(`Unknown package app mount: ${String(input.mount)}`)
		}
	}
}

export function isPackageAppRequestPath(pathname: string) {
	return parsePackageAppPath(pathname) !== null
}

// Credentials that must never reach author-supplied package code. `Cookie`
// carries the owner's `kody_session`, `Authorization` carries MCP bearer tokens,
// and the `X-Kody-*` family is worker-internal auth (connector session keys and
// user ids). `Kody-Synthetic` is platform-only and must never be caller-controlled
// on public ingress. Stripping is unconditional as defense in depth and is also
// required for the non-production inline serving path.
const strippedPackageRequestHeaders = [
	'cookie',
	'authorization',
	'proxy-authorization',
	packageAppSyntheticHeaderName.toLowerCase(),
]

/**
 * Clone a request for package code with every credential header removed.
 *
 * Used for both the forwarded HTTP request and the realtime connect upgrade,
 * because the realtime `connect` hook receives the request headers too.
 */
export function createPackageCodeRequest(
	request: Request,
	url: string | URL = request.url,
) {
	const packageCodeRequest = new Request(url.toString(), request)
	for (const headerName of strippedPackageRequestHeaders) {
		packageCodeRequest.headers.delete(headerName)
	}
	// Snapshot names so deletes during this loop do not skip headers.
	// oxlint-disable-next-line unicorn/no-useless-spread
	for (const headerName of [...packageCodeRequest.headers.keys()]) {
		const normalized = headerName.toLowerCase()
		if (
			normalized.startsWith('x-kody-') ||
			normalized === packageAppSyntheticHeaderName.toLowerCase()
		) {
			packageCodeRequest.headers.delete(headerName)
		}
	}
	return packageCodeRequest
}

export function applyTrustedPackageAppDispatch(
	request: Request,
	dispatch: PackageAppTrustedDispatch | undefined,
) {
	if (dispatch?.synthetic !== true) {
		return request
	}
	const trustedRequest = new Request(request)
	trustedRequest.headers.set(
		packageAppSyntheticHeaderName,
		packageAppSyntheticHeaderValue,
	)
	return trustedRequest
}

function parsePackageRealtimePath(restPath: string) {
	const parts = restPath.split('/').filter(Boolean)
	if (parts[0] !== 'ws') return null
	if (parts.length > 2) return null
	const rawFacet = parts[1]?.trim() ?? ''
	if (!rawFacet) {
		return {
			facet: null,
		}
	}
	try {
		return {
			facet: decodeURIComponent(rawFacet),
		}
	} catch {
		return null
	}
}

function reportPackageAppFailure(input: {
	error: unknown
	phase: 'host-setup' | 'realtime-connect'
	requestUrl: URL
	kodyId: string
	packageId: string
	packageName: string
	sourceId: string
	forwardedPath: string
	realtimePath: string
}) {
	try {
		if (!Sentry.isInitialized()) return
		const client = Sentry.getClient()
		if (!client?.getOptions().dsn) return

		Sentry.withScope((scope) => {
			scope.setLevel('error')
			scope.setTag('package_app.phase', input.phase)
			scope.setTag('package_app.kody_id', input.kodyId)
			scope.setTag('package_app.package_id', input.packageId)
			scope.setTag('package_app.source_id', input.sourceId)
			scope.setContext('package_app', {
				phase: input.phase,
				kodyId: input.kodyId,
				packageId: input.packageId,
				packageName: input.packageName,
				sourceId: input.sourceId,
				forwardedPath: input.forwardedPath,
				realtimePath: input.realtimePath,
				hostPath: input.requestUrl.pathname,
			})
			Sentry.captureException(input.error)
		})
	} catch (sentryError) {
		console.warn('Failed to report package app failure to Sentry.', sentryError)
	}
}

type PackageAppFailureKind =
	| 'host-setup'
	| 'package-entrypoint'
	| 'realtime-connect'
	| 'include-used-up'

function createPackageAppErrorResponse(input: {
	request: Request
	kind: PackageAppFailureKind
	kodyId: string
	packageName: string
	synthetic?: boolean
	cause?: string
	runtimeRunId?: string | null
}) {
	const messages = {
		'host-setup': {
			title: 'Package app could not be prepared',
			summary:
				'Kody could not load or prepare this package app runtime before your request reached the package code.',
			nextStep:
				'This has been reported to Kody. Try again shortly, or ask the package owner to republish the package if it keeps happening.',
		},
		'package-entrypoint': {
			title: 'Package app crashed',
			summary:
				'The package app started, but its own request handler failed while processing this request.',
			nextStep:
				'Ask the package owner to check recent runs for this app under Account → Activity.',
		},
		'realtime-connect': {
			title: 'Package realtime connection failed',
			summary:
				'Kody could not establish the realtime session for this package app.',
			nextStep:
				'This has been reported to Kody. Try reconnecting, or ask the package owner to retry after checking the package app.',
		},
		'include-used-up': {
			title: 'Monthly include used up',
			summary:
				'This month’s included Pro usage is used up and there are no credits left, so the app is paused.',
			nextStep: `Add credits at ${accountCreditsPath} to keep going, or wait for the include to reset next UTC month.`,
		},
	} satisfies Record<
		PackageAppFailureKind,
		{ title: string; summary: string; nextStep: string }
	>
	const message = messages[input.kind]
	const status = input.kind === 'include-used-up' ? 429 : 500
	logPackageAppHttpError({
		request: input.request,
		status,
		phase: input.kind,
		runtimeRunId: input.runtimeRunId ?? null,
	})
	const requestPath = new URL(input.request.url).pathname
	const body = {
		error: message.title,
		message: message.summary,
		next_step: message.nextStep,
		package: {
			name: input.packageName,
			kody_id: input.kodyId,
		},
		request_path: requestPath,
		...(input.synthetic === true && input.cause ? { cause: input.cause } : {}),
	}
	if (input.synthetic === true || wantsJson(input.request)) {
		return Response.json(body, { status })
	}
	return createHtmlResponse(
		html`<!doctype html>
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<title>${message.title}</title>
					<style>
						:root {
							color-scheme: light dark;
							font-family:
								ui-sans-serif,
								system-ui,
								-apple-system,
								BlinkMacSystemFont,
								'Segoe UI',
								sans-serif;
							line-height: 1.5;
						}
						body {
							margin: 0;
							background: #f8fafc;
							color: #0f172a;
						}
						main {
							box-sizing: border-box;
							max-width: 46rem;
							margin: 0 auto;
							padding: min(12vh, 6rem) 1.25rem;
						}
						.card {
							border: 1px solid #cbd5e1;
							border-radius: 1rem;
							background: white;
							padding: clamp(1.25rem, 4vw, 2rem);
							box-shadow: 0 20px 60px rgb(15 23 42 / 0.12);
						}
						h1 {
							margin: 0 0 0.75rem;
							font-size: clamp(1.75rem, 4vw, 2.75rem);
							line-height: 1;
						}
						dl {
							display: grid;
							grid-template-columns: max-content 1fr;
							gap: 0.35rem 0.75rem;
							margin: 1.5rem 0 0;
						}
						dt {
							font-weight: 700;
						}
						@media (prefers-color-scheme: dark) {
							body {
								background: #020617;
								color: #e2e8f0;
							}
							.card {
								border-color: #334155;
								background: #0f172a;
							}
						}
					</style>
				</head>
				<body>
					<main>
						<section class="card" aria-labelledby="package-app-error-title">
							<h1 id="package-app-error-title">${message.title}</h1>
							<p>${message.summary}</p>
							<p>${message.nextStep}</p>
							<dl>
								<dt>Package</dt>
								<dd>${input.packageName}</dd>
								<dt>Kody ID</dt>
								<dd><code>${input.kodyId}</code></dd>
								<dt>Path</dt>
								<dd><code>${requestPath}</code></dd>
							</dl>
							${html.raw`${renderErrorAgentPromptStaticHtml(
								buildPackageAppErrorAgentPrompt({
									kind: input.kind,
									packageName: input.packageName,
									kodyId: input.kodyId,
									path: requestPath,
									// Visitor HTML must not include host exception text;
									// JSON synthetic responses still carry `cause`.
									runtimeRunId: input.runtimeRunId,
								}),
							)}`}
						</section>
					</main>
				</body>
			</html>`,
		{ status },
	)
}

/**
 * Attach request-scoped Server-Timing phases collected on the package-app
 * serve path. Clones headers so author responses stay immutable-safe.
 *
 * WebSocket upgrades (status 101 with a paired `webSocket`) are returned as-is:
 * Durable Object upgrade responses have immutable headers, so in-place
 * `Server-Timing` throws; rebuilding without `webSocket` rejects status 101;
 * browsers do not expose upgrade response headers to page JS the way fetch does.
 */
function attachPackageAppServerTiming(
	response: Response,
	serverTiming: Array<ServerTimingEntry>,
) {
	if (serverTiming.length === 0) return response
	// Skip timing on WebSocket upgrades — see function doc.
	if (response.webSocket || response.status === 101) return response
	const headers = new Headers(response.headers)
	applyServerTimingHeader(headers, serverTiming)
	// 204, 205, and 304 cannot carry a body. Drop it before rewrapping so
	// attaching Server-Timing cannot throw on a null-body app response.
	const nullBody =
		response.status === 204 ||
		response.status === 205 ||
		response.status === 304
	return new Response(nullBody ? null : response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	})
}

/**
 * OPTIONS is not a package mutation. When the app handler throws instead of
 * answering, browsers still need a finished preflight rather than the
 * platform crash page. Apps that return their own OPTIONS response are
 * unchanged.
 */
function unhandledPackageAppOptionsResponse() {
	return new Response(null, {
		status: 204,
		headers: {
			Allow: 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
			'Cache-Control': 'no-store',
		},
	})
}

/**
 * Serve a hosted package app for an already-authenticated owner, acting as
 * the visitor.
 *
 * The owner is resolved by the caller because the package-app origin uses its
 * own host-scoped `kody_pkg_session` cookie, while the non-production inline
 * mode uses the `kody_session` cookie (see `package-app-origin.ts`).
 */
export async function servePackageAppRequest(input: {
	request: Request
	env: Env
	owner: PackageAppServeOwner
	/** Null for an anonymous visitor of an internet-visible app. */
	visitor: RuntimePackageAppVisitor | null
	/** See `RuntimePackageAppServeInput.approvedPublishedCommit`. */
	approvedPublishedCommit?: string | null
	packagePath: PackageAppPath
	dispatch?: PackageAppTrustedDispatch
	/**
	 * Optional bag started by host setup (owner lookup). Serve appends its own
	 * phases and writes the combined `Server-Timing` header on the response.
	 */
	serverTiming?: Array<ServerTimingEntry>
}) {
	// Slim origin (production-worker / preview) does not export
	// PackageAppRuntimeBridge (ADR 0034). HTTP package-app routes are already
	// forwarded wholesale via isRuntimeWorkerOwnedRequest; this gate covers the
	// remaining in-process path (stateless MCP packageAppFetch → serve).
	// One contract: local bridge, or RUNTIME_WORKER RPC — never construct here
	// without either.
	if (!hasLocalPackageAppRuntimeBridge()) {
		const runtime = getRuntimeWorkerService(input.env)
		if (!runtime) {
			return createPackageAppErrorResponse({
				request: input.request,
				kind: 'host-setup',
				kodyId: input.packagePath.kodyId,
				packageName: input.packagePath.kodyId,
				synthetic: input.dispatch?.synthetic === true,
				cause: packageAppRuntimeForwardUnavailableMessage,
			})
		}
		return runtime.servePackageApp({
			request: input.request,
			owner: input.owner,
			visitor: input.visitor,
			approvedPublishedCommit: input.approvedPublishedCommit,
			packagePath: input.packagePath,
			dispatch: input.dispatch,
		})
	}

	const { request, env, owner, visitor, packagePath, dispatch } = input
	const serverTiming = input.serverTiming ?? []
	const requestUrl = new URL(request.url)
	const { kodyId } = packagePath
	const packageRealtimeRestPath = packagePath.restPath
	const forwardedPackageRestPath = packagePath.restPath
	if (owner.username !== packagePath.username) {
		return attachPackageAppServerTiming(
			new Response(buildPackageAppNotFoundMessage(), { status: 404 }),
			serverTiming,
		)
	}
	// Same freshness-tier cache family as keyless host export invoke, but a
	// distinct key that may follow slug redirects. A retired slug never serves
	// on a path that includes the slug: permanent 308 to the current leaf so
	// cookies, caches, and storage stay on one canonical path (webhooks and
	// invocations still follow internally). Custom hostnames bind by package
	// id and have no slug in the URL, so a same-path redirect is skipped.
	const slugLookup = await pushServerTiming(
		serverTiming,
		'resolveSavedPackage',
		() =>
			resolveSavedPackageForPackageAppSlug({
				db: env.APP_DB,
				userId: owner.userId,
				slug: kodyId,
			}),
	)
	if (!slugLookup || !slugLookup.savedPackage.hasApp) {
		return attachPackageAppServerTiming(
			new Response(buildPackageAppNotFoundMessage(), { status: 404 }),
			serverTiming,
		)
	}
	const savedPackage = slugLookup.savedPackage
	if (slugLookup.retired) {
		// Location must use the name leaf (Kent: slug = package name leaf), not
		// savedPackage.kodyId — those can diverge until Phase 2's single writer,
		// and a mismatch would 308 to the same retired path forever.
		const currentSlug = getPackageNameLeaf(savedPackage.name)
		const locationPath = packageAppLocationPath({
			mount: packagePath.mount,
			username: packagePath.username,
			kodyId: currentSlug,
			restPath:
				forwardedPackageRestPath === '/' ? null : forwardedPackageRestPath,
		})
		const location = new URL(locationPath, requestUrl)
		// Drop a handoff minted for the retired slug — consume would reject it.
		location.search = requestUrl.search
		location.searchParams.delete(packageAppHandoffQueryParam)
		const next = `${location.pathname}${location.search}`
		const current = `${requestUrl.pathname}${requestUrl.search}`
		// Custom hostnames bind by package id, so a retired slug does not appear
		// in the URL. A 308 to the same path would loop; keep serving.
		if (next !== current) {
			return attachPackageAppServerTiming(
				new Response(null, {
					status: 308,
					headers: {
						Location: next,
						// Source slug can be reclaimed by a later package; positive
						// freshness would keep sending browsers to the wrong app.
						'Cache-Control': 'no-store',
					},
				}),
				serverTiming,
			)
		}
	}
	// Custom hostnames are not the app origin. `getAppBaseUrl(requestUrl)`
	// would otherwise treat the customer Host as first-party and point
	// package runtime API calls at the custom domain.
	const onPackageAppProductHost =
		parsePackageAppRequestHost({ env, url: requestUrl }) !== null
	const baseUrl =
		packagePath.mount === 'custom-hostname' ||
		(packagePath.mount === 'user-subdomain' && !onPackageAppProductHost)
			? getCanonicalAppBaseUrl({ env })
			: getAppBaseUrl({ env, requestUrl: request.url })
	const packageRealtimePath = parsePackageRealtimePath(packageRealtimeRestPath)
	// Realtime hooks run with the owner's caller context, so an anonymous
	// visitor never reaches them.
	if (packageRealtimePath && !visitor) {
		return attachPackageAppServerTiming(
			anonymousRefusalResponse('Sign in to use realtime features of this app.'),
			serverTiming,
		)
	}
	if (packageRealtimePath && isWebSocketUpgradeRequest(request)) {
		try {
			const connected = await packageRealtimeSessionRpc({
				env,
				userId: owner.userId,
				packageId: savedPackage.id,
				kodyId: savedPackage.kodyId,
				sourceId: savedPackage.sourceId,
				baseUrl,
			}).connect(createPackageCodeRequest(request), packageRealtimePath.facet)
			logPackageAppHttpError({
				request,
				status: connected.status,
				phase: 'realtime-response',
				runtimeRunId: connected.headers.get(packageAppRuntimeRunIdHeader),
			})
			return attachPackageAppServerTiming(connected, serverTiming)
		} catch (error) {
			console.error('Package realtime handler failed:', error)
			reportPackageAppFailure({
				error,
				phase: 'realtime-connect',
				requestUrl,
				kodyId: savedPackage.kodyId,
				packageId: savedPackage.id,
				packageName: savedPackage.name,
				sourceId: savedPackage.sourceId,
				forwardedPath: forwardedPackageRestPath,
				realtimePath: packageRealtimeRestPath,
			})
			return attachPackageAppServerTiming(
				createPackageAppErrorResponse({
					request,
					kind: 'realtime-connect',
					kodyId: savedPackage.kodyId,
					packageName: savedPackage.name,
					synthetic: dispatch?.synthetic === true,
					cause: getErrorMessage(error),
					runtimeRunId: runtimeRunIdFromError(error),
				}),
				serverTiming,
			)
		}
	}

	const loadSourceFiles = async () => {
		const packageSource = await loadPackageSourceBySourceId({
			env,
			baseUrl,
			userId: owner.userId,
			sourceId: savedPackage.sourceId,
		})
		return packageSource.files
	}

	// Platform-served static surface (`/_assets/*`): the fingerprinted client
	// module and the declared assets directory never reach author code.
	const assetRelativePath = parsePackageAppAssetRequestPath(
		forwardedPackageRestPath,
	)
	if (assetRelativePath !== null) {
		// Same mount rule as buildPackageAppPublicContext: the username lives in
		// the hostname on a per-user subdomain and in the path when inline.
		// URL path segment is the name leaf (Kent: slug = leaf), not kodyId —
		// those can diverge until Phase 2's single writer.
		const urlSlug = getPackageNameLeaf(savedPackage.name)
		const appBasePath = packageAppBasePath({
			mount: packagePath.mount,
			username: packagePath.username,
			kodyId: urlSlug,
		})
		try {
			const packageManifest = await pushServerTiming(
				serverTiming,
				'manifest',
				() =>
					loadInvokeManifestBySourceId({
						env,
						userId: owner.userId,
						sourceId: savedPackage.sourceId,
					}),
			)
			const refusal = refuseUnapprovedAnonymousServe({
				visitor,
				approvedPublishedCommit: input.approvedPublishedCommit,
				publishedCommit: packageManifest.source.published_commit,
			})
			if (refusal) return attachPackageAppServerTiming(refusal, serverTiming)
			return attachPackageAppServerTiming(
				await servePackageAppAssetRequest({
					request,
					env,
					userId: owner.userId,
					manifest: packageManifest.manifest,
					savedPackage: {
						id: savedPackage.id,
						kodyId: savedPackage.kodyId,
						sourceId: savedPackage.sourceId,
						publishedCommit: packageManifest.source.published_commit,
						manifestPath: packageManifest.source.manifest_path,
						sourceRoot: packageManifest.source.source_root,
					},
					loadSourceFiles,
					relativePath: assetRelativePath,
					appBasePath,
					hostedUrl: `${requestUrl.origin}${appBasePath}`,
				}),
				serverTiming,
			)
		} catch (error) {
			console.error('Package app asset handler failed:', error)
			reportPackageAppFailure({
				error,
				phase: 'host-setup',
				requestUrl,
				kodyId: savedPackage.kodyId,
				packageId: savedPackage.id,
				packageName: savedPackage.name,
				sourceId: savedPackage.sourceId,
				forwardedPath: forwardedPackageRestPath,
				realtimePath: packageRealtimeRestPath,
			})
			return attachPackageAppServerTiming(
				createPackageAppErrorResponse({
					request,
					kind: 'host-setup',
					kodyId: savedPackage.kodyId,
					packageName: savedPackage.name,
					synthetic: dispatch?.synthetic === true,
					cause: getErrorMessage(error),
					runtimeRunId: runtimeRunIdFromError(error),
				}),
				serverTiming,
			)
		}
	}

	let forwardedRequest: Request
	let entrypoint: { fetch(request: Request): Promise<Response> }
	try {
		const [packageManifest, callerContext] = await Promise.all([
			pushServerTiming(serverTiming, 'manifest', () =>
				loadInvokeManifestBySourceId({
					env,
					userId: owner.userId,
					sourceId: savedPackage.sourceId,
				}),
			),
			createPackageAppCallerContext({
				baseUrl,
				owner,
				visitor,
				packageId: savedPackage.id,
			}),
		])
		const refusal = refuseUnapprovedAnonymousServe({
			visitor,
			approvedPublishedCommit: input.approvedPublishedCommit,
			publishedCommit: packageManifest.source.published_commit,
		})
		if (refusal) return attachPackageAppServerTiming(refusal, serverTiming)
		const appWorker = await buildPackageAppWorker({
			env,
			baseUrl,
			userId: owner.userId,
			surface: 'app_fetch',
			savedPackage: {
				id: savedPackage.id,
				kodyId: savedPackage.kodyId,
				name: savedPackage.name,
				sourceId: savedPackage.sourceId,
				publishedCommit: packageManifest.source.published_commit,
				manifestPath: packageManifest.source.manifest_path,
				sourceRoot: packageManifest.source.source_root,
			},
			source: packageManifest.source,
			manifest: packageManifest.manifest,
			loadSourceFiles,
			serverTiming,
			runtime: {
				callerContext,
				servingUsername: packagePath.username,
				hostedOrigin: requestUrl.origin,
				mount: packagePath.mount,
			},
		})
		entrypoint = appWorker.stub.getEntrypoint(appWorker.entrypointName)
		const forwardedUrl = new URL(requestUrl)
		forwardedUrl.pathname = forwardedPackageRestPath
		forwardedRequest = applyTrustedPackageAppDispatch(
			createPackageCodeRequest(request, forwardedUrl),
			dispatch,
		)
	} catch (error) {
		if (isComputeOverageLimitError(error)) {
			return attachPackageAppServerTiming(
				createPackageAppErrorResponse({
					request,
					kind: 'include-used-up',
					kodyId: savedPackage.kodyId,
					packageName: savedPackage.name,
					synthetic: dispatch?.synthetic === true,
					cause: error.message,
				}),
				serverTiming,
			)
		}
		console.error('Package app handler failed:', error)
		reportPackageAppFailure({
			error,
			phase: 'host-setup',
			requestUrl,
			kodyId: savedPackage.kodyId,
			packageId: savedPackage.id,
			packageName: savedPackage.name,
			sourceId: savedPackage.sourceId,
			forwardedPath: forwardedPackageRestPath,
			realtimePath: packageRealtimeRestPath,
		})
		return attachPackageAppServerTiming(
			createPackageAppErrorResponse({
				request,
				kind: 'host-setup',
				kodyId: savedPackage.kodyId,
				packageName: savedPackage.name,
				synthetic: dispatch?.synthetic === true,
				cause: getErrorMessage(error),
				runtimeRunId: runtimeRunIdFromError(error),
			}),
			serverTiming,
		)
	}

	let fetched: Response
	try {
		fetched = await pushServerTiming(serverTiming, 'entrypoint', () =>
			entrypoint.fetch(forwardedRequest),
		)
	} catch (error) {
		if (request.method === 'OPTIONS') {
			return attachPackageAppServerTiming(
				unhandledPackageAppOptionsResponse(),
				serverTiming,
			)
		}
		console.error('Package app entrypoint failed:', error)
		return attachPackageAppServerTiming(
			createPackageAppErrorResponse({
				request,
				kind: 'package-entrypoint',
				kodyId: savedPackage.kodyId,
				packageName: savedPackage.name,
				runtimeRunId: runtimeRunIdFromError(error),
			}),
			serverTiming,
		)
	}
	if (isPackageAppRuntimeThrownResponse(fetched)) {
		if (request.method === 'OPTIONS') {
			return attachPackageAppServerTiming(
				unhandledPackageAppOptionsResponse(),
				serverTiming,
			)
		}
		return attachPackageAppServerTiming(
			createPackageAppErrorResponse({
				request,
				kind: 'package-entrypoint',
				kodyId: savedPackage.kodyId,
				packageName: savedPackage.name,
				runtimeRunId: fetched.headers.get(packageAppRuntimeRunIdHeader),
			}),
			serverTiming,
		)
	}
	// Leave x-kody-runtime-run-id on the response. The origin forward reads
	// it for the runtime-worker hop log, then strips it before the browser.
	logPackageAppHttpError({
		request,
		status: fetched.status,
		phase: 'entrypoint-response',
		runtimeRunId: fetched.headers.get(packageAppRuntimeRunIdHeader),
	})
	return attachPackageAppServerTiming(fetched, serverTiming)
}

export { isPackageAppSyntheticRequest }
