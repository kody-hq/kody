import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { WorkerEntrypoint } from 'cloudflare:workers'
import {
	gatewayErrorResponse,
	withoutForgedGatewayErrorHeader,
} from '#mcp/sandbox-rpc-outcome.ts'
import {
	redactEchoedSecrets,
	redactEchoedSecretsInError,
	withLanding,
	withResponseHeaders,
} from '#mcp/secrets/echo-redaction.ts'
import {
	createOutboundFetchDeadline,
	outboundFetchIdleTimeoutMs,
	type OutboundFetchDeadline,
} from '#mcp/outbound-fetch-deadline.ts'
import {
	runAsSandboxCall,
	type UnboundSandboxCall,
} from '#mcp/secrets/secret-authority.ts'
import { runInFeatureFlagExecution } from '#worker/feature-flags/execution-scope.ts'
import { credentialClientHeaderName } from '#worker/credentials/credential-client-header.ts'
import { sealTokenResponse } from '#worker/credentials/sealed-token.ts'
import { withPathSegmentEncodingWarning } from '#mcp/secrets/path-segment-encoding-warning.ts'
import {
	applyCredentialClientPlacement,
	resolveCredentialClientPlacement,
	withCredentialClientHint,
	withoutCodePlacement,
} from './credential-client-gateway.ts'
import { CredentialClientError } from '#worker/credentials/credential-client.ts'
import { CredentialLoginRetryLaterError } from '#worker/credentials/credential-request.ts'
import { recordRetriedLoginSession } from '#worker/credentials/login-session-store.ts'
import type { StorageContext } from '#mcp/storage.ts'
import {
	billedOrgIdOf,
	type RequestContext,
} from '@kody-internal/shared/request-context.ts'
import {
	createPackageAppVisitorPersonalRequest,
	type PackageAppAuthorityScope,
	type PackageAppVisitorGrantScope,
} from '#worker/package-runtime/package-app-authority.ts'
import { consumeDailyEntitlement } from '#worker/entitlements/service.ts'
import {
	recordUsage,
	usageAttributionFieldsFromRequest,
	type UsageEnv,
} from '#worker/usage/record-usage.ts'
import {
	packageAppVisitTicketHeaderName,
	requestContextFromVisitClaims,
	verifyPackageAppVisitTicket,
} from '#worker/package-runtime/package-app-visit-ticket.ts'
import { normalizeChangedIntrinsicNames } from '#worker/package-runtime/intrinsic-change-detector-source.ts'
import { kodyDevOutboundFetch } from '#worker/package-runtime/kody-dev-simulation.ts'
import { isPublicFetchHostname } from '#mcp/events/ssrf.ts'
import { resolveGatewayPackageStamp } from '#worker/credentials/package-stamp.ts'
import type { CredentialCallMapJson } from '#worker/credentials/credential-call-map.ts'
import {
	asCallerFacingBodyFillError,
	expandAsPackageAppAuthority,
} from '#mcp/secrets/legacy-placeholder-gateway.ts'
export {
	expandSecretPlaceholders,
	GatewayCredentialUnavailableError,
	isPlaceholderAuthorityFailure,
	secretResolutionHeaderName,
} from '#mcp/secrets/legacy-placeholder-gateway.ts'
export { resolveGatewayPackageStamp } from '#worker/credentials/package-stamp.ts'

type FetchGatewayProps = {
	baseUrl: string
	userId: OwnerId | null
	/**
	 * Acting user's account email when the caller context carries one.
	 * Backs the entitlement plan lookup for the outbound-fetch quota;
	 * when absent, the gateway reverse-resolves the account from the
	 * stable userId so the caller's real plan still binds.
	 */
	email: string | null
	/** The run's request; sealed secret providers inherit it. */
	request: RequestContext | null
	storageContext: StorageContext | null
	/**
	 * Bundler/host provenance ids that may be named as secret authority
	 * (run package plus static/dynamic deps). Same set as
	 * `collectPackageStorageGrantIds`. Omitted outside bundled runs.
	 */
	grantedSecretAuthorityPackageIds?: ReadonlyArray<string>
	/**
	 * CapabilityProxy / CLI `--local`: the package id the client claims, after
	 * the proxy verified `package:execute`. It binds package-scoped buckets and
	 * package rules but never skips the actor's Use (`claimed` stamp). Hosted
	 * runs leave this unset; their `storageContext.packageId` and grant set are
	 * attested.
	 */
	claimedPackageId?: string | null
	/**
	 * Trusted per-package binding (GHSA-5fv3). The host mints one gateway
	 * binding per package in the run's grant set and sets this prop on it;
	 * only that package's module-bound `fetch` holds the binding. Package
	 * secret identity comes from this host-set prop, never from a request
	 * header or any value sandbox code can set, read, replace, or nest.
	 * Must name a package in `grantedSecretAuthorityPackageIds`.
	 */
	boundPackageId?: string | null
	/** Shared globals a package app's bound fetch reported as changed. */
	changedIntrinsics?: ReadonlyArray<string> | null
	/**
	 * The run (or CapabilityProxy credential) `credential()` client handles
	 * must be bound to. Without it, a client fetch is refused.
	 */
	credentialClientBinding?: string | null
	/** Host-validated picks, used only for the legacy compatibility period. */
	legacyCredentialPicks?: CredentialCallMapJson | null
	/**
	 * Package-app runs only (ADR 0068 amendment 2026-10-24): placeholders
	 * resolve as the app's runs-as person, and `credential()` handles carry
	 * who they act as. `request` stays the visitor for usage attribution.
	 */
	packageAppAuthority?: {
		scope: PackageAppAuthorityScope
		grantScope: PackageAppVisitorGrantScope | null
	} | null
	/**
	 * An outside-org visitor's own request, from an executor-only visit
	 * ticket. Only resolves their executor credential handles; `request`
	 * stays null so nothing else acts as them.
	 */
	executorVisitorRequest?: RequestContext | null
	/**
	 * Per-run HMAC key for package-scoped `packageSecrets.get` placeholders
	 * (GHSA-5fv3). Omitted outside bundled sandbox runs.
	 */
	packageSecretRefKey?: string | null
	/**
	 * One id per execution: its gateway calls reuse feature-flag reads (see
	 * `runInFeatureFlagExecution`), and the next execution reads again.
	 */
	executionId?: string | null
	/**
	 * Package-app runs only: audience used to verify a per-request visit
	 * ticket. Omitted outside package-app serving.
	 */
	visitAudience?: {
		host: string
		packageId: string
		kodyId: string
		sourceId: string
		publishedCommit: string | null
	} | null
}
export type { FetchGatewayProps }

/** Bindings every gateway fetch needs: secrets, quota, and usage metering. */
export type FetchGatewayEnv = Pick<
	Env,
	'APP_DB' | 'SECRET_STORE_KEY' | 'USER_METER'
> &
	Partial<Pick<Env, 'KODY_DEV_MOCK_SECRETS' | 'KODY_DEV_OUTBOUND_URL'>> &
	UsageEnv

/**
 * Overall deadline for one gateway fetch, from sending the upstream request
 * (after quota and placeholder expansion) until the response body ends (time
 * to headers included), on every surface. The run
 * budget of the calling sandbox still applies on top, so a 90s execute stops
 * its fetches at 90s. A body that goes quiet stops sooner, after
 * {@link outboundFetchIdleTimeoutMs} without bytes. A tighter caller
 * `AbortSignal` also wins.
 */
export const outboundFetchTimeoutMs = 5 * 60_000

async function applyPackageAppVisitTicketToGateway(input: {
	env: FetchGatewayEnv
	props: FetchGatewayProps
	request: Request
	globalFetch?: typeof fetch
	waitUntil?: (promise: Promise<unknown>) => void
	timeoutMs?: number
	idleTimeoutMs?: number
}) {
	const ticket = input.request.headers.get(packageAppVisitTicketHeaderName)
	if (!ticket) {
		if (!input.props.visitAudience) return input
		// A warm Dynamic Worker may keep the first visitor's gateway props.
		// Ticketless package-app fetch is anonymous and must not inherit that
		// request or credential binding.
		return {
			...input,
			props: {
				...input.props,
				request: null,
				executorVisitorRequest: null,
				credentialClientBinding: null,
			},
		}
	}
	const audience = input.props.visitAudience
	if (!audience) {
		throw new Error('Package app visit ticket is not valid.')
	}
	const claims = await verifyPackageAppVisitTicket({
		env: input.env,
		ticket,
		audience,
	})
	const headers = new Headers(input.request.headers)
	headers.delete(packageAppVisitTicketHeaderName)
	if (!claims.visitor) {
		// An anonymous ticket names nobody: the fetch stays anonymous and only
		// gains this request's credential-client binding.
		return {
			...input,
			request: new Request(input.request, { headers }),
			props: {
				...input.props,
				request: null,
				executorVisitorRequest: null,
				credentialClientBinding: claims.credentialClientBinding,
			},
		}
	}
	return {
		...input,
		request: new Request(input.request, { headers }),
		props: {
			...input.props,
			email: claims.owner.email,
			request: claims.executorOnly
				? null
				: requestContextFromVisitClaims(claims),
			executorVisitorRequest: claims.executorOnly
				? await createPackageAppVisitorPersonalRequest({
						db: input.env.APP_DB,
						visitor: claims.visitor,
					})
				: null,
			credentialClientBinding: claims.credentialClientBinding,
		},
	}
}

export class KodyFetchGateway extends WorkerEntrypoint<Env, FetchGatewayProps> {
	/** Refusals come back as a marked response; see `sandbox-rpc-outcome.ts`. */
	async fetch(request: Request) {
		return await this.gatewayFetch(request, this.ctx.props?.changedIntrinsics)
	}

	/**
	 * A package-bound fetch from a run whose shared globals changed since the
	 * sandbox started. The names are recorded, never acted on.
	 */
	async fetchWithChangedIntrinsics(request: Request, changed: unknown) {
		return await this.gatewayFetch(
			request,
			normalizeChangedIntrinsicNames(changed),
		)
	}

	private async gatewayFetch(
		request: Request,
		changedIntrinsics: ReadonlyArray<string> | null | undefined,
	) {
		try {
			const props = this.ctx.props
			const surface = props?.packageAppAuthority ? 'app' : 'hosted'
			const boundPackageId = props?.boundPackageId?.trim() || null
			// Run code reaches this entrypoint. Only the per-package binding
			// says which package's code is fetching.
			const unboundCall: UnboundSandboxCall | null = boundPackageId
				? null
				: {
						surface,
						pattern: 'shared_fetch',
						loadedPackageIds: props?.grantedSecretAuthorityPackageIds ?? null,
					}
			return withoutForgedGatewayErrorHeader(
				await runAsSandboxCall(
					unboundCall,
					() =>
						executeGatewayFetch({
							env: this.env,
							props,
							request,
							waitUntil: (promise) => this.ctx.waitUntil(promise),
						}),
					boundPackageId && changedIntrinsics?.length
						? { surface, packageId: boundPackageId, changedIntrinsics }
						: null,
				),
			)
		} catch (error) {
			return gatewayErrorResponse(error)
		}
	}
}

export const gatewayWithoutRunContextMessage =
	'Outbound fetch has no run context: fetch() was called outside the run that owns it (for example from a detached callback or inside AsyncLocalStorage.run(null)), so it was refused.'

/** The executor's shared `globalOutbound` gateway is minted with empty props. */
function hasRunContext(props: FetchGatewayProps | undefined) {
	return typeof props?.baseUrl === 'string'
}

/**
 * Every hop the gateway sends (first request, login retry, followed
 * redirect) goes through this fetch, so loopback and private, link-local,
 * or reserved IP literals are refused on each one. `kody dev` mocks skip it.
 */
function publicHostsOnly(fetcher: typeof fetch): typeof fetch {
	return async (resource, init) => {
		const url = new URL(
			resource instanceof Request ? resource.url : String(resource),
		)
		if (!isPublicFetchHostname(url.hostname)) {
			throw new Error(
				`Outbound fetch to "${url.hostname}" was refused: sandbox fetch only reaches public hosts, not loopback, private, link-local, or reserved addresses.`,
			)
		}
		return await fetcher(resource, init)
	}
}

export async function executeGatewayFetch(input: {
	env: FetchGatewayEnv
	props: FetchGatewayProps
	request: Request
	globalFetch?: typeof fetch
	waitUntil?: (promise: Promise<unknown>) => void
	/** Override {@link outboundFetchTimeoutMs}. Tests use short values. */
	timeoutMs?: number
	/** Override {@link outboundFetchIdleTimeoutMs}. Tests use short values. */
	idleTimeoutMs?: number
}): Promise<Response> {
	if (!hasRunContext(input.props)) {
		throw new Error(gatewayWithoutRunContextMessage)
	}
	return await runInFeatureFlagExecution(input.props.executionId, () =>
		fetchThroughGateway(input),
	)
}

async function fetchThroughGateway(
	input: Parameters<typeof executeGatewayFetch>[0],
): Promise<Response> {
	const resolved = await applyPackageAppVisitTicketToGateway(input)
	const devOutboundFetch = resolved.globalFetch
		? null
		: kodyDevOutboundFetch(resolved.env)
	const globalFetch =
		devOutboundFetch ?? publicHostsOnly(resolved.globalFetch ?? fetch)
	const startedAtMs = Date.now()
	let response: Response | undefined
	let deadline: OutboundFetchDeadline | undefined
	let meteredEntityId = readMeteredRequestHostname(resolved.request.url, null)
	input = resolved

	try {
		// Daily outbound-fetch quota: every sandbox fetch leaves through
		// this gateway, so the atomic counter here bounds cost abuse and
		// third-party hammering from user code. Consumed before secret
		// expansion so over-limit requests never resolve secrets.
		// A visit from another org to an internal app charges the visiting
		// org's quota and meter (ADR 0095).
		const billedUserId = billedOrgIdOf(input.props.request, input.props.userId)
		if (billedUserId) {
			// Without an email the plan resolves from the billed org row
			// itself, so team orgs and converted orgs bill their own plan.
			const email =
				billedUserId === input.props.userId ? input.props.email : null
			await consumeDailyEntitlement({
				db: input.env.APP_DB,
				env: input.env,
				userId: billedUserId,
				email,
				resource: 'outbound_fetches_per_day',
			})
		}
		const credentialClientToken = input.request.headers.get(
			credentialClientHeaderName,
		)
		const packageStamp =
			credentialClientToken === null
				? null
				: resolveGatewayPackageStamp(input.props)
		let credentialClient =
			credentialClientToken === null
				? null
				: await resolveCredentialClientPlacement({
						env: input.env,
						props: input.props,
						token: credentialClientToken,
						request: input.request,
						...(packageStamp?.kind === 'attested' && input.props.boundPackageId
							? { attestedPackageId: packageStamp.packageId }
							: {}),
					})
		const codeRequest = credentialClient
			? withoutCodePlacement(input.request, credentialClient.placement)
			: input.request
		const isApprovedRequestPlacement =
			credentialClient?.placement.kind === 'body' ||
			credentialClient?.placement.kind === 'path' ||
			credentialClient?.placement.kind === 'composition'
		const expanded = isApprovedRequestPlacement
			? {
					request: codeRequest,
					substitutedValues: [],
					bodyFillDone: Promise.resolve(),
					deferRedirectFollow: false,
					pathSegmentEncodedNames: [],
					mintedWith: [],
					usedLegacyPlaceholders: () => false,
				}
			: await expandAsPackageAppAuthority({
					request: codeRequest,
					props: input.props,
					env: input.env,
					waitUntil: input.waitUntil,
				})
		const { bodyFillDone, deferRedirectFollow } = expanded
		let transformed = expanded.request
		let substitutedValues = expanded.substitutedValues
		const pathSegmentEncodedNames = expanded.pathSegmentEncodedNames
		if (credentialClient) {
			transformed = applyCredentialClientPlacement(
				transformed,
				credentialClient.placement,
				codeRequest,
			)
			substitutedValues = [
				...substitutedValues,
				...credentialClient.substitutedValues,
			]
		}
		meteredEntityId = readMeteredRequestHostname(
			input.request.url,
			transformed.url,
		)
		deadline = createOutboundFetchDeadline({
			totalMs: input.timeoutMs ?? outboundFetchTimeoutMs,
			idleMs: input.idleTimeoutMs ?? outboundFetchIdleTimeoutMs,
			callerSignal: transformed.signal,
		})
		try {
			// Do not track until after optional redirect follow: cancelling a
			// tracked 3xx body would settle the outbound deadline and leave
			// later hops without idle/overall timeouts.
			let upstream = await globalFetch(
				new Request(transformed, { signal: deadline.signal }),
			)
			// Body placeholders may resolve while the upload streams; wait so
			// echo redaction and redirect policy see every substituted value.
			await bodyFillDone
			if (credentialClient) {
				substitutedValues = [
					...expanded.substitutedValues,
					...credentialClient.substitutedValues,
				]
			}
			if (
				credentialClient?.placement.kind === 'body' ||
				credentialClient?.placement.kind === 'path' ||
				credentialClient?.placement.kind === 'composition'
			) {
				if (isRedirectStatus(upstream.status)) {
					void upstream.body?.cancel().catch(() => {})
					throw new CredentialClientError({
						code: 'invalid_request',
						message:
							'The approved credential placement does not follow redirects.',
						retryWith: [],
					})
				}
				if (
					(credentialClient.placement.kind === 'body' ||
						credentialClient.placement.kind === 'composition') &&
					credentialClient.placement.sealed
				) {
					// Do not return even transformed or encoded ciphertext echoes.
					void upstream.body?.cancel().catch(() => {})
					upstream = new Response(null, { status: upstream.status })
				}
			}
			// A login session a host refused gets one fresh session and one
			// retry, through the same door (host and placement re-checked).
			// Only a request with no body can be replayed.
			if (
				upstream.status === 401 &&
				credentialClient?.login &&
				credentialClientToken !== null &&
				input.request.body === null
			) {
				// While the login's exchange cools down after a recent failure or
				// a repeated 401, the host's 401 is returned instead.
				const retried = await resolveCredentialClientPlacement({
					env: input.env,
					props: input.props,
					token: credentialClientToken,
					request: input.request,
					rejectedLoginSessionId: credentialClient.login.sessionId,
				}).catch((error: unknown) => {
					if (isLoginRetryLater(error)) return null
					throw error
				})
				if (retried) {
					await upstream.body?.cancel()
					substitutedValues = [
						...substitutedValues,
						...retried.substitutedValues,
					]
					credentialClient = retried
					transformed = applyCredentialClientPlacement(
						expanded.request,
						retried.placement,
						codeRequest,
					)
					upstream = await globalFetch(
						new Request(transformed, { signal: deadline.signal }),
					)
					const retriedSessionId = retried.login?.sessionId
					if (retriedSessionId) {
						try {
							await recordRetriedLoginSession(input.env, {
								sessionId: retriedSessionId,
								rejected: upstream.status === 401,
							})
						} catch {
							// Backoff bookkeeping only; never fail a completed retry.
						}
					}
				}
			}
			// Credential-bearing requests stay on redirect=manual (fail closed).
			// Ordinary bodies that used manual only so mid-stream fills could be
			// observed still get Fetch-like follow for redirects that do not
			// replay a body (no whole-upload buffer).
			if (
				deferRedirectFollow &&
				substitutedValues.length === 0 &&
				isRedirectStatus(upstream.status)
			) {
				upstream = await followRedirectsWithoutCredentialReplay({
					response: upstream,
					request: transformed,
					fetch: globalFetch,
					signal: deadline.signal,
				})
			}
			response = deadline.track(upstream)
			// A token minted with a credential comes back sealed (ADR 0068).
			if (substitutedValues.length > 0 && input.props.userId) {
				response = await sealTokenResponse({
					env: input.env,
					response,
					requestUrl: transformed.url,
					mintedWith: expanded.mintedWith,
					filledValues: substitutedValues,
					org: input.props.userId,
					binding: input.props.credentialClientBinding ?? null,
				})
			}
		} catch (error) {
			throw redactEchoedSecretsInError(
				asCallerFacingBodyFillError(error),
				substitutedValues,
			)
		}
		let redacted = withPathSegmentEncodingWarning(
			redactEchoedSecrets(response, substitutedValues),
			pathSegmentEncodedNames,
		)
		const legacyWarningHeader = 'x-kody-legacy-credential-warning'
		if (
			expanded.usedLegacyPlaceholders() ||
			redacted.headers.has(legacyWarningHeader)
		) {
			const headers = new Headers(redacted.headers)
			headers.delete(legacyWarningHeader)
			if (expanded.usedLegacyPlaceholders()) {
				headers.set(
					legacyWarningHeader,
					'Credential placeholders are deprecated. Declare a need and use credential(key).',
				)
			}
			redacted = withResponseHeaders(redacted, headers)
		}
		return credentialClient
			? withCredentialClientHint(redacted, credentialClient.shape, {
					providerLabel: credentialClient.providerLabel,
				})
			: redacted
	} catch (error) {
		deadline?.fail()
		throw asCallerFacingBodyFillError(error)
	} finally {
		const userId = billedOrgIdOf(input.props.request, input.props.userId)
		if (userId) {
			const meteredResponse = response
			// Outcome is settled at headers; duration waits for the body so a
			// streamed response reports how long it stayed open.
			const usagePromise = (deadline?.done ?? Promise.resolve()).then(() =>
				recordUsage(input.env, {
					userId,
					eventType: 'outbound_fetch',
					entityId: meteredEntityId,
					durationMs: Date.now() - startedAtMs,
					outcome: meteredResponse ? 'success' : 'error',
					...usageAttributionFieldsFromRequest(input.props.request),
					...(meteredResponse
						? readResponseContentLengthBytes(meteredResponse)
						: {}),
				}),
			)
			if (input.waitUntil) {
				input.waitUntil(usagePromise)
			} else if (!meteredResponse) {
				await usagePromise
			}
		}
	}
}

/**
 * The hostname to meter. The gateway refuses a placeholder in the URL host,
 * so the host never carries a secret and is safe to record.
 */
function readMeteredRequestHostname(
	originalUrl: string,
	transformedUrl: string | null,
) {
	const originalHostname = readRequestHostname(originalUrl)
	if (originalHostname) return originalHostname
	return transformedUrl === null ? '' : readRequestHostname(transformedUrl)
}

function readRequestHostname(url: string) {
	try {
		return new URL(url).hostname
	} catch {
		return ''
	}
}

function readResponseContentLengthBytes(
	response: Response,
): { bytes: number } | Record<string, never> {
	const raw = response.headers.get('content-length')
	if (raw == null) {
		return {}
	}
	const bytes = Number(raw)
	if (!Number.isFinite(bytes) || bytes < 0) {
		return {}
	}
	return { bytes }
}

const redirectStatusCodes = new Set([301, 302, 303, 307, 308])

function isRedirectStatus(status: number) {
	return redirectStatusCodes.has(status)
}

/**
 * Fetch redirect method rewrite: 303 always becomes GET (except HEAD);
 * 301/302 rewrite only POST → GET. PUT/PATCH keep their method (and need a
 * body for 307/308 replay, which this helper does not buffer).
 */
function redirectRewritesToGet(status: number, method: string) {
	if (status === 303) return method !== 'HEAD'
	if ((status === 301 || status === 302) && method === 'POST') return true
	return false
}

const crossOriginFilteredHeaders = [
	'authorization',
	'proxy-authorization',
	'cookie',
] as const

function sameOrigin(a: URL, b: URL) {
	return a.origin === b.origin
}

/**
 * Follow redirects for requests that carried no filled credential, without
 * buffering a streamed upload for 307/308 body replay. Hops that would need
 * that replay, or that would downgrade https→http, are returned as-is.
 */
async function followRedirectsWithoutCredentialReplay(input: {
	response: Response
	request: Request
	fetch: typeof fetch
	signal: AbortSignal
}): Promise<Response> {
	let response = input.response
	let request = input.request
	let followed = false
	for (let hop = 0; hop < 20; hop += 1) {
		if (!isRedirectStatus(response.status)) {
			return followed
				? withLanding(response, {
						url: response.url || request.url,
						redirected: true,
					})
				: response
		}
		const location = response.headers.get('location')
		if (!location) return response
		const rewritesToGet = redirectRewritesToGet(response.status, request.method)
		const needsBodyReplay = !rewritesToGet && request.body !== null
		if (needsBodyReplay) {
			// 307/308 (or 301/302 PUT) with a body would replay bytes already
			// consumed from a stream. Do not buffer the upload.
			return response
		}
		const currentUrl = new URL(response.url || request.url)
		const nextUrl = new URL(location, currentUrl)
		if (currentUrl.protocol === 'https:' && nextUrl.protocol === 'http:') {
			// Match browser fail-closed on scheme downgrade for followed hops.
			return response
		}
		await response.body?.cancel().catch(() => {})
		const headers = new Headers(request.headers)
		if (rewritesToGet) {
			headers.delete('content-type')
			headers.delete('content-length')
			headers.delete('content-encoding')
			headers.delete('content-language')
			headers.delete('content-location')
		}
		if (!sameOrigin(currentUrl, nextUrl)) {
			for (const name of crossOriginFilteredHeaders) {
				headers.delete(name)
			}
		}
		request = new Request(nextUrl, {
			method: rewritesToGet ? 'GET' : request.method,
			headers,
			signal: input.signal,
			redirect: 'manual',
		})
		response = await input.fetch(request)
		followed = true
	}
	throw new TypeError('Too many redirects.')
}

function isLoginRetryLater(error: unknown) {
	return (
		error instanceof CredentialLoginRetryLaterError ||
		(error instanceof CredentialClientError &&
			error.body.code === 'login_retry_later')
	)
}
