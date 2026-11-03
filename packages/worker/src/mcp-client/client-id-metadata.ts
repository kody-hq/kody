import { DurableObjectOAuthClientProvider } from 'agents/mcp/do-oauth-client-provider'
import {
	buildMcpOAuthAttemptIdentity,
	clearMcpOAuthAttemptIdentity,
	isMcpOAuthAttemptVerified,
	markMcpOAuthAttemptVerified,
	mcpOAuthAttemptCheckFailure,
	McpOAuthAttemptIdentityError,
	oauthAttemptMatchesLiveServer,
	readMcpOAuthAttemptIdentity,
	writeMcpOAuthAttemptIdentity,
	type McpOAuthLiveServerIdentity,
} from './oauth-attempt.ts'
import { mcpOAuthAttemptIdentityInvalidMessage } from './oauth-identity.ts'
import { assertEndpointsOnIssuerOrigin } from './oauth-issuer-endpoints.ts'
import {
	releaseMcpOAuthRefreshCoalesce,
	wrapFetchForMcpOAuthRefreshCoalesce,
} from './oauth-refresh-coalesce.ts'
import {
	clientIdFromMcpOAuthTokenStorageKey,
	mcpOAuthDiscoveryAdvertisesRefresh,
	mcpOAuthRefreshGrantOmittedStorageKey,
	mcpOAuthRefreshTokenStorageKey,
	mcpOAuthServerStoragePrefix,
	parseStoredMcpOAuthRefreshToken,
	preferMcpOAuthStoredClientId,
	readMcpOAuthTokenPresence,
	restoreReadableMcpOAuthTokens,
	withPreservedMcpOAuthRefreshToken,
} from './oauth-token-recovery.ts'
import {
	installMcpPreRegisteredOAuthClient,
	type McpPreRegisteredOAuthClientInformation,
} from './preregistered-oauth-client.ts'
import type { McpOAuthClientMode } from '@kody-internal/shared/mcp-servers.ts'

export const mcpClientIdMetadataPath = '/oauth/client-metadata.json'
export const mcpServerOAuthCallbackPath = '/account/mcp-servers/oauth/callback'
export const mcpClientName = 'Kody'

/**
 * MCP clients MUST host CIMD at an HTTPS URL with a path. Local http
 * origins stay on DCR: the SDK only uses `clientMetadataUrl` when the
 * authorization server advertises CIMD support *and* this URL is HTTPS.
 */
export function resolveMcpClientMetadataUrl(callbackUrl: string) {
	try {
		const url = new URL(mcpClientIdMetadataPath, callbackUrl)
		if (url.protocol !== 'https:') return undefined
		return url.href
	} catch {
		return undefined
	}
}

/**
 * Which client identity an authorization URL carries. A configured
 * pre-registered client always wins; otherwise the MCP SDK puts the CIMD URL
 * in `client_id` when the authorization server supports it, and the
 * registered id otherwise.
 */
export function resolveMcpOAuthClientMode(input: {
	authorizationUrl: string
	callbackUrl: string
	preRegisteredClientId?: string | null
}): McpOAuthClientMode {
	const clientId = new URL(input.authorizationUrl).searchParams.get('client_id')
	if (input.preRegisteredClientId && clientId === input.preRegisteredClientId) {
		return 'pre-registered'
	}
	const metadataUrl = resolveMcpClientMetadataUrl(input.callbackUrl)
	return metadataUrl && clientId === metadataUrl ? 'cimd' : 'dcr'
}

export function buildMcpClientIdMetadataDocument(origin: string) {
	const clientOrigin = new URL(origin).origin
	const clientId = `${clientOrigin}${mcpClientIdMetadataPath}`
	return {
		client_id: clientId,
		client_name: mcpClientName,
		client_uri: clientOrigin,
		logo_uri: `${clientOrigin}/logo.png`,
		redirect_uris: [`${clientOrigin}${mcpServerOAuthCallbackPath}`],
		grant_types: ['authorization_code', 'refresh_token'],
		response_types: ['code'],
		token_endpoint_auth_method: 'none',
		application_type: 'web',
	}
}

export function isMcpClientIdMetadataRequest(pathname: string) {
	return pathname === mcpClientIdMetadataPath
}

export function handleMcpClientIdMetadataRequest(request: Request) {
	const url = new URL(request.url)
	if (!isMcpClientIdMetadataRequest(url.pathname)) return null
	if (request.method === 'OPTIONS') {
		return new Response(null, {
			status: 204,
			headers: { 'Content-Length': '0' },
		})
	}
	if (request.method !== 'GET' && request.method !== 'HEAD') return null

	const body = JSON.stringify(buildMcpClientIdMetadataDocument(url.origin))
	const headers = {
		'Content-Type': 'application/json',
		'Cache-Control': 'public, max-age=3600',
	}
	if (request.method === 'HEAD') {
		return new Response(null, { status: 200, headers })
	}
	return new Response(body, { headers })
}

type McpClientOAuthProvider = DurableObjectOAuthClientProvider & {
	clientMetadataUrl?: string
	/**
	 * Fetch that coalesces concurrent refresh_token POSTs for this provider.
	 * Wire it onto the MCP transport (`transport.fetch`) so 401-driven
	 * `auth()` calls share one token-endpoint exchange per refresh token.
	 */
	coalesceFetch?: typeof fetch
}

type McpOAuthTokenContext = Parameters<
	DurableObjectOAuthClientProvider['tokens']
>[0]
type McpOAuthStoredTokens = Awaited<
	ReturnType<DurableObjectOAuthClientProvider['tokens']>
>
type McpOAuthSaveTokens = Parameters<
	DurableObjectOAuthClientProvider['saveTokens']
>[0]

export type ResolveMcpOAuthLiveServerIdentity = (
	serverId: string,
) => Promise<McpOAuthLiveServerIdentity | null>

/**
 * Agents SDK storage/PKCE provider plus the MCP SDK `clientMetadataUrl`
 * hook. HTTPS callbacks present CIMD; http (local dev) omits it so auth
 * falls back to DCR. Discovery save/read refuse authorize/token endpoints
 * off the issuer origin (`mcp_oauth_failed`, #3284). `saveTokens` keeps an
 * existing refresh token when the authorization server omits one, writes a
 * server-scoped sidecar so restore can find it when SQL `client_id` is
 * missing, and keeps OAuth discovery so the next authorize URL can still
 * advertise scopes. A completed authorization-code grant clears leftover
 * `/token` blobs for other client ids on that server and records whether the
 * AS omitted an advertised refresh token (so ready-state warnings do not fire
 * after a later wipe). `redirectToAuthorization` keeps the live grant (a
 * transient refresh failure must stay recoverable); authorization-code
 * `saveTokens` clears sibling DCR/CIMD `/token` blobs. `coalesceFetch`
 * collapses concurrent refresh_token POSTs for this provider.
 * `invalidateCredentials` for `tokens`, `client`, or `all` infers `clientId`
 * when it is missing, deletes leftover `/token` keys and the sidecar so a
 * rejected grant cannot be replayed, and skips a `tokens` wipe when a save
 * completed after the invalidate was requested. With
 * `resolvePreRegisteredClient`, a server's admin-configured OAuth client is
 * presented ahead of CIMD and DCR. With `resolveLiveServerIdentity`, each
 * authorization attempt is bound to the live server row + client, re-checked
 * at callback and again immediately before tokens are persisted.
 */
export function createMcpClientOAuthProvider(
	storage: DurableObjectStorage,
	callbackUrl: string,
	options?: {
		resolvePreRegisteredClient?: (
			serverId: string,
		) => Promise<McpPreRegisteredOAuthClientInformation | null>
		resolveLiveServerIdentity?: ResolveMcpOAuthLiveServerIdentity
	},
) {
	const provider = new DurableObjectOAuthClientProvider(
		storage,
		mcpClientName,
		callbackUrl,
	) as McpClientOAuthProvider
	// Issuer guard before token preservation so discovery re-writes use it.
	// Attempt binding then wraps redirect / checkState for live-row fencing.
	installMcpOAuthIssuerEndpointGuard(provider)
	installMcpOAuthTokenPreservation(provider, {
		resolveLiveServerIdentity: options?.resolveLiveServerIdentity,
	})
	installMcpOAuthAttemptBinding(provider, {
		resolveLiveServerIdentity: options?.resolveLiveServerIdentity,
	})
	if (options?.resolvePreRegisteredClient) {
		installMcpPreRegisteredOAuthClient(
			provider,
			options.resolvePreRegisteredClient,
		)
	}
	const clientMetadataUrl = resolveMcpClientMetadataUrl(callbackUrl)
	if (clientMetadataUrl) {
		provider.clientMetadataUrl = clientMetadataUrl
	}
	provider.coalesceFetch = wrapFetchForMcpOAuthRefreshCoalesce(provider)
	return provider
}

/**
 * Refuse AS metadata whose authorize/token endpoints leave the issuer origin
 * (#3284). Discovery save covers authorize start; discovery read re-asserts on
 * refresh against a cached (or pre-check) blob. Throws `McpOAuthFailedError`
 * (`mcp_oauth_failed`) so the existing OAuth failure path surfaces it.
 */
function installMcpOAuthIssuerEndpointGuard(
	provider: DurableObjectOAuthClientProvider,
) {
	if (
		typeof provider.saveDiscoveryState !== 'function' ||
		typeof provider.discoveryState !== 'function'
	) {
		return
	}
	const writeDiscovery = provider.saveDiscoveryState.bind(provider)
	const readDiscovery = provider.discoveryState.bind(provider)
	provider.saveDiscoveryState = async (state) => {
		assertEndpointsOnIssuerOrigin(state)
		await writeDiscovery(state)
	}
	provider.discoveryState = async () => {
		const state = await readDiscovery()
		if (state) assertEndpointsOnIssuerOrigin(state)
		return state
	}
}

/**
 * Bind an in-flight authorization to the server row and client that minted
 * it. Callback `checkState` and grant `saveTokens` re-load the live row and
 * refuse on mismatch. Refresh saves (no pending attempt) are unchanged so
 * existing grants keep working. Issuer-origin discovery fencing lives in
 * `installMcpOAuthIssuerEndpointGuard`.
 */
function installMcpOAuthAttemptBinding(
	provider: DurableObjectOAuthClientProvider,
	options: {
		resolveLiveServerIdentity?: ResolveMcpOAuthLiveServerIdentity
	},
) {
	const resolveLive = options.resolveLiveServerIdentity
	if (!resolveLive) return
	if (typeof provider.redirectToAuthorization === 'function') {
		const redirect = provider.redirectToAuthorization.bind(provider)
		provider.redirectToAuthorization = async (authUrl) => {
			// Pre-validate the attempt stamp, commit SDK auth URL / PKCE, then
			// write identity. Writing before redirect left the new attempt
			// visible to a concurrent checkState while the prior PKCE state
			// was still valid. Redirecting before validate (and returning)
			// left users finishing consent for a flow checkState must refuse.
			const serverId = readProviderString(provider, 'serverId')
			const live = serverId ? await resolveLive(serverId) : null
			const clientId =
				authUrl.searchParams.get('client_id') ||
				readProviderString(provider, 'clientId')
			if (
				!serverId ||
				!live ||
				!clientId ||
				!live.ownerOrgId ||
				!live.personId
			) {
				throw new McpOAuthAttemptIdentityError(
					mcpOAuthAttemptIdentityInvalidMessage(live?.name),
				)
			}
			const discovery =
				typeof provider.discoveryState === 'function'
					? await provider.discoveryState()
					: undefined
			const identity = buildMcpOAuthAttemptIdentity({
				serverId: live.serverId,
				serverUrl: live.serverUrl,
				clientId,
				ownerOrgId: live.ownerOrgId,
				personId: live.personId,
				discovery,
			})
			if (!identity) {
				throw new McpOAuthAttemptIdentityError(
					mcpOAuthAttemptIdentityInvalidMessage(live.name),
				)
			}
			// Do not wipe the live grant here. The SDK can call redirect after a
			// transient refresh failure; deleting first would drop a recoverable
			// token. consumeVerifiedAttempt clears sibling blobs when the new
			// authorization-code grant is saved.
			if (clientId) provider.clientId = clientId
			await redirect(authUrl)
			try {
				await writeMcpOAuthAttemptIdentity(provider.storage, identity)
			} catch (error) {
				clearMcpOAuthProviderAuthUrl(provider)
				throw error
			}
		}
	}
	if (typeof provider.checkState === 'function') {
		const checkState = provider.checkState.bind(provider)
		provider.checkState = async (state) => {
			const result = await checkState(state)
			if (!result.valid || !result.serverId) return result
			const pending = await readMcpOAuthAttemptIdentity(
				provider.storage,
				result.serverId,
			)
			const live = await resolveLive(result.serverId)
			const discovery =
				typeof provider.discoveryState === 'function'
					? await provider.discoveryState()
					: undefined
			// Re-read after the awaits: a concurrent redirect can replace the
			// pending attempt (and clear any verified marker). Binding the
			// marker to the attempt we just checked keeps that race fail-closed.
			const pendingNow = await readMcpOAuthAttemptIdentity(
				provider.storage,
				result.serverId,
			)
			if (
				!pending ||
				!pendingNow ||
				pendingNow.clientId !== pending.clientId ||
				pendingNow.personId !== pending.personId ||
				pendingNow.ownerOrgId !== pending.ownerOrgId ||
				pendingNow.serverUrl !== pending.serverUrl ||
				pendingNow.serverOrigin !== pending.serverOrigin ||
				pendingNow.authorizationServerOrigin !==
					pending.authorizationServerOrigin ||
				!oauthAttemptMatchesLiveServer({
					pending: pendingNow,
					live,
					discovery,
				})
			) {
				await clearMcpOAuthAttemptIdentity(provider.storage, result.serverId)
				return mcpOAuthAttemptCheckFailure({ serverName: live?.name })
			}
			// Only authorization-code completion (after checkState) may consume
			// the pending attempt in saveTokens; refresh must leave it alone.
			await markMcpOAuthAttemptVerified(provider.storage, result.serverId)
			return result
		}
	}
}

function installMcpOAuthTokenPreservation(
	provider: DurableObjectOAuthClientProvider,
	options?: {
		resolveLiveServerIdentity?: ResolveMcpOAuthLiveServerIdentity
	},
) {
	if (
		typeof provider.saveTokens !== 'function' ||
		typeof provider.tokens !== 'function' ||
		typeof provider.discoveryState !== 'function' ||
		typeof provider.saveDiscoveryState !== 'function'
	) {
		return
	}
	const saveTokens = provider.saveTokens.bind(provider)
	const readTokens = provider.tokens.bind(provider)
	const readDiscovery = provider.discoveryState.bind(provider)
	const writeDiscovery = provider.saveDiscoveryState.bind(provider)
	const invalidateCredentials =
		typeof provider.invalidateCredentials === 'function'
			? provider.invalidateCredentials.bind(provider)
			: null
	const resolveLive = options?.resolveLiveServerIdentity
	let saveQueue = Promise.resolve()
	let tokenWriteGeneration = 0
	provider.tokens = async (context) => {
		const stored = await collectStoredMcpOAuthTokenSources(provider)
		if (!readProviderString(provider, 'clientId') && stored.clientId) {
			provider.clientId = stored.clientId
		}
		const blob = await readTokens(context).catch(() => undefined)
		return restoreReadableMcpOAuthTokens({
			blob,
			sources: stored.sources,
		}) as McpOAuthStoredTokens
	}
	provider.saveTokens = async (incoming, context) => {
		const run = saveQueue.then(async () => {
			const result = await savePreservedMcpOAuthTokens({
				provider,
				incoming,
				context,
				saveTokens,
				readTokens,
				readDiscovery,
				writeDiscovery,
				resolveLiveServerIdentity: resolveLive,
			})
			tokenWriteGeneration += 1
			// Do not release coalesce here. The parent refresh token must stay
			// shareable until grace expires so a concurrent auth() that already
			// read it still joins the completed exchange. The rotated token is a
			// different coalesce key, so the next refresh is unblocked. Invalidate
			// clears the maps when the grant is dropped.
			return result
		})
		saveQueue = run.then(
			() => {},
			() => {},
		)
		return run
	}
	if (invalidateCredentials) {
		provider.invalidateCredentials = async (scope) => {
			const generationAtRequest = tokenWriteGeneration
			const run = saveQueue.then(async () => {
				if (
					scope === 'tokens' &&
					tokenWriteGeneration !== generationAtRequest
				) {
					return
				}
				const stored = await collectStoredMcpOAuthTokenSources(provider)
				if (!readProviderString(provider, 'clientId') && stored.clientId) {
					provider.clientId = stored.clientId
				}
				await invalidateCredentials(scope)
				if (scope !== 'all' && scope !== 'client' && scope !== 'tokens') {
					return
				}
				const serverId = readProviderString(provider, 'serverId')
				if (!serverId) return
				await deleteStoredMcpOAuthTokenBlobs(provider, serverId)
				releaseMcpOAuthRefreshCoalesce(provider)
				if (scope === 'all' || scope === 'client') {
					await clearMcpOAuthAttemptIdentity(provider.storage, serverId)
				}
			})
			saveQueue = run.then(
				() => {},
				() => {},
			)
			return run
		}
	}
}

async function savePreservedMcpOAuthTokens(input: {
	provider: DurableObjectOAuthClientProvider
	incoming: McpOAuthSaveTokens
	context: McpOAuthTokenContext
	saveTokens: DurableObjectOAuthClientProvider['saveTokens']
	readTokens: DurableObjectOAuthClientProvider['tokens']
	readDiscovery: DurableObjectOAuthClientProvider['discoveryState']
	writeDiscovery: DurableObjectOAuthClientProvider['saveDiscoveryState']
	resolveLiveServerIdentity?: ResolveMcpOAuthLiveServerIdentity
}) {
	const stored = await collectStoredMcpOAuthTokenSources(input.provider)
	if (!readProviderString(input.provider, 'clientId') && stored.clientId) {
		input.provider.clientId = stored.clientId
	}
	const serverId = readProviderString(input.provider, 'serverId')
	const pending = serverId
		? await readMcpOAuthAttemptIdentity(input.provider.storage, serverId)
		: null
	const completingAuthorization =
		Boolean(pending) &&
		Boolean(serverId) &&
		(await isMcpOAuthAttemptVerified(input.provider.storage, serverId!))
	const [existing, discovery] = await Promise.all([
		input.readTokens(input.context).catch(() => undefined),
		input.readDiscovery(),
	])
	// Authorization-code completion after checkState re-checks identity
	// immediately before the grant write (kody-celld #57 / #65). Refresh has
	// no OAuth actor, so live.ownerOrgId/personId are null. Treat that as a
	// normal refresh: save tokens and leave the verified attempt alone so a
	// concurrent grant (or a later reconnect) can still finish. Throwing here
	// would wedge every later refresh if the code exchange never persisted a
	// grant. Only actor-bearing saves consume the pending row.
	let consumeVerifiedAttempt = false
	if (completingAuthorization && pending) {
		if (!serverId || !input.resolveLiveServerIdentity) {
			await clearMcpOAuthAttemptIdentity(
				input.provider.storage,
				pending.serverId,
			)
			throw new McpOAuthAttemptIdentityError()
		}
		const live = await input.resolveLiveServerIdentity(serverId)
		if (!live) {
			await clearMcpOAuthAttemptIdentity(input.provider.storage, serverId)
			throw new McpOAuthAttemptIdentityError()
		}
		if (live.ownerOrgId && live.personId) {
			if (
				!oauthAttemptMatchesLiveServer({
					pending,
					live,
					discovery,
				})
			) {
				await clearMcpOAuthAttemptIdentity(input.provider.storage, serverId)
				throw new McpOAuthAttemptIdentityError(
					mcpOAuthAttemptIdentityInvalidMessage(live.name),
				)
			}
			consumeVerifiedAttempt = true
		}
	}
	const activeClientId =
		(consumeVerifiedAttempt && pending?.clientId ? pending.clientId : null) ||
		readProviderString(input.provider, 'clientId') ||
		stored.clientId
	if (activeClientId) {
		input.provider.clientId = activeClientId
	}
	const merged = withPreservedMcpOAuthRefreshToken({
		incoming: input.incoming,
		sources: consumeVerifiedAttempt ? [] : [existing, ...stored.sources],
	})
	// Save the replacement first. Deleting sibling blobs before saveTokens
	// would drop a recoverable grant if the write failed mid-exchange.
	await input.saveTokens(
		merged && typeof merged === 'object'
			? (merged as McpOAuthSaveTokens)
			: input.incoming,
		input.context,
	)
	if (consumeVerifiedAttempt && serverId) {
		// Authorization-code completion succeeded: drop leftover DCR/CIMD
		// sibling `/token` blobs so they cannot shadow the new active client.
		// Keep the just-saved active-client key. Actor-less refresh during a
		// verified window must not wipe the seed (consumeVerifiedAttempt false).
		await deleteSiblingMcpOAuthTokenBlobs(
			input.provider,
			serverId,
			activeClientId,
		)
	}
	const refreshToken = parseStoredMcpOAuthRefreshToken(merged)
	if (serverId && refreshToken) {
		await input.provider.storage.put(mcpOAuthRefreshTokenStorageKey(serverId), {
			refresh_token: refreshToken,
		})
		await input.provider.storage.delete(
			mcpOAuthRefreshGrantOmittedStorageKey(serverId),
		)
	} else if (serverId && !readMcpOAuthTokenPresence(merged).hasRefreshToken) {
		if (consumeVerifiedAttempt) {
			// New authorization-code grant without a refresh token: drop the
			// prior sidecar so tokens() cannot resurrect the old rotating RT.
			await input.provider.storage.delete(
				mcpOAuthRefreshTokenStorageKey(serverId),
			)
		}
		if (mcpOAuthDiscoveryAdvertisesRefresh(discovery)) {
			await input.provider.storage.put(
				mcpOAuthRefreshGrantOmittedStorageKey(serverId),
				{ omitted: true, at: new Date().toISOString() },
			)
		}
	}
	if (discovery !== undefined) {
		await input.writeDiscovery(discovery)
	}
	if (consumeVerifiedAttempt && serverId) {
		await clearMcpOAuthAttemptIdentity(input.provider.storage, serverId)
	}
}

async function collectStoredMcpOAuthTokenSources(
	provider: DurableObjectOAuthClientProvider,
) {
	const serverId = readProviderString(provider, 'serverId')
	if (!serverId) {
		return { sources: [] as Array<unknown>, clientId: null as string | null }
	}
	const sidecar = parseStoredMcpOAuthRefreshToken(
		await provider.storage.get(mcpOAuthRefreshTokenStorageKey(serverId)),
	)
	const prefix = mcpOAuthServerStoragePrefix({
		clientName: mcpClientName,
		serverId,
	})
	const entries = await provider.storage.list({ prefix })
	const siblings: Array<{
		clientId: string
		value: unknown
		hasRefreshToken: boolean
	}> = []
	for (const [key, value] of entries) {
		const clientId = clientIdFromMcpOAuthTokenStorageKey({
			clientName: mcpClientName,
			serverId,
			key,
		})
		if (!clientId) continue
		siblings.push({
			clientId,
			value,
			hasRefreshToken: readMcpOAuthTokenPresence(value).hasRefreshToken,
		})
	}
	const preferredClientId =
		readProviderString(provider, 'clientId') ||
		(provider as McpClientOAuthProvider).clientMetadataUrl ||
		null
	const inferredClientId = preferMcpOAuthStoredClientId({
		preferredClientId,
		siblings,
	})
	return {
		sources: [
			sidecar ? { refresh_token: sidecar } : null,
			...siblings.map((sibling) => sibling.value),
		].filter((source) => source != null),
		clientId: inferredClientId,
	}
}

async function deleteStoredMcpOAuthTokenBlobs(
	provider: DurableObjectOAuthClientProvider,
	serverId: string,
) {
	const keys = [
		mcpOAuthRefreshTokenStorageKey(serverId),
		mcpOAuthRefreshGrantOmittedStorageKey(serverId),
		...(await listMcpOAuthTokenBlobKeys(provider, serverId)),
	]
	await provider.storage.delete(keys)
}

/** After a successful authorization-code save, drop other client-id `/token` keys. */
async function deleteSiblingMcpOAuthTokenBlobs(
	provider: DurableObjectOAuthClientProvider,
	serverId: string,
	activeClientId: string | null,
) {
	const keys = (await listMcpOAuthTokenBlobKeys(provider, serverId)).filter(
		(key) => {
			const clientId = clientIdFromMcpOAuthTokenStorageKey({
				clientName: mcpClientName,
				serverId,
				key,
			})
			return Boolean(clientId) && clientId !== activeClientId
		},
	)
	if (keys.length > 0) {
		await provider.storage.delete(keys)
	}
}

async function listMcpOAuthTokenBlobKeys(
	provider: DurableObjectOAuthClientProvider,
	serverId: string,
) {
	const keys: Array<string> = []
	const prefix = mcpOAuthServerStoragePrefix({
		clientName: mcpClientName,
		serverId,
	})
	const entries = await provider.storage.list({ prefix })
	for (const key of entries.keys()) {
		if (
			clientIdFromMcpOAuthTokenStorageKey({
				clientName: mcpClientName,
				serverId,
				key,
			})
		) {
			keys.push(key)
		}
	}
	return keys
}

function readProviderString(
	provider: DurableObjectOAuthClientProvider,
	key: 'serverId' | 'clientId',
) {
	try {
		const value = provider[key]
		return typeof value === 'string' && value.trim().length > 0 ? value : null
	} catch {
		return null
	}
}

/** Drop a committed auth URL when attempt identity could not be persisted. */
function clearMcpOAuthProviderAuthUrl(
	provider: DurableObjectOAuthClientProvider,
) {
	// SDK stores authUrl on a private field; clear via unknown so a failed
	// stamp write cannot leave callers with a sendable authorize URL.
	;(provider as unknown as { _authUrl_?: string })._authUrl_ = undefined
}
