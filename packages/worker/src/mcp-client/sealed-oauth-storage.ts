import {
	isSealedSecretPayload,
	openPlatformSecret,
	sealPlatformSecret,
} from '#mcp/secrets/crypto.ts'
import { mcpClientName } from './client-id-metadata.ts'
import { mcpOAuthRefreshTokenStoragePrefix } from './oauth-token-recovery.ts'

/**
 * MCP client OAuth secrets in hub Durable Object storage are sealed with
 * SECRET_STORE_KEY. AAD binds each value to the hub owner, the MCP server
 * id, and the exact storage key, so a value copied to another user, server,
 * or slot fails to open.
 *
 * Sealed: Agents SDK `/token`, `/client_info/` (DCR client_secret), PKCE
 * code verifiers, Kody's refresh-token sidecar, and static transport headers. Discovery metadata,
 * OAuth state nonces, attempt identity, and recovery errors are not secret.
 */

const mcpOAuthSdkPrefix = `/${mcpClientName}/`
const sdkSecretSuffix =
	/\/(?:token|client_info\/|code_verifier|code_verifier\/[^/]+|code_verifier_challenge\/[^/]+)$/

type SealedStorageEnv = Pick<Env, 'SECRET_STORE_KEY'>

/**
 * Static request headers (a user-supplied `Authorization: Bearer` value) for
 * one server. The Agents SDK would persist them in plaintext in
 * `cf_agents_mcp_servers.server_options`, so the hub keeps them here, sealed.
 */
export const mcpStaticTransportHeadersStoragePrefix =
	'mcp-static-transport-headers/'

export function mcpStaticTransportHeadersStorageKey(serverId: string) {
	return `${mcpStaticTransportHeadersStoragePrefix}${serverId}`
}

const sealedSidecarPrefixes = [
	mcpOAuthRefreshTokenStoragePrefix,
	mcpStaticTransportHeadersStoragePrefix,
]

/** Server id the key belongs to when the key holds an OAuth secret. */
export function mcpOAuthSecretServerId(key: string): string | null {
	for (const prefix of sealedSidecarPrefixes) {
		if (!key.startsWith(prefix)) continue
		const serverId = key.slice(prefix.length)
		return serverId.length > 0 && !serverId.includes('/') ? serverId : null
	}
	if (!key.startsWith(mcpOAuthSdkPrefix)) return null
	const rest = key.slice(mcpOAuthSdkPrefix.length)
	const slash = rest.indexOf('/')
	if (slash <= 0) return null
	const serverId = rest.slice(0, slash)
	const clientPart = rest.slice(slash + 1)
	if (serverId === 'kody-transfer-staging') return null
	if (!sdkSecretSuffix.test(`/${clientPart}`)) return null
	// Need a non-empty client id segment before the secret suffix.
	const clientId = `/${clientPart}`.replace(sdkSecretSuffix, '')
	return clientId.length > 1 ? serverId : null
}

function sealedContext(ownerId: string, serverId: string, key: string) {
	return `mcp-hub:${ownerId}|server:${serverId}|key:${key}`
}

export async function sealMcpOAuthStorageValue(input: {
	env: SealedStorageEnv
	ownerId: string
	key: string
	value: unknown
}) {
	const serverId = mcpOAuthSecretServerId(input.key)
	if (!serverId) return input.value
	return sealPlatformSecret(
		input.env,
		'mcp-client-oauth-storage',
		sealedContext(input.ownerId, serverId, input.key),
		JSON.stringify(input.value),
	)
}

export async function openMcpOAuthStorageValue(input: {
	env: SealedStorageEnv
	ownerId: string
	key: string
	value: unknown
}): Promise<unknown> {
	const serverId = mcpOAuthSecretServerId(input.key)
	if (!serverId || input.value === undefined) return input.value
	if (!isSealedSecretPayload(input.value)) {
		throw new Error('Unable to decrypt platform secret.')
	}
	return JSON.parse(
		await openPlatformSecret(
			input.env,
			'mcp-client-oauth-storage',
			sealedContext(input.ownerId, serverId, input.key),
			input.value,
		),
	) as unknown
}

async function openEntries(input: {
	env: SealedStorageEnv
	ownerId: string
	entries: Map<string, unknown>
}) {
	const opened = new Map<string, unknown>()
	for (const [key, value] of input.entries) {
		opened.set(
			key,
			await openMcpOAuthStorageValue({
				env: input.env,
				ownerId: input.ownerId,
				key,
				value,
			}),
		)
	}
	return opened
}

/**
 * DurableObjectStorage view for the MCP client hub. get/list open sealed
 * OAuth values (plaintext secrets fail closed), put seals them, everything
 * else (other keys, sql, transactions, alarms) passes through unchanged.
 */
export function createSealedMcpOAuthStorage(input: {
	storage: DurableObjectStorage
	env: SealedStorageEnv
	resolveOwnerId: () => string
}): DurableObjectStorage {
	const { storage, env } = input
	const ownerId = () => {
		const owner = input.resolveOwnerId()
		if (!owner) throw new Error('MCP client hub owner is unknown.')
		return owner
	}
	const get = async (keyOrKeys: string | Array<string>, options?: unknown) => {
		if (Array.isArray(keyOrKeys)) {
			const entries = (await storage.get(
				keyOrKeys,
				options as DurableObjectGetOptions,
			)) as Map<string, unknown>
			return openEntries({ env, ownerId: ownerId(), entries })
		}
		const value = await storage.get(
			keyOrKeys,
			options as DurableObjectGetOptions,
		)
		if (mcpOAuthSecretServerId(keyOrKeys) === null) return value
		const opened = await openEntries({
			env,
			ownerId: ownerId(),
			entries: new Map([[keyOrKeys, value]]),
		})
		return opened.get(keyOrKeys)
	}
	const list = async (options?: DurableObjectListOptions) => {
		const entries = await storage.list(options)
		return openEntries({ env, ownerId: ownerId(), entries })
	}
	const put = async (
		keyOrEntries: string | Record<string, unknown>,
		valueOrOptions?: unknown,
		options?: DurableObjectPutOptions,
	) => {
		if (typeof keyOrEntries === 'string') {
			const sealed = await sealMcpOAuthStorageValue({
				env,
				ownerId: ownerId(),
				key: keyOrEntries,
				value: valueOrOptions,
			})
			return storage.put(keyOrEntries, sealed, options)
		}
		const sealedEntries: Record<string, unknown> = {}
		for (const [key, value] of Object.entries(keyOrEntries)) {
			sealedEntries[key] = await sealMcpOAuthStorageValue({
				env,
				ownerId: ownerId(),
				key,
				value,
			})
		}
		return storage.put(
			sealedEntries,
			valueOrOptions as DurableObjectPutOptions | undefined,
		)
	}
	return new Proxy(storage, {
		get(target, property, receiver) {
			if (property === 'get') return get
			if (property === 'list') return list
			if (property === 'put') return put
			const value = Reflect.get(target, property, receiver)
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
}
