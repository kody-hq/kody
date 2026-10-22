import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'

const repo = vi.hoisted(() => ({
	listEnabledMcpServerSettingRows: vi.fn(),
	getMcpServerSettingRowById: vi.fn(),
	getMcpServerSettingRowByName: vi.fn(),
	insertMcpServerSettingRow: vi.fn(),
	updateMcpServerSettingRow: vi.fn(),
	deleteMcpServerSettingRow: vi.fn(),
	listMcpServerSettingRows: vi.fn(),
	updateMcpServerSettingUsageRow: vi.fn(),
	updateMcpServerSettingLastErrorRow: vi.fn(),
}))
const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	hubClient: { addServer: vi.fn(), removeServer: vi.fn() },
}))

vi.mock('./settings-repo.ts', () => repo)

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: mockModule.getSavedPackageById,
}))

vi.mock('./hub-client.ts', () => ({
	createMcpClientHubClient: () => mockModule.hubClient,
}))

const {
	addMcpServer,
	enabledMcpServerRefsCacheTtlMs,
	invalidateEnabledMcpServerRefsCache,
	listEnabledMcpServerRefsCached,
	resolveMcpServerOAuthClientUrls,
	listVisibleEnabledMcpServerRefsCached,
	lockMcpServerToPackage,
	persistMcpServerLastErrorIfChanged,
	setMcpServerEnabled,
	setMcpServerUsage,
} = await import('./settings-service.ts')

const env = { APP_DB: {} } as Env

function createSettingRow(id = 'server-1') {
	return {
		id,
		user_id: ownerIdFromStored('user-1'),
		name: `server-${id}`,
		url: `https://mcp.example.com/${id}`,
		enabled: true,
		created_at: '2026-07-01T00:00:00.000Z',
		updated_at: '2026-07-01T00:00:00.000Z',
		logo_key: null,
		logo_content_type: null,
		logo_source: null,
		favicon_source_host: null,
		usage_mode: 'any' as const,
		allowedPackageIds: [],
		last_error: null,
	}
}

function makeLastError(
	input: { message: string; attemptId: string; at: string } & Partial<{
		phase: 'server/discover' | 'token exchange'
		mcpEndpoint: string | null
	}>,
) {
	return {
		phase: 'token exchange' as const,
		httpStatus: null,
		httpBodySnippet: null,
		mcpEndpoint: null,
		resource: null,
		authServer: null,
		...input,
	}
}

function persistLastError(
	state: 'authenticating' | 'ready',
	lastError: ReturnType<typeof makeLastError> | null,
) {
	return persistMcpServerLastErrorIfChanged({
		env,
		userId: ownerIdFromStored('user-1'),
		id: 'server-1',
		state,
		lastError,
	})
}

test('listEnabledMcpServerRefsCached warms per user, expires, and invalidates on mutation', async () => {
	invalidateEnabledMcpServerRefsCache({ userId: ownerIdFromStored('user-1') })
	invalidateEnabledMcpServerRefsCache({ userId: ownerIdFromStored('user-2') })
	repo.listEnabledMcpServerSettingRows.mockResolvedValue([createSettingRow()])
	const first = await listEnabledMcpServerRefsCached({
		env,
		userId: ownerIdFromStored('user-1'),
	})
	const second = await listEnabledMcpServerRefsCached({
		env,
		userId: ownerIdFromStored('user-1'),
	})
	expect(first).toEqual([
		{
			serverId: 'server-1',
			name: 'server-server-1',
			usageMode: 'any',
			allowedPackageIds: [],
		},
	])
	expect(second).toBe(first)
	expect(repo.listEnabledMcpServerSettingRows).toHaveBeenCalledTimes(1)

	await listEnabledMcpServerRefsCached({
		env,
		userId: ownerIdFromStored('user-2'),
	})
	expect(repo.listEnabledMcpServerSettingRows).toHaveBeenCalledTimes(2)
	expect(repo.listEnabledMcpServerSettingRows).toHaveBeenLastCalledWith(
		expect.objectContaining({ userId: ownerIdFromStored('user-2') }),
	)

	vi.useFakeTimers()
	try {
		vi.setSystemTime(Date.now() + enabledMcpServerRefsCacheTtlMs + 1)
		await listEnabledMcpServerRefsCached({
			env,
			userId: ownerIdFromStored('user-1'),
		})
		expect(repo.listEnabledMcpServerSettingRows).toHaveBeenCalledTimes(3)
	} finally {
		vi.useRealTimers()
	}

	repo.getMcpServerSettingRowById.mockResolvedValue(createSettingRow())
	repo.updateMcpServerSettingRow.mockResolvedValue(true)
	await setMcpServerEnabled({
		env,
		userId: ownerIdFromStored('user-1'),
		id: 'server-1',
		enabled: false,
	})
	repo.listEnabledMcpServerSettingRows.mockResolvedValue([])
	expect(
		await listEnabledMcpServerRefsCached({
			env,
			userId: ownerIdFromStored('user-1'),
		}),
	).toEqual([])
	expect(repo.listEnabledMcpServerSettingRows).toHaveBeenCalledTimes(4)
})

test('resolveMcpServerOAuthClientUrls prefers APP_BASE_URL over the request host', () => {
	const cases: Array<[Partial<Env>, string, string, string | null]> = [
		[
			{ APP_BASE_URL: 'https://heykody.app/' },
			'https://heykody.dev/account/mcp-servers',
			'https://heykody.app',
			'https://heykody.app/oauth/client-metadata.json',
		],
		[
			{},
			'https://preview.example/account/mcp-servers',
			'https://preview.example',
			'https://preview.example/oauth/client-metadata.json',
		],
		[
			{},
			'http://localhost:8787/account/mcp-servers',
			'http://localhost:8787',
			null,
		],
	]
	for (const [caseEnv, requestUrl, clientOrigin, clientMetadataUrl] of cases) {
		expect(
			resolveMcpServerOAuthClientUrls({ env: caseEnv, requestUrl }),
		).toEqual({
			clientOrigin,
			callbackUrl: `${clientOrigin}/account/mcp-servers/oauth/callback`,
			clientMetadataUrl,
		})
	}
})

test('addMcpServer rejects a duplicate name as McpCallerError without contacting the hub', async () => {
	repo.getMcpServerSettingRowByName.mockResolvedValue(createSettingRow('dup'))
	mockModule.hubClient.addServer.mockClear()
	repo.insertMcpServerSettingRow.mockClear()
	const error = await addMcpServer({
		env,
		userId: ownerIdFromStored('user-1'),
		name: 'server-dup',
		url: 'https://mcp.example.com/mcp',
		baseUrl: 'https://kody.codes',
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	expect(error).toBeInstanceOf(McpCallerError)
	expect((error as Error).message).toMatch(
		/^An MCP server with this name already exists\./,
	)
	expect((error as Error).message).toContain('mcpServerList')
	expect((error as Error).message).toContain('mcpServerReconnect')
	expect((error as Error).message).toContain('mcpServerRemove')
	expect(mockModule.hubClient.addServer).not.toHaveBeenCalled()
	expect(repo.insertMcpServerSettingRow).not.toHaveBeenCalled()
})

test('addMcpServer keeps connection failures as plain Errors for Sentry', async () => {
	repo.getMcpServerSettingRowByName.mockResolvedValue(null)
	mockModule.hubClient.addServer.mockRejectedValueOnce(
		new Error('hub unreachable'),
	)
	await expect(
		addMcpServer({
			env,
			userId: ownerIdFromStored('user-1'),
			name: 'linear',
			url: 'https://mcp.example.com/mcp',
			baseUrl: 'https://kody.codes',
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof Error &&
			!(error instanceof McpCallerError) &&
			error.message === 'Unable to connect to MCP server: hub unreachable',
	)
})

test('addMcpServer forwards bearer tokens as Authorization headers and persists a discover-timeout lastError', async () => {
	invalidateEnabledMcpServerRefsCache({ userId: ownerIdFromStored('user-1') })
	repo.getMcpServerSettingRowByName.mockResolvedValue(null)
	repo.insertMcpServerSettingRow.mockResolvedValue(undefined)
	mockModule.hubClient.addServer.mockResolvedValue({
		serverId: 'ignored',
		state: 'ready',
		authorizationPending: false,
		error: null,
		toolCount: 1,
	})
	const result = await addMcpServer({
		env,
		userId: ownerIdFromStored('user-1'),
		name: 'linear',
		url: 'https://mcp.example.com/mcp',
		baseUrl: 'https://heykody.app',
		bearerToken: 'secret-token',
	})
	expect(result.setting.name).toBe('linear')
	expect(mockModule.hubClient.addServer).toHaveBeenCalledWith(
		expect.objectContaining({
			name: 'linear',
			url: 'https://mcp.example.com/mcp',
			callbackUrl: 'https://heykody.app/account/mcp-servers/oauth/callback',
			headers: { Authorization: 'Bearer secret-token' },
		}),
	)
	expect(repo.insertMcpServerSettingRow).toHaveBeenCalledWith(
		expect.objectContaining({
			row: expect.objectContaining({
				name: 'linear',
				url: 'https://mcp.example.com/mcp',
				user_id: ownerIdFromStored('user-1'),
			}),
		}),
	)
	// D1 metadata must not carry the credential.
	const insertedRow = repo.insertMcpServerSettingRow.mock.calls[0]?.[0]
		?.row as Record<string, unknown>
	expect(insertedRow).not.toHaveProperty('bearerToken')
	expect(JSON.stringify(insertedRow)).not.toContain('secret-token')

	repo.updateMcpServerSettingLastErrorRow.mockResolvedValue(true)
	const lastError = makeLastError({
		message:
			"Authorization completed at the identity provider, but tool discovery didn't finish (phase server/discover, mcp https://mcp.example.com/mcp, id attempt-add).",
		phase: 'server/discover',
		mcpEndpoint: 'https://mcp.example.com/mcp',
		attemptId: 'attempt-add',
		at: '2026-09-08T00:00:00.000Z',
	})
	mockModule.hubClient.addServer.mockResolvedValue({
		serverId: 'ignored',
		state: 'connected',
		authorizationPending: false,
		error: lastError.message,
		toolCount: 0,
		lastError,
	})
	const timedOut = await addMcpServer({
		env,
		userId: ownerIdFromStored('user-1'),
		name: 'posthog',
		url: 'https://mcp.example.com/mcp',
		baseUrl: 'https://kody.codes',
	})
	expect(timedOut.connection.lastError?.phase).toBe('server/discover')
	expect(timedOut.setting.lastError).toContain("tool discovery didn't finish")
	expect(repo.updateMcpServerSettingLastErrorRow).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			lastError: expect.stringContaining('"phase":"server/discover"'),
		}),
	)
})

test('persistMcpServerLastErrorIfChanged writes token-recovery errors, skips unchanged rows, and swallows D1 failures', async () => {
	const lastWrite = () =>
		repo.updateMcpServerSettingLastErrorRow.mock.lastCall?.[0]
	repo.getMcpServerSettingRowById.mockResolvedValue(createSettingRow())
	repo.updateMcpServerSettingLastErrorRow.mockResolvedValue(true)
	const lastError = makeLastError({
		message:
			'Stored OAuth tokens could not be refreshed (phase token exchange, id attempt-rt).',
		mcpEndpoint: 'https://mediarss.example/mcp',
		attemptId: 'attempt-rt',
		at: '2026-09-14T00:00:00.000Z',
	})
	await persistLastError('authenticating', lastError)
	expect(lastWrite()).toMatchObject({
		userId: ownerIdFromStored('user-1'),
		id: 'server-1',
		lastError: expect.stringContaining('"phase":"token exchange"'),
	})

	repo.getMcpServerSettingRowById.mockResolvedValue({
		...createSettingRow(),
		last_error: JSON.stringify(lastError),
	})
	repo.updateMcpServerSettingLastErrorRow.mockClear()
	await persistLastError('authenticating', lastError)
	expect(repo.updateMcpServerSettingLastErrorRow).not.toHaveBeenCalled()

	await persistLastError(
		'ready',
		makeLastError({
			message:
				"This MCP server's authorization server advertised refresh tokens, but the token response did not include a refresh token. The access token will expire and Kody cannot renew it (phase token exchange, id attempt-omit).",
			mcpEndpoint: 'https://kody-home.doddsfamily.us/mcp',
			attemptId: 'attempt-omit',
			at: '2026-09-16T00:00:00.000Z',
		}),
	)
	expect(lastWrite()).toMatchObject({
		id: 'server-1',
		lastError: expect.stringContaining('"phase":"token exchange"'),
	})
	for (const state of ['ready', 'authenticating'] as const) {
		repo.updateMcpServerSettingLastErrorRow.mockClear()
		await persistLastError(state, null)
		expect(lastWrite()).toMatchObject({ id: 'server-1', lastError: null })
	}

	repo.getMcpServerSettingRowById.mockRejectedValue(new Error('D1 down'))
	await expect(
		persistLastError(
			'authenticating',
			makeLastError({
				message: 'Stored OAuth tokens could not be refreshed',
				attemptId: 'attempt-rt',
				at: '2026-09-14T00:00:00.000Z',
			}),
		),
	).resolves.toBeUndefined()
})

test('MCP server usage lock hides the server from execute and grants a package', async () => {
	invalidateEnabledMcpServerRefsCache({ userId: ownerIdFromStored('user-1') })
	const lockedRow = {
		...createSettingRow(),
		usage_mode: 'packages' as const,
		allowedPackageIds: ['pkg-drafts'],
	}
	repo.getMcpServerSettingRowById.mockResolvedValue(createSettingRow())
	repo.updateMcpServerSettingUsageRow.mockResolvedValue(true)
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'pkg-drafts',
		kodyId: 'gmail-drafts',
	})
	const locked = await lockMcpServerToPackage({
		env,
		userId: ownerIdFromStored('user-1'),
		id: 'server-1',
		packageId: 'pkg-drafts',
	})
	expect(locked.usageMode).toBe('packages')
	expect(locked.allowedPackageIds).toEqual(['pkg-drafts'])
	expect(repo.updateMcpServerSettingUsageRow).toHaveBeenCalledWith(
		expect.objectContaining({
			id: 'server-1',
			usageMode: 'packages',
			allowedPackageIds: ['pkg-drafts'],
		}),
	)

	repo.getMcpServerSettingRowById.mockResolvedValue(lockedRow)
	const unlocked = await setMcpServerUsage({
		env,
		userId: ownerIdFromStored('user-1'),
		id: 'server-1',
		usageMode: 'any',
	})
	expect(unlocked.usageMode).toBe('any')
	expect(unlocked.allowedPackageIds).toEqual([])

	repo.listEnabledMcpServerSettingRows.mockResolvedValue([lockedRow])
	const visibleTo = (packageId?: string) =>
		listVisibleEnabledMcpServerRefsCached({
			env,
			userId: ownerIdFromStored('user-1'),
			...(packageId ? { packageId } : {}),
		})
	expect(await visibleTo()).toEqual([])
	expect(await visibleTo('pkg-drafts')).toEqual([
		{ serverId: 'server-1', name: 'server-server-1' },
	])
	expect(await visibleTo('pkg-other')).toEqual([])
})
