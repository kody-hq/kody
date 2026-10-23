import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { type McpServerSettingMetadata } from '#worker/mcp-client/settings-types.ts'

const mockModule = vi.hoisted(() => ({
	getMcpServerSettingById: vi.fn(),
	listMcpServerSettings: vi.fn(),
}))

vi.mock('#worker/mcp-client/settings-service.ts', () => ({
	getMcpServerSettingById: (...args: Array<unknown>) =>
		mockModule.getMcpServerSettingById(...args),
	listMcpServerSettings: (...args: Array<unknown>) =>
		mockModule.listMcpServerSettings(...args),
}))

const { buildMcpServerStatusView, resolveMcpServerSetting } =
	await import('./shared.ts')

function setting(
	overrides: Partial<McpServerSettingMetadata> = {},
): McpServerSettingMetadata {
	return {
		id: 'server-1',
		name: 'ha',
		url: 'https://example.com/mcp',
		enabled: true,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		logoKey: null,
		logoContentType: null,
		logoSource: null,
		faviconSourceHost: null,
		usageMode: 'any',
		allowedPackageIds: [],
		lastError: null,
		...overrides,
	}
}

function snapshot(overrides: Record<string, unknown>) {
	return {
		serverId: 'server-1',
		name: 'ha',
		url: 'https://example.com/mcp',
		state: 'ready' as const,
		authorizationPending: false,
		error: null,
		instructions: null,
		tools: [{ name: 'ping', inputSchema: { type: 'object' as const } }],
		...overrides,
	}
}

const authorizeLink = { appOrigin: 'https://heykody.app', orgSlug: 'acme' }

const owner = {
	env: { APP_DB: {} as D1Database },
	userId: ownerIdFromStored('user-1'),
}

test('resolveMcpServerSetting resolves by id/name and rejects blank or unknown servers', async () => {
	const blank = resolveMcpServerSetting({
		...owner,
		server: '   ',
	})
	await expect(blank).rejects.toThrow(McpCallerError)
	expect(mockModule.getMcpServerSettingById).not.toHaveBeenCalled()
	expect(mockModule.listMcpServerSettings).not.toHaveBeenCalled()

	const byId = setting({ id: 'server-by-id', name: 'ha' })
	mockModule.getMcpServerSettingById.mockResolvedValueOnce(byId)
	await expect(
		resolveMcpServerSetting({
			...owner,
			server: 'server-by-id',
		}),
	).resolves.toEqual(byId)

	mockModule.getMcpServerSettingById.mockResolvedValueOnce(null)
	mockModule.listMcpServerSettings.mockResolvedValueOnce([
		setting({ id: 'server-by-name', name: 'ha' }),
	])
	await expect(
		resolveMcpServerSetting({
			...owner,
			server: 'HA',
		}),
	).resolves.toMatchObject({ id: 'server-by-name', name: 'ha' })

	mockModule.getMcpServerSettingById.mockResolvedValueOnce(null)
	mockModule.listMcpServerSettings.mockResolvedValueOnce([setting()])
	const missing = resolveMcpServerSetting({
		...owner,
		server: 'recipe-keeper',
	})
	await expect(missing).rejects.toThrow(McpCallerError)
})

test('status views omit OAuth client ids and surface durable connection errors', () => {
	const view = buildMcpServerStatusView({
		setting: setting(),
		snapshot: snapshot({ oauthClientId: 'Iv1.github-app-client' }),
		authorizeLink,
	})
	expect(JSON.stringify(view)).not.toContain('Iv1.github-app-client')

	const lastError =
		"Authorization completed at the identity provider, but tool discovery didn't finish (phase server/discover, id attempt-1)."
	const hung = buildMcpServerStatusView({
		setting: setting({ lastError }),
		snapshot: snapshot({ state: 'connected', tools: [] }),
		authorizeLink,
	})
	expect(hung.connected).toBe(false)
	expect(hung.error).toBe(lastError)
	expect(hung.hasRefreshToken).toBe(false)

	const ready = buildMcpServerStatusView({
		setting: setting({ lastError }),
		snapshot: snapshot({}),
		authorizeLink,
	})
	expect(ready.connected).toBe(true)
	expect(ready.error).toBeNull()

	const omittedRefresh =
		"This MCP server's authorization server advertised refresh tokens, but the token response did not include a refresh token. The access token will expire and Kody cannot renew it (phase token exchange, id attempt-omit)."
	const warned = buildMcpServerStatusView({
		setting: setting(),
		snapshot: snapshot({
			lastError: {
				message: omittedRefresh,
				phase: 'token exchange',
				httpStatus: null,
				httpBodySnippet: null,
				mcpEndpoint: 'https://example.com/mcp',
				resource: null,
				authServer: null,
				attemptId: 'attempt-omit',
				at: '2026-09-16T00:00:00.000Z',
			},
			hasRefreshToken: false,
		}),
		authorizeLink,
	})
	expect(warned.connected).toBe(true)
	expect(warned.error).toBeTruthy()
	expect(warned.hasRefreshToken).toBe(false)
})
