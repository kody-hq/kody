import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { z } from 'zod'
import { normalizeMcpServerName } from '@kody-internal/shared/mcp-servers.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { buildMcpServerAuthorizeUrl } from '#worker/mcp-client/authorize-consent.ts'
import {
	getCachedMcpClientHubReadSnapshot,
	getCachedMcpClientHubSnapshot,
} from '#worker/mcp-client/hub-client.ts'
import { enrichMcpOAuthProviderError } from '#worker/mcp-client/oauth-provider-error.ts'
import {
	getMcpServerSettingById,
	listMcpServerSettings,
} from '#worker/mcp-client/settings-service.ts'
import { type McpServerSettingMetadata } from '#worker/mcp-client/settings-types.ts'
import { isMcpOAuthMissingRefreshGrantLastError } from '#worker/mcp-client/oauth-token-recovery.ts'
import { type McpServerReadSnapshot } from '#worker/mcp-client/types.ts'

export const mcpServerStatusSchema = z.object({
	id: z.string(),
	name: z.string(),
	url: z.string(),
	enabled: z.boolean(),
	state: z.string(),
	connected: z.boolean(),
	toolCount: z.number().int().nonnegative(),
	authUrl: z.string().nullable(),
	error: z.string().nullable(),
	hasRefreshToken: z.boolean(),
	tools: z.array(z.string()),
	createdAt: z.string(),
	updatedAt: z.string(),
	usageMode: z.enum(['any', 'packages']),
	allowedPackageIds: z.array(z.string()),
})

export type McpServerStatusView = z.infer<typeof mcpServerStatusSchema>

/** Where `authUrl` consent links point: canonical app origin plus org handle. */
export type McpServerAuthorizeLinkBase = {
	appOrigin: string
	orgSlug: string
}

/** Org handle for consent links built from a capability caller. */
export function mcpServerCallerOrgSlug(callerContext: {
	request?: { org: { slug: string | null } } | null
	user?: { username?: string | null } | null
}) {
	return (
		callerContext.request?.org.slug?.trim() ||
		callerContext.user?.username?.trim() ||
		''
	)
}

/**
 * The error a status card shows: a ready server's missing-refresh warning, or
 * the live / durable connection error, with OAuth origin hints when known.
 */
export function mcpServerStatusError(input: {
	setting: McpServerSettingMetadata
	snapshot: McpServerReadSnapshot | null
	oauthCallbackUrl?: string
	oauthClientOrigin?: string
	oauthClientMetadataUrl?: string | null
}) {
	const { setting, snapshot } = input
	const readyWarning = isMcpOAuthMissingRefreshGrantLastError(
		snapshot?.lastError ?? null,
	)
		? snapshot?.lastError?.message
		: null
	const rawError =
		snapshot?.state === 'ready'
			? (readyWarning ?? null)
			: (snapshot?.error ?? setting.lastError ?? null)
	return rawError && input.oauthCallbackUrl && input.oauthClientOrigin
		? enrichMcpOAuthProviderError(rawError, {
				callbackUrl: input.oauthCallbackUrl,
				clientOrigin: input.oauthClientOrigin,
				clientMetadataUrl: input.oauthClientMetadataUrl,
			})
		: rawError
}

export function buildMcpServerStatusView(input: {
	setting: McpServerSettingMetadata
	snapshot: McpServerReadSnapshot | null
	authorizeLink: McpServerAuthorizeLinkBase
	oauthCallbackUrl?: string
	oauthClientOrigin?: string
	oauthClientMetadataUrl?: string | null
}): McpServerStatusView {
	const { setting, snapshot } = input
	const connected = snapshot?.state === 'ready'
	const hasDiscovery = connected || snapshot?.state === 'unknown'
	const error = mcpServerStatusError(input)
	return {
		id: setting.id,
		name: setting.name,
		url: setting.url,
		enabled: setting.enabled,
		state: snapshot?.state ?? 'disconnected',
		connected,
		toolCount: hasDiscovery ? (snapshot?.tools.length ?? 0) : 0,
		authUrl: snapshot?.authorizationPending
			? buildMcpServerAuthorizeUrl({
					...input.authorizeLink,
					serverId: setting.id,
				})
			: null,
		error,
		hasRefreshToken: snapshot?.hasRefreshToken ?? false,
		tools: hasDiscovery ? (snapshot?.tools.map((tool) => tool.name) ?? []) : [],
		createdAt: setting.createdAt,
		updatedAt: setting.updatedAt,
		usageMode: setting.usageMode === 'packages' ? 'packages' : 'any',
		allowedPackageIds: [...(setting.allowedPackageIds ?? [])],
	}
}

export async function loadMcpClientHubSnapshotOrNull(input: {
	env: Env
	userId: OwnerId
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	try {
		return await getCachedMcpClientHubSnapshot(input)
	} catch {
		return null
	}
}

/** Resolve a saved MCP server setting by exact id or (normalized) name. */
export async function resolveMcpServerSetting(input: {
	env: Pick<Env, 'APP_DB'>
	userId: OwnerId
	server: string
}): Promise<McpServerSettingMetadata> {
	const identifier = input.server.trim()
	if (!identifier) {
		throw new McpCallerError('Provide the MCP server id or name in "server".')
	}
	const byId = await getMcpServerSettingById({
		env: input.env,
		userId: input.userId,
		id: identifier,
	})
	if (byId) return byId
	const settings = await listMcpServerSettings({
		env: input.env,
		userId: input.userId,
	})
	const normalized = normalizeMcpServerName(identifier)
	const byName = settings.find((setting) => setting.name === normalized)
	if (byName) return byName
	const available = settings.map((setting) => setting.name).join(', ') || 'none'
	// Unknown id/name is a caller mistake (stale name, typo). Keep it off Sentry.
	throw new McpCallerError(
		`No MCP server matches "${identifier}". Saved servers: ${available}.`,
	)
}

export async function loadMcpClientHubReadSnapshotOrNull(input: {
	env: Env
	userId: OwnerId
}) {
	try {
		return await getCachedMcpClientHubReadSnapshot(input)
	} catch {
		return null
	}
}
