import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { mcpClientHubDurableObjectName } from '#worker/user-scoped-durable-object-name.ts'
import { mcpClientName } from './client-id-metadata.ts'
import { mcpConnectionEpisodeStorageKey } from './connection-episodes.ts'
import { mcpLegacyHandshakeStorageKey } from './legacy-handshake.ts'
import {
	mcpOAuthAttemptStorageKey,
	mcpOAuthAttemptVerifiedStorageKey,
} from './oauth-attempt.ts'
import {
	mcpOAuthRefreshGrantOmittedStorageKey,
	mcpOAuthRefreshTokenStorageKey,
	mcpOAuthTokenRecoveryStorageKey,
} from './oauth-token-recovery.ts'
import { mcpPreRegisteredOAuthClientStorageKey } from './preregistered-oauth-client.ts'
import type { McpHubConnectResult } from './types.ts'

/**
 * One remote MCP server's hub state, moved between owners' hubs by the
 * operator org resource transfer. It carries OAuth tokens and client
 * registrations, so it only ever travels Durable Object to worker to Durable
 * Object: never returned, logged, or persisted elsewhere.
 */
export type McpHubServerTransfer = {
	row: {
		id: string
		name: string
		server_url: string
		client_id: string | null
		auth_url: string | null
		callback_url: string
		server_options: string | null
	}
	entries: Array<[key: string, value: unknown]>
}

export type McpHubServerImportResult =
	| { ok: true }
	| { ok: false; reason: 'already_registered' | 'foreign_storage_key' }

export type McpClientHubTransferStub = {
	listServerIdsForTransfer(): Promise<Array<string>>
	exportServerForTransfer(input: {
		serverId: string
	}): Promise<McpHubServerTransfer | null>
	importServerForTransfer(
		input: McpHubServerTransfer,
	): Promise<McpHubServerImportResult>
	discardTransferredServer(input: { serverId: string }): Promise<void>
	connectTransferredServer(input: {
		serverId: string
	}): Promise<McpHubConnectResult>
	removeServerForTransfer(input: { serverId: string }): Promise<void>
}

/**
 * An imported server waits here, outside `cf_agents_mcp_servers`, until the
 * transfer commits: the SDK restores and dials every row in that table, and
 * dialing can rotate OAuth tokens the source still holds.
 */
export type McpHubStagedServer = {
	row: McpHubServerTransfer['row']
	keys: Array<string>
}

export const mcpTransferStagingStoragePrefix = '/kody-transfer-staging/'

export function mcpTransferStagingStorageKey(serverId: string) {
	return `${mcpTransferStagingStoragePrefix}${serverId}`
}

export function mcpClientHubTransferStub(input: {
	env: Pick<Env, 'MCP_CLIENT_HUB'>
	userId: OwnerId
}): McpClientHubTransferStub {
	const namespace = input.env.MCP_CLIENT_HUB
	return namespace.get(
		namespace.idFromName(mcpClientHubDurableObjectName(input.userId)),
	) as unknown as McpClientHubTransferStub
}

/** Agents SDK OAuth provider keys for one server (tokens, client info, PKCE). */
export function mcpServerOAuthStoragePrefix(serverId: string) {
	return `/${mcpClientName}/${serverId}/`
}

/** True when an import carries a key that does not belong to its server. */
export function hasForeignTransferStorageKey(transfer: McpHubServerTransfer) {
	const prefix = mcpServerOAuthStoragePrefix(transfer.row.id)
	const sidecars = new Set(mcpServerSidecarStorageKeys(transfer.row.id))
	return transfer.entries.some(
		([key]) => !key.startsWith(prefix) && !sidecars.has(key),
	)
}

/** Kody's own per-server hub keys outside the SDK prefix. */
export function mcpServerSidecarStorageKeys(serverId: string) {
	return [
		mcpConnectionEpisodeStorageKey(serverId),
		mcpLegacyHandshakeStorageKey(serverId),
		mcpOAuthTokenRecoveryStorageKey(serverId),
		mcpOAuthRefreshTokenStorageKey(serverId),
		mcpOAuthRefreshGrantOmittedStorageKey(serverId),
		mcpPreRegisteredOAuthClientStorageKey(serverId),
		mcpOAuthAttemptStorageKey(serverId),
		mcpOAuthAttemptVerifiedStorageKey(serverId),
	]
}
