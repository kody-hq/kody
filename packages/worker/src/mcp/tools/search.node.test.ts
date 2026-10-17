import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { buildCapabilityRegistry } from '#mcp/capabilities/build-capability-registry.ts'
import { type Capability } from '#mcp/capabilities/types.ts'
import {
	CAPABILITY_EMBEDDING_DIMENSIONS,
	createTextEmbeddingCache,
	deterministicEmbedding,
} from '#worker/vectorize/embedding.ts'
import { filterCapabilityRegistryForCaller } from '#mcp/capabilities/access-control.ts'
import { defineDomainCapability } from '#mcp/capabilities/define-domain-capability.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { type JoinedIntegration } from '#worker/integrations/types.ts'
import type * as PackageRegistrySource from '#worker/package-registry/source.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import {
	buildSavedPackageSearchRows,
	loadOptionalSearchRows,
	searchUnified,
	settleWithBudget,
	type OptionalSearchRowsResult,
	type PackageSearchRow,
} from './search.ts'

const now = '2026-04-20T00:00:00.000Z'

function createJoinedIntegration(input: {
	userId?: string
	name: string
	description?: string
	appSlug?: string
	provider?: string
	clientId?: string
	tokenUrl?: string
	apiBaseUrl?: string
	authorizeUrl?: string | null
	scopes?: Array<string>
	requiredHosts?: Array<string>
}): JoinedIntegration {
	const userId = input.userId ?? 'user-1'
	const appSlug = input.appSlug ?? input.name
	return {
		lane: 'user',
		app: {
			userId,
			slug: appSlug,
			provider: input.provider ?? appSlug,
			label: null,
			clientId: input.clientId ?? `${input.name}-client-id`,
			hasClientSecret: true,
			tokenUrl: input.tokenUrl ?? 'https://oauth2.googleapis.com/token',
			authorizeUrl:
				input.authorizeUrl === undefined
					? 'https://accounts.google.com/o/oauth2/v2/auth'
					: input.authorizeUrl,
			deviceAuthorizationUrl: null,
			apiBaseUrl: input.apiBaseUrl ?? 'https://www.googleapis.com',
			flow: 'confidential',
			usePkce: null,
			tokenExchangeStyle: null,
			scopeSeparator: null,
			extraAuthorizeParams: {},
			createdAt: now,
			updatedAt: now,
		},
		connection: {
			userId,
			credentialId: 'cred-integration',
			name: input.name,
			appSlug,
			platformAppSlug: null,
			accountLabel: null,
			description: input.description ?? `${input.name} integration`,
			scopes: input.scopes ?? [],
			requiredHosts: input.requiredHosts ?? [],
			usageMode: 'any',
			allowedPackageIds: [],
			connectedAt: null,
			tokenRefreshedAt: null,
			createdAt: now,
			updatedAt: now,
		},
	}
}

function cap(
	name: string,
	domain: string,
	description: string,
	overrides: Partial<Capability> = {},
): Capability {
	return {
		name,
		domain,
		description,
		keywords: [] as Array<string>,
		readOnly: true,
		idempotent: true,
		destructive: false,
		orgPermission: 'none',
		requiresLivePerson: 'never',
		source: 'builtin',
		inputSchema: { type: 'object' as const, properties: {} },
		inputTypeDefinition: '',
		handler: async () => null,
		...overrides,
	}
}

function registryOf(name: string, capabilities: Array<Capability>) {
	return buildCapabilityRegistry([
		{ name, description: `${name} capabilities`, capabilities },
	])
}

const emptyOptionalSearchRows = {
	packageRows: [],
	userSecretRows: [],
	userIntegrationRows: [],
} satisfies Pick<
	OptionalSearchRowsResult,
	'packageRows' | 'userSecretRows' | 'userIntegrationRows'
>

const rows = (overrides: Partial<OptionalSearchRowsResult>) => ({
	...emptyOptionalSearchRows,
	...overrides,
})

function search(
	input: Partial<Parameters<typeof searchUnified>[0]> & { query: string },
) {
	return searchUnified({
		env: {} as Env,
		limit: 5,
		userId: ownerIdFromStored('user-1'),
		registry: buildCapabilityRegistry([]),
		optionalRows: emptyOptionalSearchRows,
		...input,
	})
}

function deterministicAiRun(
	onTexts: (texts: Array<string>) => void = () => {},
) {
	return async (...args: Array<unknown>) => {
		const input = args[1] as { text?: unknown }
		const texts = Array.isArray(input.text)
			? input.text.map(String)
			: [String(input.text ?? '')]
		onTexts(texts)
		return {
			data: texts.map((text) => deterministicEmbedding(text)),
			shape: [texts.length, CAPABILITY_EMBEDDING_DIMENSIONS],
		}
	}
}

function packageRecord(
	id: string,
	userId: string,
	overrides: Partial<PackageSearchRow['record']> = {},
): PackageSearchRow['record'] {
	return {
		id,
		userId: ownerIdFromStored(userId),
		name: id,
		kodyId: id,
		description: '',
		tags: [],
		searchText: null,
		sourceId: `source-${id}`,
		hasApp: false,
		hasSkills: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		lockedAt: null,
		createdAt: now,
		updatedAt: now,
		...overrides,
	}
}

function leanPackageRow(
	id: string,
	userId: string,
	overrides: Partial<PackageSearchRow['record']> = {},
): PackageSearchRow {
	const record = packageRecord(id, userId, {
		kodyId: overrides.name ?? id,
		...overrides,
	})
	return {
		record,
		listingAhead: null,
		projection: {
			name: record.name,
			kodyId: record.kodyId,
			description: record.description,
			tags: record.tags,
			searchText: record.searchText,
			hasApp: record.hasApp,
			isPrivate: false,
			appEntry: null,
			exports: [],
			jobs: [],
			subscriptions: [],
			retrievers: [],
			webhooks: [],
		},
		readmeSnippet: null,
	}
}

const leanPackage = (
	id: string,
	userId: string,
	name: string,
	description: string,
) => leanPackageRow(id, userId, { name, description })

const sourceMocks = vi.hoisted(() => ({
	loadPackageSourceBySourceId: vi.fn(),
}))

vi.mock('#worker/package-registry/source.ts', async () => {
	const actual = await vi.importActual<typeof PackageRegistrySource>(
		'#worker/package-registry/source.ts',
	)
	return {
		...actual,
		loadPackageSourceBySourceId: (...args: Array<unknown>) =>
			sourceMocks.loadPackageSourceBySourceId(...args),
	}
})

test('searchUnified ranks mixed search rows through one shared pipeline', async () => {
	const result = await search({
		query: 'alpha\nbeta\ngamma\ndelta\nepsilon',
		registry: registryOf('meta', [cap('alpha beta', 'meta', 'gamma helper')]),
		optionalRows: rows({
			packageRows: [
				leanPackageRow('pkg-1', 'user-1', {
					name: 'alpha',
					kodyId: 'beta',
					description: 'gamma',
					tags: ['delta'],
					searchText: 'epsilon',
				}),
			],
			userSecretRows: [
				{
					credentialId: 'cred-alpha-secret',
					name: 'alpha-secret',
					scope: 'user',
					description: 'beta gamma delta secret',
					packageId: null,
					updatedAt: now,
				},
			],
			userIntegrationRows: [
				createJoinedIntegration({
					name: 'github',
					description: 'alpha beta gamma integration',
					tokenUrl: 'https://delta.example/token',
					apiBaseUrl: 'https://epsilon.example/api',
					authorizeUrl: null,
					clientId: 'github-client-id',
					requiredHosts: ['epsilon.example'],
				}),
			],
		}),
	})

	expect(result.offline).toBe(true)
	expect(result.matches).toHaveLength(4)
	expect(result.matches).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ type: 'capability', name: 'alpha beta' }),
			expect.objectContaining({ type: 'package', packageId: 'pkg-1' }),
			expect.objectContaining({
				type: 'integration',
				integrationName: 'github',
				tokenUrl: 'https://delta.example/token',
				clientId: 'github-client-id',
			}),
			expect.objectContaining({ type: 'secret', name: 'alpha-secret' }),
		]),
	)
})

test('searchUnified matches integrations by name, scope, and host, keeps shared-app connections distinct, and stays caller-scoped', async () => {
	const optionalRows = rows({
		userIntegrationRows: [
			createJoinedIntegration({
				name: 'google-calendar',
				appSlug: 'google',
				provider: 'google',
				description: 'Calendar connection',
				clientId: 'shared-google-client-id',
				scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
				requiredHosts: ['www.googleapis.com'],
			}),
			createJoinedIntegration({
				name: 'spotify',
				description: 'Spotify music',
				tokenUrl: 'https://accounts.spotify.com/api/token',
				apiBaseUrl: 'https://api.spotify.com',
				authorizeUrl: 'https://accounts.spotify.com/authorize',
				scopes: ['user-read-playback-state'],
				requiredHosts: ['api.spotify.com'],
			}),
		],
	})
	expect(
		(await search({ query: 'google-calendar', optionalRows })).matches[0],
	).toMatchObject({
		type: 'integration',
		integrationName: 'google-calendar',
		clientId: 'shared-google-client-id',
	})
	expect(
		(await search({ query: 'calendar.readonly', optionalRows })).matches,
	).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: 'integration',
				integrationName: 'google-calendar',
			}),
		]),
	)
	expect(
		(await search({ query: 'api.spotify.com', optionalRows })).matches[0],
	).toMatchObject({
		type: 'integration',
		integrationName: 'spotify',
		requiredHosts: ['api.spotify.com'],
	})

	const connections = [
		'google',
		'google-calendar',
		'google-mail',
		'google-drive',
	] as const
	const shared = await search({
		query: 'google www.googleapis.com',
		limit: 10,
		optionalRows: rows({
			userIntegrationRows: connections.map((name) =>
				createJoinedIntegration({
					name,
					appSlug: 'google',
					provider: 'google',
					clientId: 'shared-google-client-id',
					description: `${name} connection`,
					scopes: [`scope-for-${name}`],
					requiredHosts: ['www.googleapis.com'],
				}),
			),
		}),
	})
	const sharedIntegrations = shared.matches.flatMap((match) =>
		match.type === 'integration'
			? [[match.integrationName, match.clientId]]
			: [],
	)
	expect(sharedIntegrations.sort()).toEqual(
		[...connections].sort().map((name) => [name, 'shared-google-client-id']),
	)

	// Loader rows are already user-scoped; an empty load for another user must
	// not surface the first user's integrations.
	const githubRows = rows({
		userIntegrationRows: [
			createJoinedIntegration({
				name: 'github',
				description: 'user-1 github',
				requiredHosts: ['api.github.com'],
			}),
		],
	})
	expect(
		(await search({ query: 'github', optionalRows: githubRows })).matches,
	).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: 'integration',
				integrationName: 'github',
			}),
		]),
	)
	expect(
		(
			await search({ query: 'github', userId: ownerIdFromStored('user-2') })
		).matches.filter((match) => match.type === 'integration'),
	).toEqual([])
})

test('searchUnified hides admin capabilities from non-admins in offline search', async () => {
	const registry = buildCapabilityRegistry([
		{
			name: 'admin',
			description: 'Admin capabilities',
			capabilities: [
				defineDomainCapability('admin', {
					name: 'adminUserList',
					orgPermission: 'none',
					description: 'List admin user account metadata and roles',
					keywords: ['admin', 'users', 'roles', 'accounts'],
					readOnly: true,
					idempotent: true,
					requiredRole: 'admin',
					inputSchema: { type: 'object', properties: {} },
					handler: async () => null,
				}),
			],
		},
		{
			name: 'meta',
			description: 'Meta capabilities',
			capabilities: [
				defineDomainCapability('meta', {
					name: 'publicDocsSearch',
					orgPermission: 'none',
					description: 'Search public docs',
					keywords: ['public', 'docs', 'search'],
					readOnly: true,
					idempotent: true,
					inputSchema: { type: 'object', properties: {} },
					handler: async () => null,
				}),
			],
		},
	])
	const findsAdminCapability = async (roles: Array<string>) => {
		const result = await search({
			env: { SENTRY_ENVIRONMENT: 'test' } as unknown as Env,
			query: 'admin users roles',
			userId: undefined,
			registry: filterCapabilityRegistryForCaller(
				registry,
				createMcpCallerContext({
					source: { kind: 'mcp-oauth' },
					baseUrl: 'https://example.com',
					user: {
						userId: personIdFromStored(`${roles[0]}-1`),
						email: `${roles[0]}@example.com`,
						displayName: roles[0]!,
						roles,
					},
				}),
			),
		})
		return result.matches.some(
			(match) => match.type === 'capability' && match.name === 'adminUserList',
		)
	}
	expect(await findsAdminCapability(['user'])).toBe(false)
	expect(await findsAdminCapability(['admin'])).toBe(true)
})

test('searchUnified ranks the same when retrievers settle during candidate generation', async () => {
	const retrieverResult = {
		id: 'note-1',
		title: 'Target lookup note',
		summary: 'Target can be reached at 555-1234.',
		score: 0.9,
		source: 'notes inbox',
		packageId: 'package-1',
		kodyId: 'notes-package',
		retrieverKey: 'notes',
		retrieverName: 'Notes retriever',
	}
	const fixtures = {
		query: 'target lookup note',
		limit: 5,
		userId: ownerIdFromStored('user-1'),
		registry: registryOf('meta', [
			cap('target_lookup', 'meta', 'Find target details'),
		]),
		optionalRows: rows({
			packageRows: [
				leanPackageRow('pkg-target', 'user-1', {
					name: '@user/target-lookup',
					kodyId: 'target-lookup',
					description: 'Lookup a target from notes.',
				}),
			],
		}),
		env: {
			SENTRY_ENVIRONMENT: 'production',
			CAPABILITY_VECTOR_INDEX: {
				async query() {
					return { matches: [] }
				},
			},
		} as unknown as Env,
	}
	const embedText = async (text: string) => [...deterministicEmbedding(text)]
	const rankedIds = (result: Awaited<ReturnType<typeof search>>) =>
		result.matches.map((match) =>
			match.type === 'capability'
				? `capability:${match.name}`
				: match.type === 'package'
					? `package:${match.kodyId}`
					: match.type === 'retriever_result'
						? `retriever_result:${match.id}`
						: `${match.type}`,
		)

	const sequential = await search({
		...fixtures,
		embedText,
		retrieverResults: [retrieverResult],
	})

	let embeddingStarted = false
	let releaseRetrievers = (_results: Array<typeof retrieverResult>) => {}
	const retrieverResults = new Promise<Array<typeof retrieverResult>>(
		(resolve) => {
			releaseRetrievers = resolve
		},
	)
	const overlappedPromise = search({
		...fixtures,
		embedText: async (text) => {
			embeddingStarted = true
			return await embedText(text)
		},
		retrieverResults,
	})
	await vi.waitFor(() => {
		expect(embeddingStarted).toBe(true)
	})
	releaseRetrievers([retrieverResult])
	const overlapped = await overlappedPromise

	expect(rankedIds(overlapped)).toEqual(rankedIds(sequential))
	expect(rankedIds(overlapped)).toEqual(
		expect.arrayContaining([
			expect.stringContaining('retriever_result:note-1'),
			expect.stringContaining('package:target-lookup'),
			expect.stringContaining('capability:target_lookup'),
		]),
	)
	expect(overlapped.telemetry.candidateCounts).toEqual(
		sequential.telemetry.candidateCounts,
	)
})

test('searchUnified ranks package retriever results alongside capabilities', async () => {
	const retrieverResult = {
		id: 'note-1',
		title: 'Target lookup note',
		summary: 'Target can be reached at 555-1234.',
		score: 0.9,
		source: 'notes inbox',
		packageId: 'package-1',
		kodyId: 'notes-package',
		retrieverKey: 'notes',
		retrieverName: 'Notes retriever',
	}
	const directMatch = await search({
		query: 'target lookup note',
		userId: undefined,
		retrieverResults: [retrieverResult],
	})
	expect(directMatch.matches).toEqual([
		expect.objectContaining({
			type: 'retriever_result',
			id: 'note-1',
			kodyId: 'notes-package',
			retrieverKey: 'notes',
		}),
	])
	expect(directMatch.telemetry.candidateCounts.retriever_result).toBe(1)

	const mixedRanking = await search({
		query: 'target lookup',
		limit: 2,
		userId: undefined,
		registry: registryOf('meta', [
			cap('target_lookup', 'meta', 'Find target details'),
		]),
		retrieverResults: [
			{
				...retrieverResult,
				title: 'Unrelated appliance note',
				summary: 'The appliance is 1800 watts.',
				score: 50,
			},
		],
	})
	expect(mixedRanking.matches).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ type: 'capability', name: 'target_lookup' }),
			expect.objectContaining({ type: 'retriever_result', id: 'note-1' }),
		]),
	)
})

test('optional search rows load packages and secrets without partial fallbacks', async () => {
	const loaders = (
		overrides: Partial<Parameters<typeof loadOptionalSearchRows>[0]> = {},
	) =>
		loadOptionalSearchRows({
			userId: ownerIdFromStored('user-123'),
			loadPackages: async () => [],
			loadUserSecrets: async () => [],
			loadUserIntegrations: async () => [],
			...overrides,
		})
	const unavailable = (name: string) => async () => {
		throw new Error(name)
	}

	await expect(
		loaders({ loadPackages: unavailable('packages unavailable') }),
	).rejects.toThrow('packages unavailable')
	await expect(
		loaders({ loadUserSecrets: unavailable('secrets unavailable') }),
	).rejects.toThrow('secrets unavailable')

	const roku = leanPackageRow('package-123', 'user-123', {
		name: '@kody/roku-remote',
		kodyId: 'roku-remote',
		hasApp: true,
		hasSkills: false,
	})
	const savedPackage = await loaders({ loadPackages: async () => [roku] })
	expect(savedPackage).toEqual({
		...emptyOptionalSearchRows,
		packageRows: [roku],
		warnings: [],
	})

	expect(
		await loaders({
			userId: null,
			loadPackages: unavailable('should not run'),
			loadUserSecrets: unavailable('should not run'),
			loadUserIntegrations: unavailable('should not run'),
		}),
	).toEqual({ ...emptyOptionalSearchRows, warnings: [] })
})

test('buildSavedPackageSearchRows defers source loading and hydrates only top matches', async () => {
	const readmeBody =
		'Package-first trace and debug workflow for failed processor service storage automation.'
	const manifest = parseAuthoredPackageJson({
		content: JSON.stringify({
			name: '@kody/trace-package',
			exports: {
				'./trace-processor': {
					import: './src/trace-processor.ts',
					types: './src/trace-processor.d.ts',
				},
			},
			kody: { id: 'trace-package', description: 'Trace package' },
		}),
		manifestPath: 'package.json',
	})
	sourceMocks.loadPackageSourceBySourceId.mockResolvedValueOnce({
		source: { id: 'source-trace' },
		manifest,
		files: {
			'package.json': '{}',
			'README.md': `# Trace package\n\n${readmeBody}`,
			'src/trace-processor.d.ts':
				'/**\n * Trace failed processor service storage writes.\n */\nexport declare function traceProcessorFailure(messageId: string): Promise<void>\n',
		},
	})
	const buildRows = (record: PackageSearchRow['record']) =>
		buildSavedPackageSearchRows({
			env: {} as Env,
			baseUrl: 'http://localhost',
			userId: ownerIdFromStored('user-123'),
			records: [record],
		})
	const searchRows = (packageRows: Array<PackageSearchRow>, query: string) =>
		search({
			query,
			limit: 3,
			userId: ownerIdFromStored('user-123'),
			optionalRows: rows({ packageRows }),
		})

	const built = await buildRows(
		packageRecord('trace-pkg', 'user-123', {
			name: '@kody/trace-package',
			kodyId: 'trace-package',
			description: 'Trace package',
			tags: ['trace'],
			sourceId: 'source-trace',
		}),
	)
	expect(built.warnings).toEqual([])
	expect(sourceMocks.loadPackageSourceBySourceId).not.toHaveBeenCalled()
	expect(built.rows[0]).toMatchObject({
		readmeSnippet: null,
		projection: expect.objectContaining({
			kodyId: 'trace-package',
			exports: [],
		}),
	})

	const result = await searchRows(built.rows, 'trace package')
	const packageMatch = result.matches.find((match) => match.type === 'package')
	expect(packageMatch).toMatchObject({
		type: 'package',
		kodyId: 'trace-package',
		readmeSnippet: {
			path: 'README.md',
			snippet: expect.stringContaining(readmeBody),
			truncated: false,
		},
	})
	expect(packageMatch?.actionMatches).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				subpath: './trace-processor',
				functions: [expect.objectContaining({ name: 'traceProcessorFailure' })],
			}),
		]),
	)
	expect(sourceMocks.loadPackageSourceBySourceId).toHaveBeenCalledTimes(1)

	consoleWarn.mockImplementation(() => {})
	sourceMocks.loadPackageSourceBySourceId.mockRejectedValueOnce(
		new Error('missing-source'),
	)
	const failedHydration = await buildRows(
		packageRecord('package-123', 'user-123', {
			name: '@kody/observed',
			kodyId: 'observed',
			description: 'Observed package',
			tags: ['observed'],
			searchText: 'search text',
			sourceId: 'missing-source',
			hasApp: true,
			hasSkills: false,
		}),
	)
	const degraded = await searchRows(failedHydration.rows, 'observed package')
	expect(degraded.matches).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				type: 'package',
				kodyId: 'observed',
				readmeSnippet: null,
			}),
		]),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('package-123'),
	)
})

test('searchUnified inlines call shapes for the top three capability matches only', async () => {
	const longTypeBody = Array.from(
		{ length: 40 },
		(_, index) => `field${String(index)}: string`,
	).join('; ')
	const widget = (
		mcpToolName: string,
		description: string,
		inputTypeDefinition: string,
		overrides: Partial<Capability> = {},
	) => {
		const toolName = mcpToolName.replace('_', '')
		return cap(`mcp:widgets:${toolName}`, 'mcp:widgets', description, {
			keywords: ['widget', mcpToolName.split('_')[0]!, 'export'],
			source: 'mcp-server',
			mcpServer: {
				serverId: 'widgets',
				serverName: 'widgets',
				kodyName: 'widgets',
				mcpToolName,
				toolName,
			},
			inputTypeDefinition,
			...overrides,
		})
	}
	const idSchema = {
		type: 'object' as const,
		properties: { id: { type: 'string' as const } },
		required: ['id'],
	}
	const registry = registryOf('mcp:widgets', [
		widget(
			'create_widget',
			'Create a widget export job.',
			`type CreateWidgetInput = { ${longTypeBody} }`,
			{
				readOnly: false,
				idempotent: false,
				inputSchema: {
					type: 'object',
					properties: { name: { type: 'string' } },
					required: ['name'],
				},
			},
		),
		widget(
			'get_widget',
			'Get a widget export job.',
			'type GetWidgetInput = { id: string }',
			{ inputSchema: idSchema },
		),
		widget(
			'list_widgets',
			'List widget export jobs.',
			'type ListWidgetsInput = Record<string, never>',
		),
		widget(
			'delete_widget',
			'Delete a widget export job.',
			'type DeleteWidgetInput = { id: string }',
			{ readOnly: false, destructive: true, inputSchema: idSchema },
		),
	])
	const searchWidgets = (query: string) =>
		search({
			query,
			limit: 10,
			userId: undefined,
			domain: 'mcp:widgets',
			registry,
		})

	const result = await searchWidgets('create widget export job')
	const capabilityMatches = result.matches.filter(
		(match) => match.type === 'capability',
	)
	expect(
		capabilityMatches.map((match) => typeof match.inputTypeDefinition),
	).toEqual(['string', 'string', 'string', 'undefined'])
	expect(capabilityMatches[3]).not.toHaveProperty('inputTypeDefinition')
	expect(capabilityMatches[0]).toMatchObject({
		type: 'capability',
		name: 'mcp:widgets:createwidget',
		inputTypeDefinitionTruncated: true,
	})
	expect(capabilityMatches[0]?.inputTypeDefinition).toContain(
		'required fields: name',
	)

	const [listTop] = (await searchWidgets('list widget export jobs')).matches
	expect(listTop).toMatchObject({
		type: 'capability',
		name: 'mcp:widgets:listwidgets',
		inputTypeDefinition: 'type ListWidgetsInput = Record<string, never>',
	})
	expect(listTop).not.toHaveProperty('inputTypeDefinitionTruncated')
})

test('settleWithBudget uses an absolute launch deadline and degrades safely', async () => {
	await expect(
		settleWithBudget(Promise.resolve('ready'), 25),
	).resolves.toMatchObject({
		ok: true,
		value: 'ready',
		timedOut: false,
		failed: false,
	})
	await expect(
		settleWithBudget(Promise.reject(new Error('memory down')), 100),
	).resolves.toMatchObject({ ok: false, timedOut: false, failed: true })

	vi.useFakeTimers()
	try {
		const settlement = settleWithBudget(new Promise<string>(() => {}), 40)
		await vi.advanceTimersByTimeAsync(40)
		await expect(settlement).resolves.toMatchObject({
			ok: false,
			timedOut: true,
		})

		const overdue = settleWithBudget(
			new Promise(() => {}),
			1_000,
			performance.now() - 2_000,
		)
		await vi.advanceTimersByTimeAsync(0)
		await expect(overdue).resolves.toMatchObject({ ok: false, timedOut: true })
	} finally {
		vi.useRealTimers()
	}
})

test('searchUnified shares query embedding, fail-closes package isolation, and degrades to lexical ranking on Vectorize misses or errors', async () => {
	consoleWarn.mockImplementation(() => {})
	let aiRunCount = 0
	let inFlightQueries = 0
	let maxInFlightQueries = 0
	let packageQueryCount = 0
	let packageVectorFails = false
	const capturedFilters: Array<Record<string, unknown> | undefined> = []
	const aiRun = deterministicAiRun(() => {
		aiRunCount += 1
	})
	const env = {
		SENTRY_ENVIRONMENT: 'production',
		AI: { run: aiRun },
		CAPABILITY_VECTOR_INDEX: {
			async query(
				_values: Array<number>,
				options: { filter?: Record<string, unknown> },
			) {
				capturedFilters.push(options.filter)
				inFlightQueries += 1
				maxInFlightQueries = Math.max(maxInFlightQueries, inFlightQueries)
				await new Promise((resolve) => setTimeout(resolve, 15))
				inFlightQueries -= 1
				const kind = (options.filter as { kind?: { $eq?: string } } | undefined)
					?.kind?.$eq
				if (kind === 'package') {
					packageQueryCount += 1
					if (packageVectorFails) throw new Error('vectorize unavailable')
					return { matches: [{ id: 'package_pkg-weak', score: 0.99 }] }
				}
				return { matches: [{ id: 'inbox_summarize', score: 0.93 }] }
			},
		},
	} as unknown as Env
	const weakRow = leanPackage(
		'pkg-weak',
		'user-1',
		'noise-helper',
		'barely related helper',
	)
	const query = 'summarize inbox threads for triage'

	const overlapped = await search({
		env,
		query,
		registry: registryOf('meta', [
			cap('inbox_summarize', 'meta', 'summarize inbox threads', {
				keywords: ['inbox', 'summarize'],
			}),
		]),
		optionalRows: rows({
			packageRows: [
				weakRow,
				leanPackage(
					'pkg-lexical',
					'user-1',
					'inbox-triage',
					'summarize inbox threads for triage',
				),
			],
		}),
	})
	expect(aiRunCount).toBe(1)
	expect(maxInFlightQueries).toBeGreaterThanOrEqual(2)
	expect(packageQueryCount).toBe(1)
	expect(capturedFilters).toContainEqual(
		expect.objectContaining({
			kind: { $eq: 'package' },
			userId: { $eq: 'user-1' },
		}),
	)
	expect(overlapped.matches[0]).toMatchObject({
		type: 'package',
		packageId: 'pkg-lexical',
	})

	// Without a caller userId (online or offline), packages fail closed.
	for (const searchEnv of [env, {} as Env]) {
		packageQueryCount = 0
		const noUser = await search({
			env: searchEnv,
			query,
			userId: undefined,
			optionalRows: rows({ packageRows: [weakRow] }),
		})
		expect(packageQueryCount).toBe(0)
		expect(noUser.matches.filter((match) => match.type === 'package')).toEqual(
			[],
		)
	}

	// A foreign row fails the whole package lane closed before Vectorize.
	packageQueryCount = 0
	const mismatched = await search({
		env,
		query,
		optionalRows: rows({
			packageRows: [
				weakRow,
				leanPackage(
					'pkg-foreign',
					'user-2',
					'foreign',
					'summarize inbox threads',
				),
			],
		}),
	})
	expect(packageQueryCount).toBe(0)
	expect(
		mismatched.matches.filter((match) => match.type === 'package'),
	).toEqual([])

	packageQueryCount = 0
	packageVectorFails = true
	consoleWarn.mockClear()
	const degraded = await search({
		env,
		query: 'summarize inbox threads',
		optionalRows: rows({
			packageRows: [
				leanPackage(
					'pkg-inbox',
					'user-1',
					'inbox-summarizer',
					'summarize inbox threads',
				),
			],
		}),
	})
	expect(degraded.offline).toBe(false)
	expect(packageQueryCount).toBe(1)
	expect(
		degraded.matches.some(
			(match) => match.type === 'package' && match.packageId === 'pkg-inbox',
		),
	).toBe(true)
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('vectorize unavailable'),
	)
})

test('searchUnified inspect affinity: live-status, package-oriented, and generic value counterexample', async () => {
	const home = (name: string, description: string, keywords: Array<string>) =>
		cap(name, 'home', description, { keywords })
	const registry = registryOf('home', [
		home(
			'sonos_list_players',
			'List known Sonos players with room names and group membership.',
			['sonos', 'speakers', 'list', 'players'],
		),
		home(
			'sonos_get_player_status',
			'Get transport, track, queue, volume, and playback status for a Sonos player.',
			['sonos', 'status', 'playing', 'speakers'],
		),
		{
			...home('sonos_play', 'Start playback on a Sonos player.', [
				'sonos',
				'play',
				'speakers',
				'start',
			]),
			readOnly: false,
			idempotent: false,
		},
		home(
			'webhook_list_status',
			'List webhook delivery status and connection state.',
			['webhook', 'status', 'list', 'connection'],
		),
	])
	const notesPackage = leanPackageRow('pkg-sonos-notes', 'user-1', {
		name: 'sonos-setup-notes',
		description: 'Notes about configuring Sonos speakers around the home.',
		tags: ['sonos', 'notes', 'setup'],
		searchText: 'sonos speakers setup notes',
	})
	const opsPackage = leanPackageRow('pkg-home-ops', 'user-1', {
		name: 'home-ops-manager',
		description:
			'Home automation package management wrappers and workflow helpers.',
		tags: ['home', 'workflow', 'wrapper', 'package'],
		hasApp: true,
		hasSkills: false,
	})
	opsPackage.projection.appEntry = './app.tsx'

	const live = await search({
		query: 'check whether any Sonos speakers are playing',
		limit: 8,
		registry,
		optionalRows: rows({ packageRows: [opsPackage, notesPackage] }),
	})
	expect(live.intent.task.name).toBe('inspect')
	const liveNames = live.matches.map((match) =>
		match.type === 'capability'
			? match.name
			: match.type === 'package'
				? match.kodyId
				: match.type,
	)
	expect(liveNames[0]).toBe('sonos_get_player_status')
	expect(liveNames.slice(0, 3)).toContain('sonos_list_players')
	expect(liveNames.slice(0, 4)).not.toContain('home-ops-manager')
	expect(liveNames).toContain('sonos_play')
	expect(liveNames.indexOf('sonos_get_player_status')).toBeLessThan(
		liveNames.indexOf('sonos_play'),
	)

	const packageOriented = await search({
		query: 'show my Sonos setup notes',
		registry,
		optionalRows: rows({ packageRows: [notesPackage] }),
	})
	expect(packageOriented.matches[0]).toMatchObject({
		type: 'package',
		kodyId: 'sonos-setup-notes',
	})

	const genericSecret = await search({
		query: 'show my webhook api key',
		registry,
		optionalRows: rows({
			userSecretRows: [
				{
					credentialId: 'cred-webhook_api_key',
					name: 'webhook_api_key',
					scope: 'user',
					description: 'Webhook API key for outbound hooks',
					packageId: null,
					updatedAt: now,
				},
			],
		}),
	})
	expect(genericSecret.intent.task.name).toBe('inspect')
	expect(genericSecret.matches[0]).toMatchObject({
		type: 'secret',
		name: 'webhook_api_key',
	})
})

test('searchUnified domain scoping: filter, browse, reject unknown, and overview', async () => {
	const registry = buildCapabilityRegistry([
		{
			name: 'email',
			description: 'Email primitives for the per-user inbox.',
			capabilities: [
				defineDomainCapability('email', {
					name: 'emailSend',
					orgPermission: 'none',
					description: 'Send an email message from the per-user inbox',
					keywords: ['email', 'send', 'mail'],
					readOnly: false,
					idempotent: false,
					inputSchema: {
						type: 'object',
						properties: { to: { type: 'string' } },
						required: ['to'],
					},
					handler: async () => null,
				}),
				defineDomainCapability('email', {
					name: 'emailMessageList',
					orgPermission: 'none',
					description: 'List stored email messages',
					keywords: ['email', 'list', 'mail'],
					readOnly: true,
					idempotent: true,
					inputSchema: { type: 'object', properties: {} },
					handler: async () => null,
				}),
			],
		},
		{
			name: 'jobs',
			description: 'Schedule durable work.',
			capabilities: [
				defineDomainCapability('jobs', {
					name: 'jobUpdate',
					orgPermission: 'none',
					description:
						'Update metadata on a durable job that can send email reminders',
					keywords: ['email', 'schedule', 'job', 'update'],
					readOnly: false,
					idempotent: false,
					inputSchema: { type: 'object', properties: {} },
					handler: async () => null,
				}),
			],
		},
	])
	const capabilityNames = (matches: Array<{ type: string; name?: string }>) =>
		matches.map((match) =>
			match.type === 'capability' ? match.name : match.type,
		)

	const scoped = await search({
		query: 'send email message',
		limit: 10,
		registry,
		domain: 'email',
		optionalRows: rows({
			packageRows: [
				leanPackageRow('pkg-email', 'user-1', {
					name: 'email-digest',
					description: 'send email message digest package',
				}),
			],
		}),
	})
	expect(scoped.matches.length).toBeGreaterThan(0)
	for (const match of scoped.matches) {
		expect(match).toMatchObject({ type: 'capability', domain: 'email' })
	}
	expect(capabilityNames(scoped.matches)).toContain('emailSend')

	const unknownDomain = await search({
		query: 'send email',
		limit: 10,
		registry,
		domain: 'nope',
	}).catch((error: unknown) => error)
	expect(unknownDomain).toBeInstanceOf(McpCallerError)
	expect(unknownDomain).toMatchObject({
		message: expect.stringMatching(/Unknown domain "nope"/),
	})

	const browse = await search({
		query: '',
		limit: 100,
		registry,
		domain: 'email',
	})
	expect(capabilityNames(browse.matches)).toEqual([
		'emailSend',
		'emailMessageList',
	])
	expect(browse.matches[0]).toMatchObject({
		type: 'capability',
		domain: 'email',
		inputTypeDefinition: expect.stringContaining('to'),
	})
	expect(browse.guidance).toBeDefined()

	const truncated = await search({
		query: '',
		limit: 1,
		registry,
		domain: 'email',
	})
	expect(truncated.matches).toHaveLength(1)
	expect(truncated.guidance).toMatch(/truncated/i)

	const overview = await search({
		query: 'what can you do with email',
		limit: 15,
		registry,
	})
	expect(overview.matches).toEqual([
		expect.objectContaining({
			type: 'domain',
			name: 'email',
			capabilityCount: 2,
			sampleCapabilities: ['emailSend', 'emailMessageList'],
		}),
	])
	expect(overview.guidance).toBeDefined()
	expect(overview.telemetry.topResultTypes).toEqual(['domain'])

	const taskQuery = await search({
		query: 'send an email to kent',
		limit: 15,
		registry,
	})
	expect(taskQuery.matches.every((match) => match.type === 'capability')).toBe(
		true,
	)
	expect(capabilityNames(taskQuery.matches)).toContain('emailSend')
})

test('searchUnified drops package rows owned by another org', async () => {
	consoleWarn.mockImplementation(() => {})
	const withForeign = await search({
		query: 'github helpers',
		optionalRows: rows({
			packageRows: [
				leanPackageRow('foreign-pkg', 'someone-else', {
					name: '@someoneelse/github',
					kodyId: 'github',
					description: 'Official GitHub helpers',
				}),
			],
		}),
	})
	expect(withForeign.matches.some((match) => match.type === 'package')).toBe(
		false,
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		expect.stringContaining('row userId mismatch'),
	)
})

test('searchUnified keeps team-org package rows when userId is the bound org', async () => {
	const teamOrgId = 'org-kody-platform'
	const withTeamPackages = await search({
		query: 'agent mail add-rule',
		userId: ownerIdFromStored(teamOrgId),
		optionalRows: rows({
			packageRows: [
				leanPackageRow('agent-mail-pkg', teamOrgId, {
					name: '@kody/agent-mail',
					kodyId: 'agent-mail',
					description: 'AgentMail inboxes for agents',
				}),
			],
		}),
	})
	expect(
		withTeamPackages.matches.some(
			(match) =>
				match.type === 'package' && match.packageId === 'agent-mail-pkg',
		),
	).toBe(true)
})

test('searchUnified embeds each distinct query text once online through a shared embedding cache', async () => {
	const embedTexts: Array<string> = []
	const onlineEnv = {
		SENTRY_ENVIRONMENT: 'production',
		AI: { run: deterministicAiRun((texts) => embedTexts.push(...texts)) },
		CAPABILITY_VECTOR_INDEX: {
			async query() {
				return { matches: [] }
			},
		},
	} as unknown as Env
	const cache = createTextEmbeddingCache(onlineEnv)
	const searchInbox = () =>
		search({
			env: onlineEnv,
			query: 'summarize inbox threads',
			optionalRows: rows({
				packageRows: [
					leanPackage(
						'pkg-inbox',
						'user-1',
						'inbox-summarizer',
						'summarize inbox threads',
					),
				],
			}),
			embedText: cache.embedText,
		})
	const first = await searchInbox()
	const second = await searchInbox()

	expect(first.offline).toBe(false)
	expect(second.offline).toBe(false)
	expect(embedTexts).toEqual(['summarize inbox threads'])
	expect(first.matches.map((match) => match.type)).toEqual(
		second.matches.map((match) => match.type),
	)
	expect(
		first.matches.some(
			(match) => match.type === 'package' && match.packageId === 'pkg-inbox',
		),
	).toBe(true)
})
