import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	getMcpServerSettingById: vi.fn(),
	loadFittedMcpServerLogo: vi.fn(),
	loadOrgBindingForSlug: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/mcp-client/settings-service.ts', () => ({
	getMcpServerSettingById: (...args: Array<unknown>) =>
		mockModule.getMcpServerSettingById(...args),
}))

vi.mock('#worker/mcp-client/mcp-server-logo.ts', () => ({
	loadFittedMcpServerLogo: (...args: Array<unknown>) =>
		mockModule.loadFittedMcpServerLogo(...args),
}))

vi.mock('#worker/orgs/repo.ts', () => ({
	loadOrgBindingForSlug: (...args: Array<unknown>) =>
		mockModule.loadOrgBindingForSlug(...args),
}))

const { createMcpServerLogoHandler } = await import('./mcp-server-logo.ts')

const personalOrgId = ownerIdFromStored('user-1')
const teamOrgId = ownerIdFromStored('org-acme')

function logoOk() {
	mockModule.getMcpServerSettingById.mockResolvedValueOnce({
		id: 's1',
		logoKey: 'user-mcp-server-logos/org-acme/s1/abc.webp',
		logoContentType: 'image/webp',
		logoSource: 'favicon',
		faviconSourceHost: 'example.com',
	})
	mockModule.loadFittedMcpServerLogo.mockResolvedValueOnce({
		body: new Blob([Uint8Array.from([1, 2, 3])]).stream(),
		size: 3,
		httpEtag: '"abc"',
		contentType: 'image/webp',
		cacheControl: 'private, no-store',
	})
}

test('MCP server logo route is owner-scoped and private', async () => {
	const handler = createMcpServerLogoHandler({} as Env)

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null)
	const anonymous = await handler({
		request: new Request('https://example.com/account/mcp-servers/logos/s1'),
		params: { serverId: 's1' },
	} as never)
	expect(anonymous.status).toBe(404)

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce({
		mcpUser: { userId: personIdFromStored('user-1') },
		request: { org: { id: personalOrgId, slug: 'user-1' } },
	})
	mockModule.getMcpServerSettingById.mockResolvedValueOnce(null)
	const missing = await handler({
		request: new Request('https://example.com/account/mcp-servers/logos/s1'),
		params: { serverId: 's1' },
	} as never)
	expect(missing.status).toBe(404)

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce({
		mcpUser: { userId: personIdFromStored('user-1') },
		request: { org: { id: personalOrgId, slug: 'user-1' } },
	})
	logoOk()
	const ok = await handler({
		request: new Request('https://example.com/account/mcp-servers/logos/s1'),
		params: { serverId: 's1' },
	} as never)
	expect(ok.status).toBe(200)
	expect(ok.headers.get('Cache-Control')).toBe('private, no-store')
	expect(ok.headers.get('Content-Type')).toBe('image/webp')
	expect(mockModule.getMcpServerSettingById).toHaveBeenLastCalledWith({
		env: {},
		userId: personalOrgId,
		id: 's1',
	})
})

test('MCP server logo uses the team org from a same-origin Referer', async () => {
	const handler = createMcpServerLogoHandler({ APP_DB: {} } as Env)
	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce({
		mcpUser: { userId: personIdFromStored('user-1') },
		// Logo path is person-scoped, so request.org stays personal.
		request: { org: { id: personalOrgId, slug: 'user-1' } },
	})
	mockModule.loadOrgBindingForSlug.mockResolvedValueOnce({
		org: { id: teamOrgId, slug: 'acme' },
		role: 'member',
	})
	logoOk()

	const ok = await handler({
		request: new Request('https://example.com/account/mcp-servers/logos/s1', {
			headers: { Referer: 'https://example.com/@acme/-/mcp-servers' },
		}),
		params: { serverId: 's1' },
	} as never)

	expect(ok.status).toBe(200)
	expect(mockModule.loadOrgBindingForSlug).toHaveBeenCalledWith(
		{},
		personIdFromStored('user-1'),
		'acme',
	)
	expect(mockModule.getMcpServerSettingById).toHaveBeenLastCalledWith({
		env: { APP_DB: {} },
		userId: teamOrgId,
		id: 's1',
	})
	expect(mockModule.loadFittedMcpServerLogo).toHaveBeenLastCalledWith(
		expect.objectContaining({ userId: teamOrgId }),
	)
})
