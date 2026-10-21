import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	isValidMcpServerName,
	mcpServerAuthorizationHeaders,
	normalizeMcpServerBearerToken,
	normalizeMcpServerName,
	validateMcpServerUrl,
	type McpServerRef,
} from '@kody-internal/shared/mcp-servers.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { normalizeAllowedPackages } from '#mcp/secrets/allowed-packages.ts'
import {
	encryptMcpServerOAuthClientSecret,
	mcpServerOAuthClientSecretContext,
} from '#mcp/secrets/crypto.ts'
import { getCanonicalAppBaseUrl } from '#worker/app-base-url.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import {
	mcpServerOAuthCallbackPath,
	resolveMcpClientMetadataUrl,
} from './client-id-metadata.ts'
import { createMcpClientHubClient } from './hub-client.ts'
import { mcpOAuthAttemptActorFromIds } from './oauth-attempt.ts'
import { scheduleMcpServerFaviconFill } from './mcp-server-favicon.ts'
import { deleteMcpServerLogoAsset } from './mcp-server-logo.ts'
import {
	mcpServerLastErrorDisplayMessage,
	parseStoredMcpServerLastError,
	stringifyMcpServerLastError,
} from './oauth-settle-error.ts'
import { isMcpOAuthMissingRefreshGrantLastError } from './oauth-token-recovery.ts'
import {
	filterEnabledMcpServerRefsForCaller,
	type EnabledMcpServerRef,
} from './package-access.ts'
import {
	deleteMcpServerSettingRow,
	getMcpServerSettingRowById,
	getMcpServerSettingRowByName,
	insertMcpServerSettingRow,
	listEnabledMcpServerSettingRows,
	listMcpServerSettingRows,
	updateMcpServerSettingLastErrorRow,
	updateMcpServerSettingRow,
	updateMcpServerSettingUsageRow,
} from './settings-repo.ts'
import {
	type McpServerSettingMetadata,
	type McpServerSettingRow,
} from './settings-types.ts'
import {
	type McpServerConnectResult,
	type McpServerOAuthClientChange,
	type McpServerLastError,
} from './types.ts'
import {
	normalizeMcpServerUsageMode,
	type McpServerUsageMode,
} from './usage-mode.ts'

export { mcpServerOAuthCallbackPath } from './client-id-metadata.ts'

export function buildMcpServerOAuthCallbackUrl(baseUrl: string) {
	const origin = baseUrl.trim().replace(/\/+$/, '')
	return `${origin}${mcpServerOAuthCallbackPath}`
}

/**
 * Stable OAuth client origin + callback for user-added MCP servers.
 *
 * Prefer the configured canonical `APP_BASE_URL` (not the request host) so
 * CIMD and DCR always advertise one allowlistable redirect URI during
 * dual-host domain migrations. `clientMetadataUrl` is set only for HTTPS
 * origins (MCP CIMD requires https).
 */
export function resolveMcpServerOAuthClientUrls(input: {
	env: { APP_BASE_URL?: string | null; PACKAGE_APP_BASE_URL?: string | null }
	requestUrl?: string | URL | null
}) {
	const clientOrigin = getCanonicalAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const callbackUrl = buildMcpServerOAuthCallbackUrl(clientOrigin)
	return {
		clientOrigin,
		callbackUrl,
		clientMetadataUrl: resolveMcpClientMetadataUrl(callbackUrl) ?? null,
	}
}

function toMetadata(row: McpServerSettingRow): McpServerSettingMetadata {
	return {
		id: row.id,
		name: row.name,
		url: row.url,
		enabled: row.enabled,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		logoKey: row.logo_key,
		logoContentType: row.logo_content_type,
		logoSource: row.logo_source,
		faviconSourceHost: row.favicon_source_host,
		usageMode: row.usage_mode,
		allowedPackageIds: [...row.allowedPackageIds],
		lastError: mcpServerLastErrorDisplayMessage(
			parseStoredMcpServerLastError(row.last_error),
		),
	}
}

export async function listMcpServerSettings(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
}): Promise<Array<McpServerSettingMetadata>> {
	const rows = await listMcpServerSettingRows({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	return rows.map(toMetadata)
}

export async function listEnabledMcpServerRefs(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
}): Promise<Array<EnabledMcpServerRef>> {
	const rows = await listEnabledMcpServerSettingRows({
		db: input.env.APP_DB,
		userId: input.userId,
	})
	return rows.map((row) => ({
		serverId: row.id,
		name: row.name,
		usageMode: row.usage_mode,
		allowedPackageIds: [...row.allowedPackageIds],
	}))
}

export const enabledMcpServerRefsCacheTtlMs = 30_000
export const enabledMcpServerRefsCacheLimit = 200

function createEnabledMcpServerRefsCache() {
	return new PromiseLruCache<ReadonlyArray<EnabledMcpServerRef>>({
		ttlMs: enabledMcpServerRefsCacheTtlMs,
		limit: enabledMcpServerRefsCacheLimit,
	})
}

const enabledMcpServerRefsCache = createEnabledMcpServerRefsCache()

/**
 * Short-TTL per-user cache over {@link listEnabledMcpServerRefs} for hot
 * invocation paths (capability-registry / runtime metadata assembly, which
 * otherwise pay this D1 read on every run). Mutations in this module
 * invalidate eagerly, so the same-isolate staleness after add / enable /
 * delete is zero; other isolates converge within the TTL — the same bound
 * the MCP hub snapshot cache already uses. Settings UI
 * reads should keep using the uncached functions.
 */
export function listEnabledMcpServerRefsCached(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
}): Promise<ReadonlyArray<EnabledMcpServerRef>> {
	return enabledMcpServerRefsCache.getOrCreate({
		cacheKey: input.userId,
		create: async () => Object.freeze(await listEnabledMcpServerRefs(input)),
	})
}

export async function listVisibleEnabledMcpServerRefsCached(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
	packageId?: string | null
}): Promise<ReadonlyArray<McpServerRef>> {
	const refs = await listEnabledMcpServerRefsCached(input)
	return filterEnabledMcpServerRefsForCaller({
		refs,
		packageId: input.packageId,
	})
}

export function invalidateEnabledMcpServerRefsCache(input: {
	userId: OwnerId
}) {
	enabledMcpServerRefsCache.delete(input.userId)
}

function validateNameOrThrow(name: string) {
	const normalized = normalizeMcpServerName(name)
	if (!normalized) {
		throw new McpCallerError('Server name is required.')
	}
	if (!isValidMcpServerName(normalized)) {
		throw new McpCallerError(
			'Server name must use lowercase letters, numbers, and dashes; start and end with a letter or number; and be at most 64 characters.',
		)
	}
	return normalized
}

const mcpServerSettingNotFoundMessage = 'MCP server setting not found.'

const mcpServerDuplicateNameMessage =
	'An MCP server with this name already exists. Pick another name, or call mcpServerList to find the existing server and use mcpServerReconnect or mcpServerRemove as needed.'

export async function addMcpServer(input: {
	env: Env
	userId: OwnerId
	name: string
	url: string
	baseUrl: string
	/** Signed-in person who started the add; stamped onto in-flight OAuth attempts. */
	personId?: string | null
	/**
	 * Optional static credential for servers that authenticate with a bearer
	 * token (or other Authorization scheme) instead of OAuth. Never stored in
	 * D1 — only forwarded into the hub DO's Agents SDK server options.
	 */
	bearerToken?: string | null
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<{
	setting: McpServerSettingMetadata
	connection: McpServerConnectResult
}> {
	const name = validateNameOrThrow(input.name)
	const urlValidation = validateMcpServerUrl(input.url)
	if (!urlValidation.ok || !urlValidation.url) {
		throw new McpCallerError(urlValidation.error ?? 'Server URL is invalid.')
	}
	const tokenValidation = normalizeMcpServerBearerToken(input.bearerToken)
	if (!tokenValidation.ok) {
		throw new McpCallerError(
			tokenValidation.error ?? 'Bearer token is invalid.',
		)
	}
	const headers = mcpServerAuthorizationHeaders(tokenValidation.authorization)
	const existing = await getMcpServerSettingRowByName({
		db: input.env.APP_DB,
		userId: input.userId,
		name,
	})
	if (existing) {
		throw new McpCallerError(mcpServerDuplicateNameMessage)
	}

	const now = new Date().toISOString()
	const row = {
		id: crypto.randomUUID(),
		user_id: input.userId,
		name,
		url: urlValidation.url,
		enabled: true,
		created_at: now,
		updated_at: now,
		logo_key: null,
		logo_content_type: null,
		logo_source: null,
		favicon_source_host: null,
		usage_mode: 'any',
		allowedPackageIds: [],
		last_error: null,
	} satisfies McpServerSettingRow

	const hub = createMcpClientHubClient({
		env: input.env,
		userId: input.userId,
	})
	let connection: McpServerConnectResult
	try {
		connection = await hub.addServer({
			serverId: row.id,
			name,
			url: urlValidation.url,
			callbackUrl: buildMcpServerOAuthCallbackUrl(input.baseUrl),
			actor: mcpOAuthAttemptActorFromIds({
				ownerOrgId: input.userId,
				personId: input.personId,
			}),
			...(headers ? { headers } : {}),
		})
	} catch (error) {
		const message = getErrorMessage(error)
		throw new Error(`Unable to connect to MCP server: ${message}`)
	}
	try {
		await insertMcpServerSettingRow({ db: input.env.APP_DB, row })
	} catch (error) {
		// Roll back the hub registration so a failed insert does not leave
		// orphaned connection state (or OAuth data) with no D1 record to
		// manage it.
		await hub.removeServer({ serverId: row.id }).catch(() => {})
		throw error
	}
	invalidateEnabledMcpServerRefsCache({ userId: input.userId })
	const lastErrorJson = connection.lastError
		? stringifyMcpServerLastError(connection.lastError)
		: null
	if (connection.lastError) {
		await setMcpServerLastError({
			env: input.env,
			userId: input.userId,
			id: row.id,
			lastError: connection.lastError,
		})
	}
	await scheduleMcpServerFaviconFill({
		db: input.env.APP_DB,
		env: input.env,
		userId: input.userId,
		serverId: row.id,
		waitUntil: input.waitUntil,
	})
	return {
		setting: toMetadata({
			...row,
			last_error: lastErrorJson,
		}),
		connection,
	}
}

export async function setMcpServerEnabled(input: {
	env: Env
	userId: OwnerId
	id: string
	enabled: boolean
}): Promise<McpServerSettingMetadata> {
	const existing = await getMcpServerSettingRowById({
		db: input.env.APP_DB,
		userId: input.userId,
		id: input.id,
	})
	if (!existing) {
		throw new McpCallerError(mcpServerSettingNotFoundMessage)
	}
	const now = new Date().toISOString()
	const row = {
		...existing,
		enabled: input.enabled,
		updated_at: now,
	} satisfies McpServerSettingRow
	const updated = await updateMcpServerSettingRow({
		db: input.env.APP_DB,
		row,
	})
	if (!updated) {
		throw new McpCallerError(mcpServerSettingNotFoundMessage)
	}
	invalidateEnabledMcpServerRefsCache({ userId: input.userId })
	return toMetadata(row)
}

export async function deleteMcpServer(input: {
	env: Env
	userId: OwnerId
	id: string
}): Promise<boolean> {
	const existing = await getMcpServerSettingRowById({
		db: input.env.APP_DB,
		userId: input.userId,
		id: input.id,
	})
	if (!existing) return false
	const hub = createMcpClientHubClient({
		env: input.env,
		userId: input.userId,
	})
	await hub.removeServer({ serverId: input.id })
	if ('COMMUNITY_ASSETS' in input.env && input.env.COMMUNITY_ASSETS) {
		await deleteMcpServerLogoAsset({
			env: input.env,
			logoKey: existing.logo_key,
		})
	}
	const deleted = await deleteMcpServerSettingRow({
		db: input.env.APP_DB,
		userId: input.userId,
		id: input.id,
	})
	invalidateEnabledMcpServerRefsCache({ userId: input.userId })
	return deleted
}

/**
 * Save, replace, or remove (`client: null`) a server's pre-registered OAuth
 * client and restart authorization with it. The secret is sealed here and
 * only the sealed form reaches the hub, which is the one store for the
 * client; its snapshot carries the public client id.
 */
export async function setMcpServerPreRegisteredOAuthClient(input: {
	env: Env
	userId: OwnerId
	id: string
	callbackUrl: string
	personId?: string | null
	client: { clientId: string; clientSecret: string } | null
}): Promise<
	McpServerOAuthClientChange & { setting: McpServerSettingMetadata }
> {
	const existing = await getMcpServerSettingRowById({
		db: input.env.APP_DB,
		userId: input.userId,
		id: input.id,
	})
	if (!existing) {
		throw new McpCallerError(mcpServerSettingNotFoundMessage)
	}
	const sealed = input.client
		? {
				clientId: input.client.clientId,
				sealedClientSecret: await encryptMcpServerOAuthClientSecret(
					input.env,
					input.client.clientSecret,
					mcpServerOAuthClientSecretContext(existing.id),
				),
			}
		: null
	const hub = createMcpClientHubClient({
		env: input.env,
		userId: input.userId,
	})
	let change: McpServerOAuthClientChange
	try {
		change = await hub.setPreRegisteredOAuthClient({
			serverId: existing.id,
			callbackUrl: input.callbackUrl,
			client: sealed,
			actor: mcpOAuthAttemptActorFromIds({
				ownerOrgId: input.userId,
				personId: input.personId,
			}),
		})
	} catch (error) {
		throw new Error(
			`Unable to update the OAuth client: ${getErrorMessage(error)}`,
		)
	}
	if (change.changed) {
		await persistMcpServerLastErrorIfChanged({
			env: input.env,
			userId: input.userId,
			id: existing.id,
			state: change.connection.state,
			lastError: change.connection.lastError ?? null,
		})
	}
	return { ...change, setting: toMetadata(existing) }
}

export async function getMcpServerSettingById(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
	id: string
}): Promise<McpServerSettingMetadata | null> {
	const row = await getMcpServerSettingRowById({
		db: input.env.APP_DB,
		userId: input.userId,
		id: input.id,
	})
	return row ? toMetadata(row) : null
}

export async function setMcpServerUsage(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
	id: string
	usageMode: McpServerUsageMode
	allowedPackageIds?: Array<string>
}): Promise<McpServerSettingMetadata> {
	const existing = await getMcpServerSettingRowById({
		db: input.env.APP_DB,
		userId: input.userId,
		id: input.id,
	})
	if (!existing) {
		throw new McpCallerError(mcpServerSettingNotFoundMessage)
	}
	const usageMode = normalizeMcpServerUsageMode(input.usageMode)
	const allowedPackageIds =
		usageMode === 'packages'
			? normalizeAllowedPackages(input.allowedPackageIds ?? [])
			: []
	const updated = await updateMcpServerSettingUsageRow({
		db: input.env.APP_DB,
		userId: input.userId,
		id: input.id,
		usageMode,
		allowedPackageIds,
	})
	if (!updated) {
		throw new McpCallerError(mcpServerSettingNotFoundMessage)
	}
	invalidateEnabledMcpServerRefsCache({ userId: input.userId })
	return toMetadata({
		...existing,
		usage_mode: usageMode,
		allowedPackageIds,
		updated_at: new Date().toISOString(),
	})
}

/**
 * One-way lock: switch the server to `packages` and grant this saved package.
 * Additional grants accumulate. Unlocking or removing a grant is website-only.
 */
export async function lockMcpServerToPackage(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
	id: string
	packageId: string
}): Promise<McpServerSettingMetadata> {
	const packageId = input.packageId.trim()
	if (!packageId) {
		throw new McpCallerError('Package id is required.')
	}
	const existing = await getMcpServerSettingRowById({
		db: input.env.APP_DB,
		userId: input.userId,
		id: input.id,
	})
	if (!existing) {
		throw new McpCallerError(mcpServerSettingNotFoundMessage)
	}
	const savedPackage = await getSavedPackageById(input.env.APP_DB, {
		userId: input.userId,
		packageId,
	})
	if (!savedPackage) {
		throw new McpCallerError('Saved package not found for this user.')
	}
	if (
		existing.usage_mode === 'packages' &&
		existing.allowedPackageIds.includes(packageId)
	) {
		return toMetadata(existing)
	}
	const allowedPackageIds = normalizeAllowedPackages([
		...existing.allowedPackageIds,
		packageId,
	])
	return setMcpServerUsage({
		env: input.env,
		userId: input.userId,
		id: input.id,
		usageMode: 'packages',
		allowedPackageIds,
	})
}

export async function setMcpServerLastError(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
	id: string
	lastError: McpServerLastError | null
}): Promise<boolean> {
	return updateMcpServerSettingLastErrorRow({
		db: input.env.APP_DB,
		userId: input.userId,
		id: input.id,
		lastError: stringifyMcpServerLastError(input.lastError),
	})
}

export async function persistMcpServerLastErrorIfChanged(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
	id: string
	state: string
	lastError: McpServerLastError | null
}): Promise<void> {
	try {
		const existing = await getMcpServerSettingById({
			env: input.env,
			userId: input.userId,
			id: input.id,
		})
		if (!existing) return
		const lastError = input.lastError
		if (
			lastError &&
			input.state === 'ready' &&
			isMcpOAuthMissingRefreshGrantLastError(lastError)
		) {
			if (existing.lastError === lastError.message) return
			await setMcpServerLastError({
				env: input.env,
				userId: input.userId,
				id: input.id,
				lastError,
			})
			return
		}
		if (
			input.state === 'ready' ||
			(input.state === 'authenticating' && !input.lastError)
		) {
			if (existing.lastError) {
				await setMcpServerLastError({
					env: input.env,
					userId: input.userId,
					id: input.id,
					lastError: null,
				})
			}
			return
		}
		if (!input.lastError) return
		if (existing.lastError === input.lastError.message) return
		await setMcpServerLastError({
			env: input.env,
			userId: input.userId,
			id: input.id,
			lastError: input.lastError,
		})
	} catch {
		// Status reads and reconnect results stay valid if D1 persist fails.
	}
}
