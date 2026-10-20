import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'
import type * as IntegrationsService from '#worker/integrations/service.ts'
import { type JoinedIntegration } from '#worker/integrations/types.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	resolveSavedPackageRef: vi.fn(),
	getJoinedIntegration: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
	collectIntegrationPackageSuggestions: vi.fn(),
}))

vi.mock('#worker/community/fork-listing-relation.ts', () => ({
	applySavedPackageForkListingAncestry: async ({
		records,
	}: {
		records: Array<unknown>
	}) => records,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	resolveSavedPackageRef: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackageRef(...args),
	getSavedPackageWithCommunityProvenanceById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	resolveSavedPackageRefWithCommunityProvenance: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackageRef(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('#worker/integrations/service.ts', async () => {
	const actual = await vi.importActual<typeof IntegrationsService>(
		'#worker/integrations/service.ts',
	)
	return {
		...actual,
		getJoinedIntegration: (...args: Array<unknown>) =>
			mockModule.getJoinedIntegration(...args),
	}
})

vi.mock('./integration-package-suggestions.ts', () => ({
	collectIntegrationPackageSuggestions: (...args: Array<unknown>) =>
		mockModule.collectIntegrationPackageSuggestions(...args),
}))

const { resolveEntityDetail } = await import('./search-detail.ts')

function createAgent({
	userId = 'user-1',
	roles,
	baseUrl = 'https://example.com',
	env = {},
}: {
	userId?: string
	roles?: Array<string>
	baseUrl?: string
	env?: Record<string, unknown>
} = {}) {
	const callerContext = createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl,
		user: {
			userId: personIdFromStored(userId),
			email: `${userId}@example.com`,
			displayName: userId,
			...(roles ? { roles } : {}),
		},
	})
	return {
		getEnv: () => ({ APP_DB: {}, ...env }) as Env,
		getCallerContext: () => callerContext,
	} as unknown as McpRegistrationAgent
}

function emptySearchRows() {
	return {
		userSecretRows: [],
		userIntegrationRows: [],
		packageRows: [],
		registry: { capabilitySpecs: {} },
		warnings: [],
	}
}

function resolve(
	entity: string,
	overrides: Partial<Parameters<typeof resolveEntityDetail>[0]> = {},
) {
	const agent = overrides.agent ?? createAgent()
	return resolveEntityDetail({
		agent,
		callerContext: agent.getCallerContext(),
		userId: ownerIdFromStored('user-1'),
		username: 'user',
		entity,
		searchRows: emptySearchRows() as never,
		...overrides,
	})
}

const anonymous = { userId: null, username: null }

function createJoinedIntegration(name: string): JoinedIntegration {
	const now = '2026-01-01T00:00:00.000Z'
	return {
		lane: 'user',
		app: {
			userId: ownerIdFromStored('user-1'),
			slug: name,
			provider: name,
			label: null,
			clientId: `${name}-client-id-value`,
			hasClientSecret: true,
			tokenUrl: 'https://github.com/login/oauth/access_token',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			deviceAuthorizationUrl: null,
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential',
			usePkce: null,
			tokenExchangeStyle: null,
			scopeSeparator: null,
			extraAuthorizeParams: {},
			createdAt: now,
			updatedAt: now,
		},
		connection: {
			userId: ownerIdFromStored('user-1'),
			credentialId: 'cred-integration',
			name,
			appSlug: name,
			platformAppSlug: null,
			accountLabel: null,
			description: `${name} OAuth integration`,
			scopes: ['repo'],
			requiredHosts: ['api.github.com'],
			usageMode: 'any',
			allowedPackageIds: [],
			connectedAt: null,
			tokenRefreshedAt: null,
			createdAt: now,
			updatedAt: now,
		},
	}
}

test('resolveEntityDetail reports unresolvable entity refs as caller errors', async () => {
	mockModule.getJoinedIntegration.mockResolvedValue(null)
	const badType =
		'Entity type must be one of: capability, guide, integration, mcp-server, package, or secret.'
	const expected = [
		['capability:nope', 'Capability not found.'],
		['user:missing-value:value', badType],
		['integration:notion', 'Saved integration not found for this user.'],
		['secret:API_KEY', 'Secret not found for this user.'],
		[
			'not-a-ref',
			'Entity must use the format "{type}:{id}" where type is capability, guide, integration, mcp-server, package, or secret.',
		],
		['thing:widget', badType],
		['mcp-server:missing', 'MCP server not found.'],
		[
			'capability:search_docs#repo.pushed',
			/Section fragments are only supported on guide and package entities/,
		],
	] as const

	for (const [entity, message] of expected) {
		const detail = resolve(entity)
		await expect(detail).rejects.toThrow(McpCallerError)
		await expect(detail).rejects.toThrow(message)
	}
})

test('resolveEntityDetail lists MCP server tools from the synthesized registry', async () => {
	const detail = await resolve('mcp-server:home', {
		searchRows: {
			...emptySearchRows(),
			registry: {
				capabilityDomains: [
					{
						name: 'mcp:home',
						description: 'Use set_pin after unlocking the island router.',
					},
				],
				capabilitySpecs: {
					'mcp:home:set_pin': {
						name: 'mcp:home:set_pin',
						description: 'Set the island router PIN.',
						domain: 'mcp:home',
						keywords: ['pin'],
						inputFields: ['pin'],
						requiredInputFields: ['pin'],
						outputFields: [],
						readOnly: false,
						idempotent: true,
						destructive: false,
						source: 'mcp-server',
						mcpServer: {
							serverId: 'server-home',
							serverName: 'home',
							kodyName: 'home',
							mcpToolName: 'set_pin',
							toolName: 'set_pin',
						},
						inputSchema: { type: 'object', properties: {} },
						inputTypeDefinition: 'type SetPinInput = { pin: string }',
					},
				},
			},
		} as never,
	})

	expect(detail).toMatchObject({
		type: 'mcp-server',
		id: 'home',
		instructions: 'Use set_pin after unlocking the island router.',
		tools: [
			expect.objectContaining({
				name: 'mcp:home:set_pin',
				entityRef: 'capability:mcp:home:set_pin',
				toolName: 'set_pin',
			}),
		],
	})
})

test('resolveEntityDetail loads official guides without a signed-in user and gates admin guides', async () => {
	const detail = await resolve('guide:package_authoring', anonymous)
	expect(detail).toMatchObject({
		type: 'guide',
		id: 'package_authoring',
		slug: 'package-authoring',
		category: 'platform',
	})
	if (detail.type !== 'guide') {
		throw new Error('expected guide entity detail')
	}
	expect(detail.body.startsWith('#')).toBe(true)
	expect(detail.title.length).toBeGreaterThan(0)

	expect(
		await resolve('guide:package_subscriptions#repo.pushed', anonymous),
	).toMatchObject({
		type: 'guide',
		id: 'package_subscriptions',
		section: 'repo.pushed',
	})

	for (const entity of ['guide:not_a_real_guide', 'guide:admin_events']) {
		await expect(resolve(entity, anonymous)).rejects.toThrow('Guide not found.')
	}
	await expect(resolve('guide:not_a_real_guide', anonymous)).rejects.toThrow(
		/^Guide not found\.$/,
	)
	await expect(resolve('guide:search', anonymous)).rejects.toThrow(
		'Did you mean `guide:search_and_execute`?',
	)

	expect(await resolve('guide:package-authoring', anonymous)).toMatchObject({
		type: 'guide',
		id: 'package_authoring',
		slug: 'package-authoring',
	})
	expect(await resolve('guide:what_can_kody_do', anonymous)).toMatchObject({
		type: 'guide',
		id: 'what_is_kody',
		slug: 'what-is-kody',
	})
	expect(
		await resolve('guide:integration_backed_app', anonymous),
	).toMatchObject({
		type: 'guide',
		id: 'package_apps',
		section: 'after-an-integration-smoke-test',
	})
	expect(
		await resolve('guide:integration-backed-app-happy-path', anonymous),
	).toMatchObject({
		type: 'guide',
		id: 'package_apps',
		section: 'after-an-integration-smoke-test',
	})
	expect(
		await resolve(
			'guide:integration-backed-app-happy-path#session-handoff',
			anonymous,
		),
	).toMatchObject({
		type: 'guide',
		id: 'package_apps',
		section: 'session-handoff',
	})

	expect(
		await resolve('guide:admin_events', {
			agent: createAgent({
				userId: ownerIdFromStored('admin-1'),
				roles: ['admin'],
			}),
			userId: ownerIdFromStored('admin-1'),
			username: 'admin',
		}),
	).toMatchObject({
		type: 'guide',
		id: 'admin_events',
		slug: 'admin-events',
	})
})

test('resolveEntityDetail loads {name}:integration via getJoinedIntegration, isolated by userId', async () => {
	mockModule.getJoinedIntegration.mockImplementation(
		async (input: { userId: string; name: string }) => {
			if (input.userId !== 'user-1' || input.name !== 'github') return null
			return createJoinedIntegration('github')
		},
	)
	mockModule.collectIntegrationPackageSuggestions.mockResolvedValue([])

	const visibleRows = {
		...emptySearchRows(),
		userIntegrationRows: [createJoinedIntegration('github')],
	} as never
	const detail = await resolve('integration:github', {
		searchRows: visibleRows,
	})
	expect(mockModule.getJoinedIntegration).toHaveBeenCalledWith({
		env: { APP_DB: {} },
		userId: ownerIdFromStored('user-1'),
		name: 'github',
	})
	expect(detail).toMatchObject({
		type: 'integration',
		id: 'github',
		title: 'github',
		description: 'github OAuth integration',
		config: {
			name: 'github',
			clientId: 'github-client-id-value',
			tokenUrl: 'https://github.com/login/oauth/access_token',
		},
	})
	expect(detail).not.toHaveProperty('row')

	await expect(
		resolve('integration:github', {
			userId: ownerIdFromStored('user-2'),
			username: 'other',
			searchRows: visibleRows,
		}),
	).rejects.toThrow('Saved integration not found for this user.')
	expect(mockModule.getJoinedIntegration).toHaveBeenLastCalledWith({
		env: { APP_DB: {} },
		userId: ownerIdFromStored('user-2'),
		name: 'github',
	})

	// Search rows are already filtered to integrations the caller can see.
	await expect(resolve('integration:github')).rejects.toThrow(
		'Saved integration not found for this user.',
	)
})

test('resolveEntityDetail hostedUrl uses PACKAGE_APP_BASE_URL when configured', async () => {
	mockModule.resolveSavedPackageRef.mockResolvedValue({
		packageId: 'pkg-1',
		kodyId: 'demo',
		name: '@user/demo',
		description: 'Demo package',
		hasApp: true,
		sourceId: 'source-1',
	})
	mockModule.getSavedPackageById.mockResolvedValue(null)
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		manifest: { kody: {} },
		files: {},
	})

	const detail = await resolve('package:demo', {
		agent: createAgent({
			baseUrl: 'https://heykody.dev',
			env: { PACKAGE_APP_BASE_URL: 'https://kody.run' },
		}),
		username: 'kentcdodds',
	})
	expect(detail).toMatchObject({
		type: 'package',
		hostedUrl: 'https://kentcdodds.kody.run/demo',
		baseUrl: 'https://heykody.dev',
		listingAhead: null,
	})
})

test('resolveEntityDetail hostedUrl uses the package name leaf when kodyId lags', async () => {
	mockModule.resolveSavedPackageRef.mockResolvedValue({
		packageId: 'pkg-1',
		kodyId: 'stale-id',
		name: '@user/demo',
		description: 'Demo package',
		hasApp: true,
		sourceId: 'source-1',
	})
	mockModule.getSavedPackageById.mockResolvedValue(null)
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		manifest: { kody: {} },
		files: {},
	})

	const detail = await resolve('package:stale-id', {
		agent: createAgent({
			baseUrl: 'https://heykody.dev',
			env: { PACKAGE_APP_BASE_URL: 'https://kody.run' },
		}),
		username: 'kentcdodds',
	})
	expect(detail).toMatchObject({
		hostedUrl: 'https://kentcdodds.kody.run/demo',
	})
})

test('resolveEntityDetail passes package export fragments and hidden known-id packages', async () => {
	mockModule.resolveSavedPackageRef.mockResolvedValue({
		id: 'pkg-hidden',
		packageId: 'pkg-hidden',
		kodyId: 'home-controls',
		name: '@user/home-controls',
		description: 'Hidden home controls',
		hasApp: false,
		hidden: true,
		sourceId: 'source-hidden',
		userId: ownerIdFromStored('user-1'),
		tags: [],
		searchText: null,
		isPrivate: false,
		isInternetVisible: false,
		createdAt: '2026-03-20T00:00:00.000Z',
		updatedAt: '2026-03-20T00:00:00.000Z',
	})
	mockModule.getSavedPackageById.mockResolvedValue(null)
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		manifest: {
			name: '@user/home-controls',
			exports: { './bond-area-shades': './src/bond-area-shades.ts' },
			kody: { id: 'home-controls', description: 'Hidden home controls' },
		},
		files: {
			'src/bond-area-shades.ts':
				'/** Lower shades. */\nexport default async function bondAreaShades() { return true }',
		},
	})

	expect(await resolve('package:home-controls#bond-area-shades')).toMatchObject(
		{
			type: 'package',
			id: 'home-controls',
			section: 'bond-area-shades',
			record: expect.objectContaining({ hidden: true }),
		},
	)
	expect(
		await resolve('package:home-controls#./bond-area-shades'),
	).toMatchObject({ type: 'package', section: './bond-area-shades' })
})
