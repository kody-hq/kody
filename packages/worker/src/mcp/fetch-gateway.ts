import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { WorkerEntrypoint } from 'cloudflare:workers'
import {
	buildSecretHostApprovalUrl,
	buildSecretHostBulkApprovalUrlIfNeeded,
} from '#mcp/secrets/host-approval.ts'
import {
	buildBasicAuthSecretPlaceholderFromReference,
	buildIntegrationTokenPlaceholder,
	buildProviderSecretPlaceholder,
	buildSecretPlaceholder,
	decodeSecretPlaceholderPunctuation,
	formUrlEncodedTexts,
	parseBasicAuthSecretPlaceholders,
	parseIntegrationTokenPlaceholders,
	parseProviderSecretPlaceholders,
	parseSecretPlaceholders,
	replaceSecretPlaceholders,
	replaceSecretPlaceholdersInFormUrlEncoded,
	replaceSecretPlaceholdersInPath,
	type ReferencedBasicAuthSecretPlaceholder,
	type ReferencedProviderSecret,
	type ReferencedSecret,
} from '#mcp/secrets/placeholders.ts'
import {
	batchHasPlaceholders,
	createPlaceholderFillStream,
	type PlaceholderReferenceBatch,
	type PlaceholderStreamBodyFormat,
} from '#mcp/secrets/placeholder-stream-fill.ts'
import { EncodedPlaceholderError } from '#mcp/secrets/encoded-placeholder.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	createHostSecretAccessDeniedBatchMessage,
	createMissingSecretMessage,
	fetchSecretAuthRequiredMessage,
	SecretHostNotApprovedError,
	type HostApprovalEntry,
} from '#mcp/secrets/errors.ts'
import { createUnresolvedSecretMessage } from '#mcp/secrets/unresolved-secret.ts'
import { normalizeHost } from '#mcp/secrets/allowed-hosts.ts'
import { type ResolvedSecret } from '#mcp/secrets/service.ts'
import { type SecretScope } from '#mcp/secrets/types.ts'
import { secretPageOrgSlugFromCaller } from '#mcp/secrets/package-approval-url.ts'
import { SecretProviderHostDeniedError } from '#mcp/secrets/secret-providers/errors.ts'
import {
	redactEchoedSecrets,
	redactEchoedSecretsInError,
	withLanding,
} from '#mcp/secrets/echo-redaction.ts'
import {
	createOutboundFetchDeadline,
	outboundFetchIdleTimeoutMs,
	type OutboundFetchDeadline,
} from '#mcp/outbound-fetch-deadline.ts'
import {
	assertSecretPlacement,
	SecretPlacementError,
} from '#mcp/secrets/secret-placement.ts'
import {
	grantedSecretAuthorityPackageIdSet,
	secretAuthorityHeaderName,
	storageContextWithSecretAuthority,
} from '#mcp/secrets/secret-authority.ts'
import { verifyPackageSecretRef } from '#mcp/secrets/package-secret-ref.ts'
import {
	attestedPackageStamp,
	claimedPackageStamp,
	type PackageStamp,
} from '#worker/credentials/package-stamp.ts'
import {
	credentialFetchPlacementKey,
	type CredentialFetchPlacement,
} from '#worker/credentials/credential-resolver.ts'
import { type CredentialFillSite } from '#worker/credentials/fill-placement.ts'
import {
	auditResolvedFetchPlacements,
	resolveCredential,
} from '#worker/credentials/resolve-credential.ts'
import { assertCredentialUsesDeclared } from '#worker/credentials/credential-need-enforcement.ts'
import { credentialClientHeaderName } from '#worker/credentials/credential-client-header.ts'
import { type OwnerCredentialScope } from '#worker/credentials/owner-credential-for-visitors.ts'
import {
	pathSegmentEncodedCredentialNames,
	withPathSegmentEncodingWarning,
} from '#mcp/secrets/path-segment-encoding-warning.ts'
import {
	applyCredentialClientPlacement,
	resolveCredentialClientPlacement,
	withCredentialClientHint,
	withoutCodePlacement,
} from './credential-client-gateway.ts'
import { createMissingIntegrationAccessTokenMessage } from '#worker/integrations/credentials.ts'
import { IntegrationHostNotAllowedError } from './execute-modules/integration-host-allowlist.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	createPackageAppVisitorPersonalRequest,
	loadPackageAppRunsAs,
	type PackageAppAuthorityScope,
	type PackageAppVisitorGrantScope,
} from '#worker/package-runtime/package-app-authority.ts'
import {
	packageAppAuthorityFallbackKindOf,
	schedulePackageAppAuthorityFallback,
} from '#worker/package-runtime/package-app-authority-fallback.ts'
import {
	consumeDailyEntitlement,
	findCachedUserAccountByStableUserId,
} from '#worker/entitlements/service.ts'
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
	/**
	 * The run (or CapabilityProxy credential) `credential()` client handles
	 * must be bound to. Without it, a client fetch is refused.
	 */
	credentialClientBinding?: string | null
	/**
	 * Package-app runs only: the app whose `ownerCredentialForVisitors`
	 * handles resolve with its credential authority, not `request`.
	 */
	ownerCredentialScope?: OwnerCredentialScope | null
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
	UsageEnv

/**
 * Request header that disables secret placeholder resolution for one gateway
 * fetch: `x-kody-secret-resolution: off`. The header is stripped before the
 * request leaves the gateway, and any `{{secret:...}}` text passes through
 * literally. Out-of-band by design — only calling code can set a header, so
 * attacker-controlled *data* in a URL or body can never disable resolution.
 * Use it when a third party must receive literal placeholder text (for
 * example, writing config that Kody itself resolves later). `headers-only`
 * still fills header placeholders but sends the URL and body as written, for
 * a body that quotes the syntax (an issue or chat message) on a host the
 * credential allows; without it that text would be filled with the secret.
 * For merely mentioning the syntax in prose, prefer an inert form:
 * angle-bracket markers (`{{secret:<name>}}`,
 * `{{secret/<provider>:<ref>}}`,
 * `{{secret/bwvault:i/<item-uuid>/<field>}}`) or the grammar metavariable
 * token `{{secret/provider:ref}}`. Those never resolve.
 */
export const secretResolutionHeaderName = 'x-kody-secret-resolution'

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
	async fetch(request: Request) {
		return executeGatewayFetch({
			env: this.env,
			props: this.ctx.props,
			request,
			waitUntil: (promise) => this.ctx.waitUntil(promise),
		})
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
	const resolved = await applyPackageAppVisitTicketToGateway(input)
	const globalFetch = resolved.globalFetch ?? fetch
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
		if (input.props.userId) {
			// Plan lookup requires the account email. Callers that cannot
			// carry one (MCP provider requests, package runtime) get it
			// reverse-resolved from the stable userId so authenticated
			// fetches count against the caller's real plan rather than
			// failing open to `max` (whose limit is still finite for
			// genuinely accountless synthetic contexts).
			const email =
				input.props.email ??
				(
					await findCachedUserAccountByStableUserId(
						input.env.APP_DB,
						input.props.userId,
					)
				)?.email ??
				null
			await consumeDailyEntitlement({
				db: input.env.APP_DB,
				env: input.env,
				userId: input.props.userId,
				email,
				resource: 'outbound_fetches_per_day',
			})
		}
		const credentialClientToken = input.request.headers.get(
			credentialClientHeaderName,
		)
		const credentialClient =
			credentialClientToken === null
				? null
				: await resolveCredentialClientPlacement({
						env: input.env,
						props: input.props,
						token: credentialClientToken,
						request: input.request,
					})
		const codeRequest = credentialClient
			? withoutCodePlacement(input.request, credentialClient.placement)
			: input.request
		const expanded = await expandAsPackageAppAuthority({
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
		} catch (error) {
			throw redactEchoedSecretsInError(
				asCallerFacingBodyFillError(error),
				substitutedValues,
			)
		}
		const redacted = withPathSegmentEncodingWarning(
			redactEchoedSecrets(response, substitutedValues),
			pathSegmentEncodedNames,
		)
		return credentialClient
			? withCredentialClientHint(redacted, credentialClient.shape)
			: redacted
	} catch (error) {
		deadline?.fail()
		throw asCallerFacingBodyFillError(error)
	} finally {
		const { userId } = input.props
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

/**
 * Package apps fill placeholders as their runs-as person. When that fails,
 * the visitor's fill (today's behavior) is tried before giving up, and a
 * success there leaves a would-break row. Body placeholders fill while the
 * upload streams, so they fall back one batch at a time.
 */
async function expandAsPackageAppAuthority(input: {
	request: Request
	props: FetchGatewayProps
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	const authority = input.props.packageAppAuthority
	if (!authority) return await expandSecretPlaceholders(input)
	const runsAs = await loadPackageAppRunsAs({
		env: input.env,
		scope: authority.scope,
	})
	const noteFallback = (error: unknown) =>
		schedulePackageAppAuthorityFallback({
			env: input.env,
			event: {
				ownerId: authority.scope.orgId,
				packageId: authority.scope.packageId,
				callName: 'fetch',
				kind:
					runsAs.status === 'ready'
						? (packageAppAuthorityFallbackKindOf(error) ??
							'credential_unavailable')
						: 'runs_as_unavailable',
				visitorId: input.props.request?.actor?.userId ?? null,
			},
			waitUntil: input.waitUntil,
		})
	if (runsAs.status !== 'ready') {
		const expanded = await expandSecretPlaceholders(input)
		if (expanded.substitutedValues.length > 0) {
			noteFallback(null)
		} else {
			// Body placeholders fill while the upload streams.
			void expanded.bodyFillDone
				.then(() => {
					if (expanded.substitutedValues.length > 0) noteFallback(null)
				})
				.catch(() => {})
		}
		return expanded
	}
	const retry = input.request.clone() as Request
	try {
		const expanded = await expandSecretPlaceholders({
			...input,
			props: { ...input.props, request: runsAs.request },
			bodyFallback: { props: input.props, onFallback: noteFallback },
		})
		discardUnreadBody(retry.body)
		return expanded
	} catch (error) {
		if (!isPlaceholderAuthorityFailure(error)) {
			discardUnreadBody(retry.body)
			throw error
		}
		discardUnreadBody(input.request.body)
		try {
			const expanded = await expandSecretPlaceholders({
				...input,
				request: retry,
			})
			noteFallback(error)
			return expanded
		} catch {
			throw error
		}
	}
}

/** A locked branch is still being read by a failed fill; cancelling it would throw. */
function discardUnreadBody(body: ReadableStream | null) {
	if (body && !body.locked) void body.cancel().catch(() => {})
}

/** A credential the filling person cannot resolve, as opposed to a bad request or an outage. */
export class GatewayCredentialUnavailableError extends Error {}

export function isPlaceholderAuthorityFailure(error: unknown) {
	return (
		packageAppAuthorityFallbackKindOf(error) !== null ||
		error instanceof GatewayCredentialUnavailableError ||
		error instanceof SecretPlacementError ||
		error instanceof McpCallerError
	)
}

type PlacedPlaceholderSource = {
	text: string
	/** Audit placement (`url` still covers path + query). */
	placement: CredentialFetchPlacement
	/** Precise site for fill-placement observe/enforce. */
	fillSite: CredentialFillSite
}

/**
 * The outbound request with placeholders filled in its headers, URL path and
 * query, and body (streamed chunk-by-chunk, including multipart parts), plus
 * every credential value that went into it so the response can be redacted.
 *
 * `bodyFillDone` settles after the request body stream has been fully filled
 * (or immediately when there is no body fill). Callers must await it before
 * echo-redacting the response so body-only secrets are included.
 */
export async function expandSecretPlaceholders(input: {
	request: Request
	props: FetchGatewayProps
	env: Pick<Env, 'APP_DB' | 'SECRET_STORE_KEY'>
	/**
	 * Body placeholders fill while the upload streams, so a whole-request
	 * retry is impossible once a chunk is sent; a batch these props cannot
	 * fill is retried with `props` here instead.
	 */
	bodyFallback?: {
		props: FetchGatewayProps
		onFallback: (error: unknown) => void
	}
}): Promise<{
	request: Request
	substitutedValues: Array<string>
	bodyFillDone: Promise<void>
	/**
	 * True when the caller asked for `redirect: 'follow'` but the expanded
	 * request uses `manual` so a mid-stream body credential can keep redirects
	 * fail-closed. {@link executeGatewayFetch} may still follow when no
	 * credential was filled and the hop does not replay a body.
	 */
	deferRedirectFollow: boolean
	/**
	 * Credential display names whose path fill encoded `/`, `?`, or `#`.
	 * Used to warn on a 4xx; never includes values.
	 */
	pathSegmentEncodedNames: Array<string>
}> {
	const headers = new Headers(input.request.headers)
	// A client handle is for the gateway only; it never leaves.
	headers.delete(credentialClientHeaderName)
	// Several APIs (GitHub most prominently) reject requests without a
	// User-Agent outright, and workerd sends none by default — bare sandbox
	// fetches hit opaque 403s. Callers that set their own keep it.
	if (!headers.has('user-agent')) {
		headers.set('user-agent', 'kody-agent/1.0')
	}
	const baseUrl = input.props.baseUrl.trim()
	if (!baseUrl) {
		throw new Error('Fetch gateway requires a non-empty baseUrl in props.')
	}
	const packageStamp = resolveGatewayPackageStamp(input.props)
	const storageContext = storageContextWithSecretAuthority(
		input.props.storageContext,
		packageStamp?.packageId ?? null,
	)
	headers.delete(secretAuthorityHeaderName)
	const resolutionMode = readSecretResolutionMode(headers)
	const requestUrl = new URL(
		resolveRequestUrlForFetchGateway(input.request.url, baseUrl),
	)
	const sendBody = shouldSendBody(input.request.method)
	const sourceBody = sendBody ? input.request.body : null

	if (resolutionMode === 'off') {
		return {
			request: new Request(requestUrl, {
				method: input.request.method,
				headers,
				body: sourceBody,
				redirect: input.request.redirect,
				credentials: input.request.credentials,
				mode: input.request.mode,
				cache: input.request.cache,
				integrity: input.request.integrity,
				keepalive: input.request.keepalive,
				signal: input.request.signal,
				...(sourceBody ? { duplex: 'half' as const } : {}),
			}),
			substitutedValues: [],
			bodyFillDone: Promise.resolve(),
			deferRedirectFollow: false,
			pathSegmentEncodedNames: [],
		}
	}

	// `headers-only` fills header placeholders and sends the URL and body as
	// written, for a body that quotes the placeholder syntax. That mode
	// intersects with per-credential placement (never widens it): URL/body
	// sources are omitted here, and named-header limits still apply below.
	const fillsUrlAndBody = resolutionMode === 'on'
	const placeholderSources: Array<PlacedPlaceholderSource> = [
		...Array.from(headers.entries(), ([name, text]) => ({
			text,
			placement: { kind: 'header' as const, name },
			fillSite: { part: 'header' as const, name },
		})),
		...(fillsUrlAndBody ? urlPlaceholderSources(requestUrl) : []),
	]
	assertSecretPlacement({
		url: requestUrl,
		values: placeholderSources.map((source) => source.text),
	})

	const replacements = new Map<string, string>()
	const resolvedValues = new Map<string, string>()
	/** Placeholder → credential display name (never a value). */
	const credentialNamesByPlaceholder = new Map<string, string>()
	const encodedBasicCredentials: Array<string> = []
	const substitutedValues: Array<string> = []
	let referencedAnyCredential = false

	const requestHost = normalizeHost(requestUrl.hostname)
	const auditedPlacementKeys = new Set<string>()

	const placementAuditKey = (
		placeholder: string,
		placement: CredentialFetchPlacement,
	) => `${placeholder}\0${credentialFetchPlacementKey(placement)}`

	const takePendingPlacements = (
		placeholder: string,
		found: ReadonlyArray<CredentialFetchPlacement> | undefined,
	) => {
		if (!found || found.length === 0) return []
		const pending: Array<CredentialFetchPlacement> = []
		const seen = new Set<string>()
		for (const placement of found) {
			const key = placementAuditKey(placeholder, placement)
			if (auditedPlacementKeys.has(key) || seen.has(key)) continue
			seen.add(key)
			switch (placement.kind) {
				case 'header':
					pending.push({
						kind: 'header',
						name: credentialFetchPlacementKey(placement),
					})
					break
				case 'url':
				case 'body':
					pending.push(placement)
					break
				default: {
					const exhaustive: never = placement
					throw new Error(
						`Unhandled credential placement: ${String(exhaustive)}`,
					)
				}
			}
		}
		return pending
	}

	const markPlacementsAudited = (
		placeholder: string,
		placements: ReadonlyArray<CredentialFetchPlacement>,
	) => {
		for (const placement of placements) {
			auditedPlacementKeys.add(placementAuditKey(placeholder, placement))
		}
	}

	const applyBasicAuthPlaceholders = (
		placeholders: ReadonlyArray<ReferencedBasicAuthSecretPlaceholder>,
	) => {
		for (const placeholder of placeholders) {
			const renderedPlaceholder =
				buildBasicAuthSecretPlaceholderFromReference(placeholder)
			const authHeader = buildBasicAuthHeader({
				username: readResolvedSecretValue(resolvedValues, placeholder.username),
				password: readResolvedSecretValue(resolvedValues, placeholder.password),
			})
			encodedBasicCredentials.push(authHeader.slice('Basic '.length))
			// Full header and credential fragment: remotes may echo either.
			substitutedValues.push(authHeader, authHeader.slice('Basic '.length))
			for (const scheme of ['Basic', 'basic', 'BASIC'] as const) {
				const prefixedPlaceholder = `${scheme} ${renderedPlaceholder}`
				if (!replacements.has(prefixedPlaceholder)) {
					replacements.set(prefixedPlaceholder, authHeader)
				}
			}
			if (!replacements.has(renderedPlaceholder)) {
				replacements.set(renderedPlaceholder, authHeader)
			}
		}
	}

	const resolvePlaceholderBatch = async (
		sources: ReadonlyArray<PlacedPlaceholderSource>,
		batchProps: FetchGatewayProps = input.props,
	): Promise<void> => {
		const texts = sources.map((source) => source.text)
		const placementsByPlaceholder = new Map<
			string,
			Array<CredentialFetchPlacement>
		>()
		const fillSitesByPlaceholder = new Map<string, Array<CredentialFillSite>>()
		const notePlacement = (
			placeholder: string,
			placement: CredentialFetchPlacement,
			fillSite: CredentialFillSite,
		) => {
			const found = placementsByPlaceholder.get(placeholder)
			if (found) found.push(placement)
			else placementsByPlaceholder.set(placeholder, [placement])
			const sites = fillSitesByPlaceholder.get(placeholder)
			if (sites) sites.push(fillSite)
			else fillSitesByPlaceholder.set(placeholder, [fillSite])
		}
		for (const source of sources) {
			for (const secret of parseSecretPlaceholders(source.text)) {
				notePlacement(
					buildSecretPlaceholder(secret),
					source.placement,
					source.fillSite,
				)
			}
			for (const basic of parseBasicAuthSecretPlaceholders(source.text)) {
				notePlacement(
					buildSecretPlaceholder(basic.username),
					source.placement,
					source.fillSite,
				)
				notePlacement(
					buildSecretPlaceholder(basic.password),
					source.placement,
					source.fillSite,
				)
			}
			for (const name of parseIntegrationTokenPlaceholders(source.text)) {
				notePlacement(
					buildIntegrationTokenPlaceholder(name),
					source.placement,
					source.fillSite,
				)
			}
			for (const referenced of parseProviderSecretPlaceholders(source.text)) {
				notePlacement(
					buildProviderSecretPlaceholder(referenced),
					source.placement,
					source.fillSite,
				)
			}
		}
		const basicAuthPlaceholders = dedupeBasicAuthSecretPlaceholders(
			texts.flatMap((value) => parseBasicAuthSecretPlaceholders(value)),
		)
		const referencedSecrets = dedupeReferencedSecrets([
			...texts.flatMap((value) => parseSecretPlaceholders(value)),
			...basicAuthPlaceholders.flatMap((placeholder) => [
				placeholder.username,
				placeholder.password,
			]),
		]).flatMap((referenced) => {
			const placeholder = buildSecretPlaceholder(referenced)
			const placements = takePendingPlacements(
				placeholder,
				placementsByPlaceholder.get(placeholder),
			)
			if (placements.length === 0) return []
			return [
				{
					referenced,
					placeholder,
					credential: {
						use: 'secret' as const,
						name: referenced.name,
						scope: referenced.scope,
						storageContext,
						orgSlug: secretPageOrgSlugFromCaller(batchProps),
						requestHost,
						placements,
						fillSites: fillSitesByPlaceholder.get(placeholder) ?? [],
					},
				},
			]
		})
		const referencedIntegrationTokens = dedupeIntegrationTokenNames(
			texts.flatMap((value) => parseIntegrationTokenPlaceholders(value)),
		).flatMap((name) => {
			const placeholder = buildIntegrationTokenPlaceholder(name)
			const placements = takePendingPlacements(
				placeholder,
				placementsByPlaceholder.get(placeholder),
			)
			if (placements.length === 0) return []
			return [
				{
					name,
					placeholder,
					credential: {
						use: 'integration-token' as const,
						name,
						requestHost,
						placements,
						fillSites: fillSitesByPlaceholder.get(placeholder) ?? [],
					},
				},
			]
		})
		const referencedProviderSecrets = dedupeReferencedProviderSecrets(
			texts.flatMap((value) => parseProviderSecretPlaceholders(value)),
		).flatMap((referenced) => {
			const placeholder = buildProviderSecretPlaceholder(referenced)
			const placements = takePendingPlacements(
				placeholder,
				placementsByPlaceholder.get(placeholder),
			)
			if (placements.length === 0) return []
			return [
				{
					referenced,
					placeholder,
					credential: {
						use: 'provider-secret' as const,
						provider: referenced.provider,
						ref: referenced.ref,
						storageContext,
						requestHost,
						placements,
						fillSites: fillSitesByPlaceholder.get(placeholder) ?? [],
					},
				},
			]
		})
		const pendingBasicAuth = basicAuthPlaceholders.filter((placeholder) => {
			const rendered = buildBasicAuthSecretPlaceholderFromReference(placeholder)
			return !replacements.has(rendered)
		})
		if (
			referencedSecrets.length === 0 &&
			referencedIntegrationTokens.length === 0 &&
			referencedProviderSecrets.length === 0 &&
			pendingBasicAuth.length === 0
		) {
			return
		}
		referencedAnyCredential = true
		assertSecretPlacement({ url: requestUrl, values: texts })
		const callerUserId = requireFetchUserId(batchProps)
		const resolveInput = {
			env: input.env as Env,
			orgId: callerUserId,
			actor: batchProps.request,
			packageStamp,
			baseUrl: batchProps.baseUrl,
			// Run package id for the nested personal-secret rule (GHSA-5fv3).
			runContextPackageId:
				packageStamp?.kind === 'claimed'
					? undefined
					: (batchProps.storageContext?.packageId ?? null),
		}
		const entriesToResolve = <
			T extends {
				placeholder: string
				credential: Parameters<typeof resolveCredential>[0]['credential']
			},
		>(
			entries: ReadonlyArray<T>,
		) =>
			entries.flatMap((entry) => {
				const placements =
					'placements' in entry.credential
						? entry.credential.placements
						: undefined
				markPlacementsAudited(entry.placeholder, placements ?? [])
				if (
					!replacements.has(entry.placeholder) ||
					!auditResolvedFetchPlacements({
						...resolveInput,
						credential: entry.credential,
					})
				) {
					return [entry]
				}
				return []
			})
		const secretsToResolve = entriesToResolve(referencedSecrets)
		const integrationTokensToResolve = entriesToResolve(
			referencedIntegrationTokens,
		)
		const providerSecretsToResolve = entriesToResolve(referencedProviderSecrets)
		await assertCredentialUsesDeclared({
			env: input.env as Env,
			request: batchProps.request,
			orgId: callerUserId,
			packageId: packageStamp?.packageId ?? null,
			references: [
				...referencedSecrets.map((entry) => ({
					use: 'secret' as const,
					name: entry.referenced.name,
					scope: entry.referenced.scope,
				})),
				...referencedIntegrationTokens.map((entry) => ({
					use: 'integration' as const,
					name: entry.name,
				})),
				...referencedProviderSecrets.map((entry) => ({
					use: 'provider' as const,
					provider: entry.referenced.provider,
				})),
			],
		})
		const settledSecretResults = await Promise.allSettled(
			secretsToResolve.map(async ({ referenced, credential }) => {
				// Package-scoped placeholders issued by packageSecrets.get carry a
				// per-run HMAC bound to the declaring package (GHSA-5fv3). A stolen
				// placeholder cannot be filled under another package's authority.
				if (
					referenced.scope === 'package' &&
					referenced.ref &&
					batchProps.packageSecretRefKey
				) {
					const authorityId = packageStamp?.packageId ?? null
					const ok =
						authorityId != null &&
						(await verifyPackageSecretRef({
							refKey: batchProps.packageSecretRefKey,
							packageId: authorityId,
							alias: referenced.name,
							ref: referenced.ref,
						}))
					if (!ok) {
						throw new McpCallerError(
							`Package-scoped secret "${referenced.name}" was not issued for this package runtime.`,
						)
					}
				} else if (
					referenced.scope === 'package' &&
					referenced.ref &&
					!batchProps.packageSecretRefKey
				) {
					throw new McpCallerError(
						`Package-scoped secret "${referenced.name}" requires a package runtime that issues secret refs.`,
					)
				}
				const resolved = await resolveCredential({
					...resolveInput,
					credential,
				})
				if (!resolved.found || typeof resolved.value !== 'string') {
					throw new McpCallerError(
						await createUnresolvedSecretMessage({
							env: input.env,
							userId: callerUserId,
							name: referenced.name,
							scope: referenced.scope,
							storageContext,
							baseUrl: batchProps.baseUrl,
						}),
					)
				}
				return { referenced, resolved, value: resolved.value }
			}),
		)
		const resolvedSecretResults = readSettledSecretResults({
			settled: settledSecretResults,
			props: batchProps,
			storageContext,
			requestedHost: requestUrl.hostname,
		})
		const resolvedIntegrationTokens = await Promise.all(
			integrationTokensToResolve.map(async ({ name, credential }) => {
				const value = await resolveCredential({
					...resolveInput,
					credential,
				}).catch((error: unknown) => {
					throw error instanceof IntegrationHostNotAllowedError
						? new SecretPlacementError(error.message, name)
						: error
				})
				if (!value) {
					throw new GatewayCredentialUnavailableError(
						createMissingIntegrationAccessTokenMessage(name),
					)
				}
				return { name, value }
			}),
		)
		const resolvedProviderSecrets = await Promise.all(
			providerSecretsToResolve.map(async ({ referenced, credential }) => {
				const request = batchProps.request
				if (!request) {
					throw new GatewayCredentialUnavailableError(
						fetchSecretAuthRequiredMessage,
					)
				}
				const resolved = await resolveCredential({
					...resolveInput,
					actor: request,
					credential,
				}).catch((error: unknown) => {
					throw error instanceof SecretProviderHostDeniedError
						? new SecretPlacementError(error.message, null)
						: error
				})
				return { referenced, resolved }
			}),
		)
		for (const { referenced, value } of resolvedSecretResults) {
			const placeholder = buildSecretPlaceholder(referenced)
			credentialNamesByPlaceholder.set(placeholder, referenced.name)
			if (!replacements.has(placeholder)) {
				replacements.set(placeholder, value)
				substitutedValues.push(value)
			}
			if (!resolvedValues.has(placeholder)) {
				resolvedValues.set(placeholder, value)
			}
		}
		for (const { name, value } of resolvedIntegrationTokens) {
			const placeholder = buildIntegrationTokenPlaceholder(name)
			credentialNamesByPlaceholder.set(placeholder, name)
			if (!replacements.has(placeholder)) {
				replacements.set(placeholder, value)
				substitutedValues.push(value)
			}
		}
		for (const { referenced, resolved } of resolvedProviderSecrets) {
			const placeholder = buildProviderSecretPlaceholder(referenced)
			credentialNamesByPlaceholder.set(
				placeholder,
				`${referenced.provider}:${referenced.ref}`,
			)
			if (!replacements.has(placeholder)) {
				replacements.set(placeholder, resolved.value)
				substitutedValues.push(resolved.value)
			}
		}
		applyBasicAuthPlaceholders(pendingBasicAuth)
	}

	await resolvePlaceholderBatch(placeholderSources)

	for (const [key, value] of Array.from(headers.entries())) {
		headers.set(key, replaceSecretPlaceholders(value, replacements))
	}
	const pathSegmentEncodedNames = fillsUrlAndBody
		? pathSegmentEncodedCredentialNames({
				pathname: decodeSecretPlaceholderPunctuation(requestUrl.pathname),
				replacements,
				credentialNames: credentialNamesByPlaceholder,
			})
		: []
	const nextUrl = fillsUrlAndBody
		? fillUrlPlaceholders(requestUrl, replacements)
		: requestUrl

	let nextBody: ReadableStream<Uint8Array> | null = sourceBody
	let bodyFillDone: Promise<void> = Promise.resolve()
	let bodyFillActive = false

	if (fillsUrlAndBody && sourceBody) {
		bodyFillActive = true
		const { format, body: classifiedBody } = await classifyStreamingBody({
			body: sourceBody,
			contentType: headers.get('content-type'),
		})
		const fill = createPlaceholderFillStream({
			source: classifiedBody,
			format,
			replacements,
			allowPercentEncoded: format === 'form',
			resolve: async (batch: PlaceholderReferenceBatch) => {
				if (!batchHasPlaceholders(batch)) return []
				const placement = { kind: 'body' as const }
				const fillSite = { part: 'body' as const }
				const sources = [
					...batch.secrets.map((secret) => ({
						text: buildSecretPlaceholder(secret),
						placement,
						fillSite,
					})),
					...batch.basicAuth.map((placeholder) => ({
						text: buildBasicAuthSecretPlaceholderFromReference(placeholder),
						placement,
						fillSite,
					})),
					...batch.integrationTokens.map((name) => ({
						text: buildIntegrationTokenPlaceholder(name),
						placement,
						fillSite,
					})),
					...batch.providerSecrets.map((referenced) => ({
						text: buildProviderSecretPlaceholder(referenced),
						placement,
						fillSite,
					})),
				]
				const before = substitutedValues.length
				const auditedBefore = new Set(auditedPlacementKeys)
				try {
					await resolvePlaceholderBatch(sources)
				} catch (error) {
					const fallback = input.bodyFallback
					if (!fallback || !isPlaceholderAuthorityFailure(error)) throw error
					for (const key of auditedPlacementKeys) {
						if (!auditedBefore.has(key)) auditedPlacementKeys.delete(key)
					}
					try {
						await resolvePlaceholderBatch(sources, fallback.props)
					} catch {
						throw error
					}
					fallback.onFallback(error)
				}
				return substitutedValues.slice(before)
			},
		})
		nextBody = fill.stream
		bodyFillDone = fill.done.then(() => {
			for (const value of fill.substitutedValues) {
				if (!substitutedValues.includes(value)) {
					substitutedValues.push(value)
				}
			}
		})
		// A body-fill denial also errors the request stream, so the upstream
		// fetch rejects before the caller reaches `await bodyFillDone`. Mark the
		// derived promise handled; callers that do await it still see the error.
		bodyFillDone.catch(() => {})
		// Body length may change as placeholders fill.
		headers.delete('content-length')
	} else if (resolutionMode === 'headers-only') {
		nextBody = sourceBody
	}

	// Any fillable body uses manual redirects so a credential that appears
	// only in a later chunk cannot ride redirect=follow to another host.
	// executeGatewayFetch restores ordinary follow when nothing was filled.
	const deferRedirectFollow =
		input.request.redirect === 'follow' &&
		(referencedAnyCredential || bodyFillActive)
	const nextRedirect = deferRedirectFollow ? 'manual' : input.request.redirect
	return {
		request: new Request(nextUrl, {
			method: input.request.method,
			headers,
			body: nextBody,
			redirect: nextRedirect,
			credentials: input.request.credentials,
			mode: input.request.mode,
			cache: input.request.cache,
			integrity: input.request.integrity,
			keepalive: input.request.keepalive,
			signal: input.request.signal,
			...(nextBody ? { duplex: 'half' as const } : {}),
		}),
		substitutedValues,
		bodyFillDone,
		deferRedirectFollow,
		pathSegmentEncodedNames,
	}
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

function asCallerFacingBodyFillError(error: unknown) {
	if (error instanceof EncodedPlaceholderError) {
		return new McpCallerError(error.message, { cause: error })
	}
	return error
}

function bodyFormatFromContentType(
	contentType: string | null,
): PlaceholderStreamBodyFormat {
	const raw = contentType?.toLowerCase() ?? ''
	if (raw.startsWith('multipart/')) return 'multipart'
	if (raw.startsWith('application/x-www-form-urlencoded')) return 'form'
	const mediaType = raw.split(';')[0]?.trim() ?? ''
	if (mediaType === 'application/json' || mediaType.endsWith('+json')) {
		return 'json'
	}
	return 'text'
}

/**
 * `fetch(url, { body: JSON.stringify(...) })` without a Content-Type is sent
 * as `text/plain`. Peek a small prefix so those bodies still JSON-escape,
 * then rebuild a stream that starts with the peeked bytes (pull-driven so the
 * rest of a large upload stays backpressured).
 */
async function classifyStreamingBody(input: {
	body: ReadableStream<Uint8Array>
	contentType: string | null
}): Promise<{
	format: PlaceholderStreamBodyFormat
	body: ReadableStream<Uint8Array>
}> {
	const hinted = bodyFormatFromContentType(input.contentType)
	const mediaType = input.contentType?.toLowerCase().split(';')[0]?.trim() ?? ''
	const mayBeUntypedJson = mediaType === '' || mediaType === 'text/plain'
	if (hinted !== 'text' || !mayBeUntypedJson) {
		return { format: hinted, body: input.body }
	}
	const reader = input.body.getReader()
	const first = await reader.read()
	if (first.done || !first.value) {
		reader.releaseLock()
		return {
			format: 'text',
			body: new ReadableStream({
				start(c) {
					c.close()
				},
			}),
		}
	}
	const prefix = first.value
	let format: PlaceholderStreamBodyFormat = 'text'
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(prefix)
		JSON.parse(text)
		format = 'json'
	} catch {
		// Incomplete JSON in the first chunk, or not UTF-8. Opening `{` / `[`
		// still means JSON-escape secrets in later chunks (untyped text/plain
		// JSON bodies often arrive split).
		try {
			const text = new TextDecoder('utf-8', { fatal: true }).decode(prefix)
			const trimmed = text.trimStart()
			if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
				format = 'json'
			}
		} catch {
			format = 'text'
		}
	}
	let emittedPrefix = false
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				if (!emittedPrefix) {
					emittedPrefix = true
					controller.enqueue(prefix)
					return
				}
				const { done, value } = await reader.read()
				if (done) {
					controller.close()
					return
				}
				controller.enqueue(value)
			} catch (error) {
				controller.error(error)
			}
		},
		cancel(reason) {
			return reader.cancel(reason)
		},
	})
	return { format, body }
}

/**
 * Which package is fetching. A CapabilityProxy claim is `claimed`. Otherwise
 * the host-set per-package binding (`boundPackageId`), or else the host-set
 * run package, is `attested`. Request headers never select the package
 * (GHSA-5fv3): sandbox code can set, read, and replay any header.
 */
export function resolveGatewayPackageStamp(
	props: FetchGatewayProps,
): PackageStamp | null {
	const claimed = claimedPackageStamp(props.claimedPackageId)
	if (claimed) {
		if (props.storageContext?.packageId || props.boundPackageId) {
			throw new Error(
				'Fetch gateway props cannot carry both a claimed package id and a run or bound package id.',
			)
		}
		return claimed
	}
	const bound = props.boundPackageId?.trim() || null
	if (bound) {
		const grantedPackageIds = grantedSecretAuthorityPackageIdSet(
			props.grantedSecretAuthorityPackageIds,
		)
		if (!grantedPackageIds?.has(bound)) {
			throw new Error(
				'Fetch gateway bound package id is not in the run grant set.',
			)
		}
		return attestedPackageStamp(bound)
	}
	return attestedPackageStamp(props.storageContext?.packageId?.trim() || null)
}

/**
 * Kody runtime / sandboxed fetch may emit path-only URLs (e.g. `/`, `/core/log`).
 * Workers `Request` requires an absolute URL string; resolve against the app origin.
 */
function resolveRequestUrlForFetchGateway(url: string, baseUrl: string) {
	const trimmed = url.trim()
	if (!trimmed) {
		throw new Error('Fetch gateway received an empty request URL.')
	}
	try {
		return new URL(trimmed).toString()
	} catch {
		try {
			return new URL(trimmed, baseUrl).toString()
		} catch {
			throw new Error(
				`Fetch gateway could not resolve request URL "${trimmed}" against baseUrl.`,
			)
		}
	}
}

type MissingHostApproval = HostApprovalEntry & { scope: SecretScope }

type ResolvedSecretResult = {
	referenced: ReferencedSecret
	resolved: ResolvedSecret
	value: string
}

/**
 * Door host denials are collected into one batch message, so every missing
 * approval is listed at once. Any other failure is rethrown first.
 */
function readSettledSecretResults(input: {
	settled: Array<PromiseSettledResult<ResolvedSecretResult>>
	props: FetchGatewayProps
	storageContext: StorageContext
	requestedHost: string
}) {
	const results: Array<ResolvedSecretResult> = []
	const hostDenials: Array<SecretHostNotApprovedError> = []
	for (const entry of input.settled) {
		if (entry.status === 'fulfilled') {
			results.push(entry.value)
		} else if (entry.reason instanceof SecretHostNotApprovedError) {
			hostDenials.push(entry.reason)
		} else {
			throw entry.reason
		}
	}
	if (hostDenials.length > 0) {
		throw createHostApprovalBatchError({
			props: input.props,
			storageContext: input.storageContext,
			missingApprovals: hostDenials.map((denial) => ({
				secretName: denial.secretName,
				host: input.requestedHost,
				scope: denial.scope,
				approvalUrl: buildSecretHostApprovalUrl({
					baseUrl: input.props.baseUrl,
					name: denial.secretName,
					scope: denial.scope,
					requestedHost: input.requestedHost,
					storageContext: input.storageContext,
				}),
			})),
		})
	}
	return results
}

function createHostApprovalBatchError(input: {
	props: FetchGatewayProps
	storageContext: StorageContext
	missingApprovals: Array<MissingHostApproval>
}) {
	const { missingApprovals } = input
	const bulkScope = readBulkHostApprovalScope({
		scopes: missingApprovals.map((entry) => entry.scope),
		storageContext: input.storageContext,
	})
	const bulkApprovalUrl = bulkScope
		? buildSecretHostBulkApprovalUrlIfNeeded({
				baseUrl: input.props.baseUrl,
				names: missingApprovals.map((entry) => entry.secretName),
				hosts: missingApprovals.map((entry) => entry.host),
				scope: bulkScope.scope,
				storageContext: bulkScope.storageContext,
			})
		: null
	return new SecretPlacementError(
		createHostSecretAccessDeniedBatchMessage(
			missingApprovals.map(({ secretName, host, approvalUrl }) => ({
				secretName,
				host,
				approvalUrl,
			})),
			{ bulkApprovalUrl },
		),
		missingApprovals.length === 1
			? (missingApprovals[0]?.secretName ?? null)
			: null,
	)
}

function readBulkHostApprovalScope(input: {
	scopes: Array<SecretScope>
	storageContext: StorageContext | null
}): { scope: SecretScope; storageContext: StorageContext | null } | null {
	const { scopes } = input
	const unique = new Set(scopes)
	if (unique.size !== 1) return null
	const scope = scopes[0]
	if (!scope) return null
	switch (scope) {
		case 'user':
			return { scope, storageContext: null }
		case 'package':
		case 'session':
			return { scope, storageContext: input.storageContext }
		default: {
			const _exhaustive: never = scope
			return _exhaustive
		}
	}
}

function requireFetchUserId(props: FetchGatewayProps): OwnerId {
	if (!props.userId) {
		throw new GatewayCredentialUnavailableError(fetchSecretAuthRequiredMessage)
	}
	return props.userId
}

/**
 * Read and strip the resolution opt-out header. Unknown values fail loudly:
 * a typo like "of" silently resolving placeholders would defeat the point of
 * opting out.
 */
function readSecretResolutionMode(
	headers: Headers,
): 'on' | 'headers-only' | 'off' {
	const raw = headers.get(secretResolutionHeaderName)
	if (raw == null) return 'on'
	headers.delete(secretResolutionHeaderName)
	const value = raw.trim().toLowerCase()
	if (value === 'off') return 'off'
	if (value === 'headers-only') return 'headers-only'
	if (value === 'on') return 'on'
	throw new Error(
		`Invalid ${secretResolutionHeaderName} header value "${raw}". Use "off" to send secret placeholders literally without resolution, "headers-only" to fill header placeholders and send the URL and body as written, or omit the header to fill placeholders anywhere in the request.`,
	)
}

function dedupeReferencedProviderSecrets(
	referenced: Array<ReferencedProviderSecret>,
) {
	const deduped = new Map<string, ReferencedProviderSecret>()
	for (const entry of referenced) {
		deduped.set(buildProviderSecretPlaceholder(entry), entry)
	}
	return Array.from(deduped.values())
}

function dedupeIntegrationTokenNames(names: Array<string>) {
	return Array.from(new Set(names.filter((name) => name.trim().length > 0)))
}

function dedupeReferencedSecrets(referencedSecrets: Array<ReferencedSecret>) {
	const deduped = new Map<string, ReferencedSecret>()
	for (const referenced of referencedSecrets) {
		deduped.set(buildSecretPlaceholder(referenced), referenced)
	}
	return Array.from(deduped.values())
}

function dedupeBasicAuthSecretPlaceholders(
	placeholders: Array<ReferencedBasicAuthSecretPlaceholder>,
) {
	const deduped = new Map<string, ReferencedBasicAuthSecretPlaceholder>()
	for (const placeholder of placeholders) {
		deduped.set(
			buildBasicAuthSecretPlaceholderFromReference(placeholder),
			placeholder,
		)
	}
	return Array.from(deduped.values())
}

/** Path and query texts with precise fill sites (audit still uses `url`). */
function urlPlaceholderSources(url: URL): Array<PlacedPlaceholderSource> {
	const auditPlacement = { kind: 'url' as const }
	return [
		{
			text: decodeSecretPlaceholderPunctuation(url.pathname),
			placement: auditPlacement,
			fillSite: { part: 'path' as const },
		},
		...formUrlEncodedTexts(url.search).map((text) => ({
			text,
			placement: auditPlacement,
			fillSite: { part: 'query' as const },
		})),
	]
}

/**
 * `url` with placeholders filled in its path and query. Only the components
 * that hold one change.
 */
function fillUrlPlaceholders(
	url: URL,
	replacements: ReadonlyMap<string, string>,
) {
	const next = new URL(url)
	if (holdsPlaceholder(decodeSecretPlaceholderPunctuation(url.pathname))) {
		next.pathname = replaceSecretPlaceholdersInPath(url.pathname, replacements)
	}
	if (formUrlEncodedTexts(url.search).some(holdsPlaceholder)) {
		next.search = replaceSecretPlaceholdersInFormUrlEncoded(
			url.search.slice(1),
			replacements,
		)
	}
	return next
}

function holdsPlaceholder(value: string) {
	return (
		parseSecretPlaceholders(value).length > 0 ||
		parseBasicAuthSecretPlaceholders(value).length > 0 ||
		parseIntegrationTokenPlaceholders(value).length > 0 ||
		parseProviderSecretPlaceholders(value).length > 0
	)
}

function shouldSendBody(method: string) {
	return method !== 'GET' && method !== 'HEAD'
}

function readResolvedSecretValue(
	resolvedValues: ReadonlyMap<string, string>,
	referenced: ReferencedSecret,
) {
	const placeholder = buildSecretPlaceholder(referenced)
	const value = resolvedValues.get(placeholder)
	if (value == null) {
		throw new GatewayCredentialUnavailableError(
			createMissingSecretMessage(referenced.name),
		)
	}
	return value
}

function buildBasicAuthHeader(input: { username: string; password: string }) {
	const credentials = new TextEncoder().encode(
		`${input.username}:${input.password}`,
	)
	return `Basic ${bytesToBase64(credentials)}`
}
