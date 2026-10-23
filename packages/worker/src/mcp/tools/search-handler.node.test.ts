import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as CapabilityRegistry from '#mcp/capabilities/registry.ts'
import type * as SecretsService from '#mcp/secrets/service.ts'
import type * as DeriveWaiting from '#mcp/waiting/derive-waiting.ts'
import type * as CommunityService from '#worker/community/service.ts'
import type * as EntitlementsService from '#worker/entitlements/service.ts'
import type * as IntegrationsService from '#worker/integrations/service.ts'
import type * as PackageRepo from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import type * as PackageRetrievers from '#worker/package-retrievers/service.ts'
import type * as SearchRateLimit from '#worker/search-rate-limit.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import type * as MemoryToolContext from './memory-tool-context.ts'
import type * as OnboardingNotice from './search-onboarding-notice.ts'
import {
	SEARCH_DEADLINE_MS,
	SEARCH_ONBOARDING_NOTICE_BUDGET_MS,
	SEARCH_WAITING_ITEMS_BUDGET_MS,
} from './search-constants.ts'

function capabilitySpec(name: string, overrides: Record<string, unknown> = {}) {
	return {
		name,
		description: `${name} capability`,
		domain: 'meta',
		keywords: [],
		inputFields: [],
		requiredInputFields: [],
		outputFields: [],
		readOnly: true,
		idempotent: true,
		destructive: false,
		source: 'builtin',
		inputSchema: { type: 'object', properties: {} },
		inputTypeDefinition: 'type Input = {}',
		...overrides,
	}
}

const mockModule = vi.hoisted(() => ({
	getCapabilityRegistryForContext: vi.fn(
		async (
			..._args: Parameters<
				typeof CapabilityRegistry.getCapabilityRegistryForContext
			>
		) => ({
			capabilitySpecs: {
				search_docs: {
					name: 'search_docs',
					description: 'Search docs capability',
					domain: 'meta',
					keywords: [],
					inputFields: [],
					requiredInputFields: [],
					outputFields: [],
					readOnly: true,
					idempotent: true,
					destructive: false,
					inputSchema: { type: 'object', properties: {} },
				},
			},
		}),
	),
	getSavedPackageById: vi.fn(),
	resolveSavedPackageRef: vi.fn(),
	listSavedPackagesByUserId: vi.fn<
		typeof PackageRepo.listSavedPackagesByUserId
	>(async () => []),
	listUserSecretsForSearch: vi.fn<
		typeof SecretsService.listUserSecretsForSearch
	>(async () => []),
	listJoinedIntegrations: vi.fn<
		typeof IntegrationsService.listJoinedIntegrations
	>(async () => []),
	getJoinedIntegration: vi.fn<typeof IntegrationsService.getJoinedIntegration>(
		async () => null,
	),
	loadPackageSourceBySourceId: vi.fn(),
	loadRelevantMemoriesForTool: vi.fn<
		typeof MemoryToolContext.loadRelevantMemoriesForTool
	>(async () => null),
	acknowledgeToolMemories: vi.fn<
		typeof MemoryToolContext.acknowledgeToolMemories
	>(async () => undefined),
	runPackageRetrievers: vi.fn<typeof PackageRetrievers.runPackageRetrievers>(
		async () => ({ results: [], warnings: [] }),
	),
	searchCommunityListings: vi.fn<
		typeof CommunityService.searchCommunityListings
	>(async () => []),
	deriveWaitingItemsForStableUser: vi.fn<
		typeof DeriveWaiting.deriveWaitingItemsForStableUser
	>(async () => []),
	buildOnboardingSearchNotice: vi.fn<
		typeof OnboardingNotice.buildOnboardingSearchNotice
	>(async () => null),
}))

vi.mock('#mcp/capabilities/registry.ts', () => ({
	getCapabilityRegistryForContext: (
		...args: Parameters<
			typeof CapabilityRegistry.getCapabilityRegistryForContext
		>
	) => mockModule.getCapabilityRegistryForContext(...args),
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
	resolveSavedPackageRefWithCommunityProvenance: async (
		db: unknown,
		input: { userId: string; ref: string },
	) =>
		(await mockModule.getSavedPackageById(db, {
			userId: input.userId,
			packageId: input.ref,
		})) ?? (await mockModule.resolveSavedPackageRef(db, input)),
	listSavedPackagesByUserId: (
		...args: Parameters<typeof PackageRepo.listSavedPackagesByUserId>
	) => mockModule.listSavedPackagesByUserId(...args),
	listSavedPackagesWithCommunityProvenanceByUserId: (
		...args: Parameters<typeof PackageRepo.listSavedPackagesByUserId>
	) => mockModule.listSavedPackagesByUserId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	listUserSecretsForSearch: (
		...args: Parameters<typeof SecretsService.listUserSecretsForSearch>
	) => mockModule.listUserSecretsForSearch(...args),
}))

vi.mock('#worker/integrations/service.ts', async () => {
	const actual = await vi.importActual<typeof IntegrationsService>(
		'#worker/integrations/service.ts',
	)
	return {
		...actual,
		listJoinedIntegrations: (
			...args: Parameters<typeof IntegrationsService.listJoinedIntegrations>
		) => mockModule.listJoinedIntegrations(...args),
		getJoinedIntegration: (
			...args: Parameters<typeof IntegrationsService.getJoinedIntegration>
		) => mockModule.getJoinedIntegration(...args),
	}
})

vi.mock('./memory-tool-context.ts', async () => {
	const actual = await vi.importActual('./memory-tool-context.ts')
	return {
		...actual,
		loadRelevantMemoriesForTool: (
			...args: Parameters<typeof MemoryToolContext.loadRelevantMemoriesForTool>
		) => mockModule.loadRelevantMemoriesForTool(...args),
		acknowledgeToolMemories: (
			...args: Parameters<typeof MemoryToolContext.acknowledgeToolMemories>
		) => mockModule.acknowledgeToolMemories(...args),
	}
})

vi.mock('#worker/package-retrievers/service.ts', () => ({
	runPackageRetrievers: (
		...args: Parameters<typeof PackageRetrievers.runPackageRetrievers>
	) => mockModule.runPackageRetrievers(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	searchCommunityListings: (
		...args: Parameters<typeof CommunityService.searchCommunityListings>
	) => mockModule.searchCommunityListings(...args),
}))

vi.mock('#mcp/waiting/derive-waiting.ts', () => ({
	deriveWaitingItemsForStableUser: (
		...args: Parameters<typeof DeriveWaiting.deriveWaitingItemsForStableUser>
	) => mockModule.deriveWaitingItemsForStableUser(...args),
}))

vi.mock('./search-onboarding-notice.ts', () => ({
	buildOnboardingSearchNotice: (
		...args: Parameters<typeof OnboardingNotice.buildOnboardingSearchNotice>
	) => mockModule.buildOnboardingSearchNotice(...args),
}))

vi.mock('#worker/entitlements/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EntitlementsService>()
	return { ...actual, getUserPlan: async () => 'free' }
})

vi.mock('#worker/search-rate-limit.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof SearchRateLimit>()
	return { ...actual, consumeSearchRateLimit: vi.fn(async () => 'free') }
})

const {
	registerSearchTool,
	SEARCH_MEMORY_ENRICHMENT_BUDGET_MS,
	memoryEnrichmentSkippedWarning,
} = await import('./search.ts')

type SearchResponse = {
	content: Array<{ type: 'text'; text: string }>
	structuredContent: {
		conversationId: string
		timing: {
			startedAt: string
			endedAt: string
			durationMs: number
			serverTiming?: Array<{ name: string; durationMs: number }>
		}
		error?: string
		result?: unknown
	}
	isError?: boolean
}

type SearchHandler = (input: {
	query?: string
	entity?: string | Array<string>
	domain?: string
	limit?: number
	maxResponseSize?: number
	conversationId?: string
	memoryContext?: {
		task?: string
		query?: string
		entities?: Array<string>
		constraints?: Array<string>
	}
	includeHiddenPackages?: boolean
}) => Promise<SearchResponse>

type SearchResult = {
	warnings: Array<string>
	guidance?: string
	matches: Array<{
		type: string
		entityRef?: string
		kodyId?: string
		domain?: string
		relatedPackageSuggestions?: unknown
		wrappingPackage?: { kodyId: string } | null
	}>
	memories?: { surfaced: Array<{ id: string; summary?: string }> }
	waiting?: { count: number; items: Array<{ id: string }> }
	telemetry?: {
		jevRerank?: { enabled: boolean; outcome: string }
		responseTrimmed?: boolean
		trimmedMatchCount?: number
	}
	phaseTimings?: Record<string, unknown>
}

const signedInUser = {
	userId: ownerIdFromStored('user-1'),
	email: 'user@example.com',
	displayName: 'User',
	username: 'user',
}

async function getSearchHandler(
	user: typeof signedInUser | null = signedInUser,
) {
	const registerTool = vi.fn()
	const state: Record<string, unknown> = {}
	await registerSearchTool({
		server: { registerTool } as never,
		getEnv: vi.fn(() => ({ APP_DB: {} })),
		getCallerContext: vi.fn(() => ({ baseUrl: 'https://example.com', user })),
		state,
		setState: vi.fn((nextState: typeof state) => {
			Object.assign(state, nextState)
		}),
	} as never)
	expect(registerTool).toHaveBeenCalledTimes(1)
	const [name, , handler] = registerTool.mock.calls[0] ?? []
	expect(name).toBe('search')
	return handler as SearchHandler
}

const textOf = (response: SearchResponse) =>
	response.content.map((item) => item.text).join('\n')
const resultOf = (response: SearchResponse) =>
	response.structuredContent.result as SearchResult
const packageIdsOf = (response: SearchResponse) =>
	resultOf(response)
		.matches.filter((match) => match.type === 'package')
		.map((match) => match.kodyId)

function savedPackage(
	id: string,
	overrides: Partial<SavedPackageRecord> = {},
): SavedPackageRecord {
	return {
		id,
		userId: ownerIdFromStored('user-1'),
		name: id,
		kodyId: id,
		description: `${id} package`,
		tags: [],
		searchText: `${id} package`,
		sourceId: `source-${id}`,
		hasApp: false,
		hasSkills: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		lockedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	}
}

const createSavedPackages = () => [
	savedPackage('hidden-notes-pkg', { hidden: true }),
	savedPackage('visible-notes-pkg'),
]

function memorySummary(
	id: string,
	summary: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		memories: [
			{
				id,
				category: 'preference',
				status: 'active',
				subject: 'Search preference',
				summary,
				details: '',
				tags: ['search'],
				sourceUris: [],
				updatedAt: '2026-04-20T00:00:00.000Z',
				scope: 'personal' as const,
				...overrides,
			},
		],
		suppressedCount: 0,
		retrievalQuery: 'search docs',
		retrieverResults: [],
		retrieverWarnings: [],
	}
}

test('search tool returns compact query markdown while preserving structured auxiliary detail', async () => {
	mockModule.loadRelevantMemoriesForTool.mockResolvedValueOnce({
		...memorySummary('memory-1', 'Prefers compact search results.', {
			subject: 'Verbose memory subject',
			details: 'Long memory details should stay out of the text response.',
		}),
		retrieverWarnings: [
			'First memory retriever warning should remain structured.',
			'Second memory retriever warning should remain structured.',
		],
	})
	const handler = await getSearchHandler()

	const successResponse = await handler({
		query: 'search docs',
		conversationId: 'conv-compact-search',
	})
	expect(successResponse.isError).toBeUndefined()
	expect(successResponse.structuredContent).toMatchObject({
		conversationId: 'conv-compact-search',
		timing: {
			startedAt: expect.any(String),
			endedAt: expect.any(String),
			durationMs: expect.any(Number),
		},
	})
	expect(
		successResponse.structuredContent.timing.durationMs,
	).toBeGreaterThanOrEqual(0)
	expect(textOf(successResponse)).toContain('Prefers compact search results.')
	const result = resultOf(successResponse)
	expect(result.warnings).toHaveLength(2)
	expect(result.memories?.surfaced).toEqual([
		expect.objectContaining({ id: 'memory-1' }),
	])
	expect(result.phaseTimings).toEqual(
		expect.objectContaining({
			memoryEnrichmentTimedOut: false,
			loadAndRankMs: expect.any(Number),
			jevRerankMs: expect.any(Number),
		}),
	)
	expect(mockModule.acknowledgeToolMemories).not.toHaveBeenCalled()

	const emptyDiscoveryResponse = await handler({
		conversationId: 'conv-search-error',
	})
	expect(emptyDiscoveryResponse.isError).toBeUndefined()
	expect(emptyDiscoveryResponse.structuredContent).toMatchObject({
		conversationId: 'conv-search-error',
		timing: { durationMs: expect.any(Number) },
		result: { matches: [] },
	})

	mockModule.getCapabilityRegistryForContext.mockRejectedValueOnce(
		new Error('Registry unavailable'),
	)
	const handledErrorResponse = await handler({
		query: 'search docs',
		conversationId: 'conv-search-handled-error',
	})
	expect(handledErrorResponse.isError).toBe(true)
	expect(handledErrorResponse.structuredContent.error).toBe(
		'Registry unavailable',
	)
})

test('ranked search prepends ## Waiting for block items, skips domain browse, and drops waiting past its budget', async () => {
	consoleWarn.mockImplementation(() => {})
	mockModule.deriveWaitingItemsForStableUser.mockResolvedValue([
		{
			id: 'integration-auth:google',
			kind: 'integration-auth',
			title: 'Google · kent@gmail.com stopped working',
			why: 'The provider rejected the saved sign-in.',
			who: 'you',
			doLabel: 'Reconnect',
			href: '/connect/oauth?provider=google',
			severity: 'block',
		},
		{
			id: 'onboarding:connect-agent',
			kind: 'onboarding',
			title: 'Connect an agent',
			why: 'Setup is still unfinished.',
			who: 'you',
			doLabel: 'Continue setup',
			href: '/onboarding',
			severity: 'setup',
		},
	])
	const handler = await getSearchHandler()

	const ranked = await handler({
		query: 'google mail',
		conversationId: 'conv-waiting-ranked',
	})
	expect(textOf(ranked)).toContain('## Waiting')
	expect(textOf(ranked)).not.toContain('Connect an agent')
	expect(resultOf(ranked).waiting).toMatchObject({
		count: 1,
		items: [{ id: 'integration-auth:google' }],
	})
	expect(mockModule.deriveWaitingItemsForStableUser).toHaveBeenCalled()

	mockModule.deriveWaitingItemsForStableUser.mockClear()
	const domainBrowse = await handler({
		domain: 'account',
		conversationId: 'conv-waiting-domain',
	})
	expect(textOf(domainBrowse)).not.toContain('## Waiting')
	expect(mockModule.deriveWaitingItemsForStableUser).not.toHaveBeenCalled()

	mockModule.deriveWaitingItemsForStableUser.mockImplementationOnce(
		() => new Promise(() => {}),
	)
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	try {
		const pending = handler({
			query: 'search docs',
			conversationId: 'conv-waiting-budget',
		})
		await vi.advanceTimersByTimeAsync(SEARCH_WAITING_ITEMS_BUDGET_MS)
		const response = await pending
		expect(response.isError).toBeUndefined()
		expect(textOf(response)).not.toContain('## Waiting')
		const result = resultOf(response)
		expect(result.waiting).toBeUndefined()
		expect(result.matches.length).toBeGreaterThan(0)
		expect(result.phaseTimings?.waitingItemsTimedOut).toBe(true)
	} finally {
		vi.useRealTimers()
	}
})

test('ranked search returns results without waiting the full onboarding notice when it outlives its budget', async () => {
	vi.clearAllMocks()
	consoleWarn.mockImplementation(() => {})
	mockModule.buildOnboardingSearchNotice.mockImplementationOnce(
		() => new Promise(() => {}),
	)
	const handler = await getSearchHandler()
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	try {
		const pending = handler({
			query: 'search docs',
			conversationId: 'conv-onboarding-budget',
		})
		await vi.advanceTimersByTimeAsync(SEARCH_ONBOARDING_NOTICE_BUDGET_MS)
		const response = await pending
		expect(response.isError).toBeUndefined()
		const result = resultOf(response)
		expect(result.matches.length).toBeGreaterThan(0)
		expect(result.warnings ?? []).not.toContainEqual(
			expect.stringMatching(/onboarding/i),
		)
		expect(result.phaseTimings?.onboardingNoticeTimedOut).toBe(true)
		expect(result.phaseTimings?.onboardingNoticeMs).toBeLessThanOrEqual(
			SEARCH_ONBOARDING_NOTICE_BUDGET_MS + 50,
		)
	} finally {
		vi.useRealTimers()
	}
})

test('search fails fast with a clear deadline error instead of hanging until the MCP client times out', async () => {
	consoleWarn.mockImplementation(() => {})
	mockModule.getCapabilityRegistryForContext.mockImplementationOnce(
		() => new Promise(() => {}),
	)
	const handler = await getSearchHandler()
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	try {
		const pending = handler({
			query: 'search docs',
			conversationId: 'conv-search-deadline',
		})
		await vi.advanceTimersByTimeAsync(SEARCH_DEADLINE_MS)
		const response = await pending
		expect(response.isError).toBe(true)
		expect(response.structuredContent.error).toContain(
			`Search did not finish within ${String(SEARCH_DEADLINE_MS / 1000)}s`,
		)
		expect(textOf(response)).toContain(
			`Search did not finish within ${String(SEARCH_DEADLINE_MS / 1000)}s`,
		)
	} finally {
		vi.useRealTimers()
	}
})

test('search tool excludes hidden packages by default and includes them with includeHiddenPackages', async () => {
	consoleWarn.mockImplementation(() => {})
	mockModule.listSavedPackagesByUserId.mockImplementation(async () =>
		createSavedPackages(),
	)
	const handler = await getSearchHandler()

	const defaultResponse = await handler({
		query: 'notes package',
		conversationId: 'conv-hidden-default',
	})
	expect(defaultResponse.isError).toBeUndefined()
	expect(packageIdsOf(defaultResponse)).toContain('visible-notes-pkg')
	expect(packageIdsOf(defaultResponse)).not.toContain('hidden-notes-pkg')
	expect(mockModule.runPackageRetrievers).toHaveBeenCalledWith(
		expect.objectContaining({ scope: 'search', includeHiddenPackages: false }),
	)

	const includeResponse = await handler({
		query: 'notes package',
		conversationId: 'conv-hidden-include',
		includeHiddenPackages: true,
	})
	expect(includeResponse.isError).toBeUndefined()
	expect(packageIdsOf(includeResponse).sort()).toEqual([
		'hidden-notes-pkg',
		'visible-notes-pkg',
	])
	expect(mockModule.runPackageRetrievers).toHaveBeenCalledWith(
		expect.objectContaining({ scope: 'search', includeHiddenPackages: true }),
	)
})

test('search tool treats exact package identity as authoritative and still resolves hidden entity lookups', async () => {
	const exactPackageId = '550e8400-e29b-41d4-a716-446655440000'
	mockModule.getSavedPackageById.mockResolvedValue(
		savedPackage(exactPackageId, {
			name: '@user/exact-notes',
			kodyId: 'exact-notes',
			tags: ['notes'],
			hidden: true,
		}),
	)
	const manifest = {
		name: '@user/exact-notes',
		exports: { '.': './index.ts' },
		kody: { id: 'exact-notes', description: 'Exact notes package' },
	}
	mockModule.loadPackageSourceBySourceId.mockResolvedValueOnce({
		manifest,
		files: {
			'package.json': JSON.stringify(manifest),
			'index.ts': 'export default function main() {}',
		},
	})
	const handler = await getSearchHandler()

	const hiddenResponse = await handler({
		query: exactPackageId,
		conversationId: 'conv-exact-hidden',
	})
	expect(hiddenResponse.isError).toBeUndefined()
	expect(resultOf(hiddenResponse)).toMatchObject({ matches: [] })

	const includedResponse = await handler({
		query: `https://example.com/account/packages/${exactPackageId}`,
		conversationId: 'conv-exact-included',
		includeHiddenPackages: true,
	})
	expect(includedResponse.isError).toBeUndefined()
	expect(resultOf(includedResponse).matches).toEqual([
		expect.objectContaining({
			type: 'package',
			packageId: exactPackageId,
			kodyId: 'exact-notes',
			hidden: true,
		}),
	])
	expect(mockModule.runPackageRetrievers).not.toHaveBeenCalled()
	expect(mockModule.getCapabilityRegistryForContext).not.toHaveBeenCalled()

	const entityResponse = await handler({
		entity: `package:${exactPackageId}`,
		conversationId: 'conv-uuid-entity',
	})
	expect(entityResponse.isError).toBeUndefined()
	expect(entityResponse.structuredContent.result).toMatchObject({
		kind: 'entity',
		type: 'package',
		packageId: exactPackageId,
		kodyId: 'exact-notes',
		hidden: true,
	})
	expect(mockModule.getSavedPackageById).toHaveBeenCalledWith(
		{},
		{ userId: ownerIdFromStored('user-1'), packageId: exactPackageId },
	)
	expect(mockModule.resolveSavedPackageRef).not.toHaveBeenCalled()
})

test('search tool batches entity detail with per-ref isolation and preserves single-entity shape', async () => {
	const widgetSpec = (tool: string, field: string) =>
		capabilitySpec(`mcp:widgets:${tool}widget`, {
			domain: 'mcp:widgets',
			inputFields: [field],
			requiredInputFields: [field],
			source: 'mcp-server',
			mcpServer: {
				serverId: 'widgets',
				serverName: 'widgets',
				kodyName: 'widgets',
				mcpToolName: `${tool}_widget`,
				toolName: `${tool}widget`,
			},
		})
	mockModule.getCapabilityRegistryForContext.mockResolvedValue({
		capabilitySpecs: {
			search_docs: capabilitySpec('search_docs'),
			'mcp:widgets:createwidget': widgetSpec('create', 'name'),
			'mcp:widgets:getwidget': widgetSpec('get', 'id'),
		},
	} as never)
	const handler = await getSearchHandler(null)

	const singleResponse = await handler({
		entity: 'capability:search_docs',
		conversationId: 'conv-single-entity',
	})
	expect(singleResponse.isError).toBeUndefined()
	expect(singleResponse.structuredContent.result).toMatchObject({
		kind: 'entity',
		type: 'capability',
		id: 'search_docs',
		entityRef: 'capability:search_docs',
	})
	expect(singleResponse.structuredContent.result).not.toHaveProperty(
		'relatedOperations',
	)
	expect(Array.isArray(singleResponse.structuredContent.result)).toBe(false)

	const batchSuccess = await handler({
		entity: [
			'capability:mcp:widgets:createwidget',
			'capability:mcp:widgets:getwidget',
		],
		conversationId: 'conv-batch-success',
	})
	expect(batchSuccess.isError).toBeUndefined()
	expect(batchSuccess.structuredContent.result).toEqual(
		['mcp:widgets:createwidget', 'mcp:widgets:getwidget'].map((id) =>
			expect.objectContaining({
				kind: 'entity',
				type: 'capability',
				id,
				relatedOperationCount: 1,
			}),
		),
	)

	const partialFailure = await handler({
		entity: ['capability:mcp:widgets:createwidget', 'capability:missing_thing'],
		conversationId: 'conv-batch-partial',
	})
	expect(partialFailure.isError).toBeUndefined()
	expect(partialFailure.structuredContent.result).toEqual([
		expect.objectContaining({
			kind: 'entity',
			type: 'capability',
			id: 'mcp:widgets:createwidget',
		}),
		expect.objectContaining({
			entityRef: 'capability:missing_thing',
			error: expect.stringMatching(/not found/i),
		}),
	])

	const observability = await import('#mcp/observability.ts')
	const logMcpEventSpy = vi.spyOn(observability, 'logMcpEvent')
	const allFailed = await handler({
		entity: ['capability:missing_a', 'capability:missing_b'],
		conversationId: 'conv-batch-all-failed',
	})
	expect(allFailed.isError).toBe(true)
	expect(allFailed.structuredContent.error).toMatch(
		/all entity lookups failed/i,
	)
	expect(allFailed.structuredContent.result).toEqual(
		['capability:missing_a', 'capability:missing_b'].map((entityRef) =>
			expect.objectContaining({ entityRef, error: expect.any(String) }),
		),
	)
	expect(logMcpEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			outcome: 'failure',
			callerError: true,
			errorName: 'EntityBatchError',
		}),
	)

	logMcpEventSpy.mockClear()
	const malformedBatch = await handler({
		entity: ['not-a-ref', 'thing:widget'],
		conversationId: 'conv-batch-malformed',
	})
	expect(malformedBatch.isError).toBe(true)
	expect(logMcpEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			outcome: 'failure',
			callerError: true,
			errorName: 'EntityBatchError',
			context: expect.objectContaining({
				entityFailures: ['not-a-ref', 'thing:widget'].map((entityRef) =>
					expect.objectContaining({ entityRef, callerError: true }),
				),
			}),
		}),
	)

	logMcpEventSpy.mockClear()
	mockModule.getSavedPackageById.mockImplementation(
		async (_db: unknown, input: { packageId: string }) =>
			savedPackage(input.packageId, { isPrivate: true }),
	)
	mockModule.loadPackageSourceBySourceId.mockRejectedValue(
		new Error('D1 read failed'),
	)
	const platformFail = await (
		await getSearchHandler()
	)({
		entity: ['package:pkg-a', 'package:pkg-b'],
		conversationId: 'conv-batch-platform-fail',
	})
	expect(platformFail.isError).toBe(true)
	const platformFailureCall = logMcpEventSpy.mock.calls.find(
		(call) =>
			(call[0] as { errorName?: string }).errorName === 'EntityBatchError',
	)
	expect(platformFailureCall?.[0]).toMatchObject({
		outcome: 'failure',
		errorName: 'EntityBatchError',
		cause: expect.objectContaining({
			message: 'All entity lookups failed.',
			cause: expect.any(AggregateError),
		}),
		context: expect.objectContaining({
			entityFailures: expect.arrayContaining([
				expect.objectContaining({
					callerError: false,
					error: expect.stringMatching(/D1 read failed/i),
				}),
			]),
		}),
	})
	expect(platformFailureCall?.[0]).not.toHaveProperty('callerError', true)
	logMcpEventSpy.mockRestore()
})

test('integration entity detail enriches related packages without bloating ranked search', async () => {
	const now = '2026-01-01T00:00:00.000Z'
	const githubJoinedIntegration = {
		lane: 'user' as const,
		app: {
			userId: ownerIdFromStored('user-1'),
			slug: 'github',
			provider: 'github',
			label: null,
			clientId: 'github-client-id-value',
			hasClientSecret: true,
			tokenUrl: 'https://github.com/login/oauth/access_token',
			authorizeUrl: 'https://github.com/login/oauth/authorize',
			apiBaseUrl: 'https://api.github.com',
			flow: 'confidential' as const,
			usePkce: null,
			tokenExchangeStyle: null,
			scopeSeparator: null,
			extraAuthorizeParams: {},
			createdAt: now,
			updatedAt: now,
		},
		connection: {
			userId: ownerIdFromStored('user-1'),
			name: 'github',
			appSlug: 'github',
			platformAppSlug: null,
			accountLabel: null,
			description: 'GitHub OAuth integration',
			scopes: [],
			requiredHosts: ['api.github.com', 'github.com'],
			usageMode: 'any',
			allowedPackageIds: [],
			connectedAt: null,
			tokenRefreshedAt: null,
			createdAt: now,
			updatedAt: now,
		},
	}
	mockModule.listJoinedIntegrations.mockResolvedValue([
		githubJoinedIntegration,
	] as never)
	mockModule.getJoinedIntegration.mockResolvedValue(
		githubJoinedIntegration as never,
	)
	mockModule.searchCommunityListings.mockResolvedValue([
		{
			id: 'listing-github',
			ownerUserId: ownerIdFromStored('owner-1'),
			packageId: 'pkg-github',
			sourceId: 'source-github',
			kodyId: 'github',
			name: '@kody/github',
			description: 'GitHub helpers',
			tags: ['github', 'api'],
			category: 'integrations',
			searchText: null,
			readmeContent: null,
			license: 'MIT',
			pinnedCommit: 'abc123',
			iconCommit: 'abc123',
			status: 'active',
			trustedCommit: 'abc123',
			trustedAt: now,
			trusted: true,
			featuredAt: null,
			featured: false,
			createdAt: now,
			updatedAt: now,
			publishedAt: now,
			averageStars: null,
			ratingCount: 0,
			averageAdaptationEffort: null,
			forkCount: 0,
		},
	] as never)
	const handler = await getSearchHandler()

	const ranked = await handler({
		query: 'github integration',
		conversationId: 'conv-integration-ranked',
	})
	expect(ranked.isError).toBeUndefined()
	expect(mockModule.searchCommunityListings).not.toHaveBeenCalled()
	const rankedIntegration = resultOf(ranked).matches.find(
		(match) => match.type === 'integration',
	)
	expect(rankedIntegration).toMatchObject({
		type: 'integration',
		entityRef: 'integration:github',
	})
	expect(rankedIntegration).not.toHaveProperty('relatedPackageSuggestions')

	const detail = await handler({
		entity: 'integration:github',
		conversationId: 'conv-integration-detail',
	})
	expect(detail.isError).toBeUndefined()
	expect(mockModule.searchCommunityListings).toHaveBeenCalledTimes(1)
	expect(mockModule.searchCommunityListings).toHaveBeenCalledWith({
		env: { APP_DB: {} },
		query: 'github',
		limit: 12,
		resultFilter: expect.any(Function),
	})
	expect(detail.structuredContent.result).toMatchObject({
		kind: 'entity',
		type: 'integration',
		id: 'github',
		relatedPackageSuggestions: [
			expect.objectContaining({
				source: 'community',
				kodyId: 'github',
				listingId: 'listing-github',
				trusted: true,
			}),
		],
	})

	// A same-provider user package wins over community listings.
	mockModule.searchCommunityListings.mockClear()
	mockModule.listSavedPackagesByUserId.mockResolvedValue([
		savedPackage('pkg-user-github', {
			name: '@user/github',
			kodyId: 'github',
			tags: ['github'],
		}),
	] as never)
	const userPackageDetail = await handler({
		entity: 'integration:github',
		conversationId: 'conv-integration-user-pkg',
	})
	expect(mockModule.searchCommunityListings).not.toHaveBeenCalled()
	expect(userPackageDetail.structuredContent.result).toMatchObject({
		type: 'integration',
		relatedPackageSuggestions: [
			expect.objectContaining({
				source: 'user',
				kodyId: 'github',
				entityRef: 'package:github',
			}),
		],
	})
})

test('search tool memory enrichment: structured context, timeout, and rejection stay off the critical path', async () => {
	consoleWarn.mockImplementation(() => {})
	const summary = memorySummary('memory-1', 'Prefers compact search results')

	mockModule.loadRelevantMemoriesForTool.mockResolvedValueOnce(summary)
	const handler = await getSearchHandler()
	const structuredContextResult = await handler({
		query: 'search docs',
		conversationId: 'conv-structured-memory',
		memoryContext: { task: 'search docs' },
	})
	expect(mockModule.loadRelevantMemoriesForTool).toHaveBeenCalledWith(
		expect.objectContaining({
			memoryContext: { task: 'search docs' },
			acknowledgeSurfaced: false,
		}),
	)
	expect(resultOf(structuredContextResult).memories?.surfaced).toEqual([
		expect.objectContaining({ id: 'memory-1' }),
	])

	mockModule.loadRelevantMemoriesForTool.mockClear()
	mockModule.loadRelevantMemoriesForTool.mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				setTimeout(
					() => resolve(summary),
					SEARCH_MEMORY_ENRICHMENT_BUDGET_MS + 250,
				)
			}),
	)
	const timedOutResult = resultOf(
		await handler({
			query: 'search docs',
			conversationId: 'conv-memory-budget',
		}),
	)
	expect(timedOutResult.matches.length).toBeGreaterThan(0)
	expect(timedOutResult.memories).toBeUndefined()
	expect(timedOutResult.warnings).toContain(memoryEnrichmentSkippedWarning)
	expect(timedOutResult.phaseTimings).toEqual(
		expect.objectContaining({
			memoryEnrichmentTimedOut: true,
			memoryEnrichmentFailed: false,
			memoryEnrichmentMs: expect.any(Number),
			memoryEnrichmentWaitMs: expect.any(Number),
		}),
	)
	expect(mockModule.loadRelevantMemoriesForTool).toHaveBeenCalledWith(
		expect.objectContaining({ acknowledgeSurfaced: false }),
	)

	const unhandled: Array<unknown> = []
	const onUnhandled = (reason: unknown) => {
		unhandled.push(reason)
	}
	process.on('unhandledRejection', onUnhandled)
	try {
		mockModule.loadRelevantMemoriesForTool.mockRejectedValueOnce(
			new Error('memory store unavailable'),
		)
		const rejectedResult = resultOf(
			await handler({
				query: 'search docs',
				conversationId: 'conv-memory-reject',
			}),
		)
		expect(rejectedResult.memories).toBeUndefined()
		expect(rejectedResult.warnings).toContain(memoryEnrichmentSkippedWarning)
		expect(rejectedResult.phaseTimings).toEqual(
			expect.objectContaining({
				memoryEnrichmentFailed: true,
				memoryEnrichmentTimedOut: false,
			}),
		)
		await Promise.resolve()
		await Promise.resolve()
		expect(unhandled).toEqual([])
	} finally {
		process.off('unhandledRejection', onUnhandled)
	}
}, 10_000)

test('search reserves maxResponseSize for memories and still enriches from memoryContext', async () => {
	consoleWarn.mockImplementation(() => {})
	const longSummary =
		'Never send email unless that exact message is requested. '
			.repeat(40)
			.trim()
	mockModule.loadRelevantMemoriesForTool.mockResolvedValue(
		memorySummary('memory-draft-only', longSummary, {
			details: 'Long details must stay out of the reserved memory block.',
		}) as never,
	)
	const handler = await getSearchHandler()

	const tightResponse = await handler({
		query: 'search docs',
		conversationId: 'conv-memory-budget-reserve',
		maxResponseSize: 2_000,
	})
	expect(tightResponse.isError).toBeUndefined()
	expect(
		tightResponse.content.find((item) =>
			item.text.includes('## Relevant memories'),
		)?.text,
	).toContain(longSummary)
	const tightResult = resultOf(tightResponse)
	expect(tightResult.memories?.surfaced).toEqual([
		expect.objectContaining({ id: 'memory-draft-only', summary: longSummary }),
	])
	expect(tightResult.telemetry?.responseTrimmed).toBe(true)
	expect(tightResult.telemetry?.trimmedMatchCount).toBeGreaterThan(0)
	expect(tightResult.matches).toEqual([])
	expect(tightResult.guidance).toBeUndefined()
	expect(textOf(tightResponse)).not.toContain('## Recommended next step')
	expect(textOf(tightResponse)).not.toMatch(/inlined export call contract/i)

	mockModule.loadRelevantMemoriesForTool.mockClear()
	mockModule.getCapabilityRegistryForContext.mockResolvedValueOnce({
		capabilityDomains: [
			{ name: 'meta', description: 'Search and registry metadata.' },
		],
		capabilitySpecs: { search_docs: capabilitySpec('search_docs') },
	} as never)
	const whitespaceResponse = await handler({
		query: '   ',
		conversationId: 'conv-whitespace-memory-context',
		memoryContext: { task: 'draft an email' },
	})
	expect(whitespaceResponse.isError).toBeUndefined()
	expect(mockModule.loadRelevantMemoriesForTool).toHaveBeenCalledWith(
		expect.objectContaining({
			memoryContext: { task: 'draft an email' },
			acknowledgeSurfaced: false,
		}),
	)
	expect(textOf(whitespaceResponse)).toContain('## Relevant memories')
	expect(textOf(whitespaceResponse)).toContain(longSummary)
	expect(resultOf(whitespaceResponse).memories?.surfaced).toEqual([
		expect.objectContaining({ id: 'memory-draft-only' }),
	])
})

test('search tool domain param: browse, reject unknown, scope ranked results, and index empty discovery', async () => {
	consoleWarn.mockImplementation(() => {})
	const anonymous = await getSearchHandler(null)

	// Whitespace-only queries fall back to domain browsing (with its limit).
	const browseResponse = await anonymous({
		query: '   ',
		domain: 'meta',
		conversationId: 'conv-domain-browse',
	})
	expect(browseResponse.isError).toBeUndefined()
	expect(resultOf(browseResponse).matches).toEqual([
		expect.objectContaining({
			type: 'capability',
			id: 'search_docs',
			domain: 'meta',
		}),
	])
	expect(mockModule.runPackageRetrievers).not.toHaveBeenCalled()

	const unknownResponse = await anonymous({
		domain: 'nope',
		conversationId: 'conv-domain-unknown',
	})
	expect(unknownResponse.isError).toBe(true)
	expect(unknownResponse.structuredContent.error).toMatch(
		/Unknown domain "nope"/,
	)
	expect(unknownResponse.structuredContent.error).toContain('meta')
	expect(mockModule.loadRelevantMemoriesForTool).not.toHaveBeenCalled()

	mockModule.getCapabilityRegistryForContext.mockResolvedValueOnce({
		capabilityDomains: [
			{ name: 'meta', description: 'Search and registry metadata.' },
		],
		capabilitySpecs: { search_docs: capabilitySpec('search_docs') },
	} as never)
	const emptyIndex = await anonymous({ conversationId: 'conv-empty-index' })
	expect(emptyIndex.isError).toBeUndefined()
	expect(emptyIndex.structuredContent.result).toMatchObject({
		matches: [
			{
				type: 'domain',
				id: 'meta',
				capabilityCount: 1,
				sampleCapabilities: ['search_docs'],
			},
		],
	})
	expect(mockModule.loadRelevantMemoriesForTool).not.toHaveBeenCalled()
	expect(mockModule.runPackageRetrievers).not.toHaveBeenCalled()

	mockModule.listSavedPackagesByUserId.mockResolvedValue(
		createSavedPackages() as never,
	)
	const scopedResponse = await (
		await getSearchHandler()
	)({
		query: 'search docs',
		domain: 'meta',
		conversationId: 'conv-domain-scoped',
	})
	expect(scopedResponse.isError).toBeUndefined()
	const scopedMatches = resultOf(scopedResponse).matches
	expect(scopedMatches.length).toBeGreaterThan(0)
	for (const match of scopedMatches) {
		expect(match).toMatchObject({ type: 'capability', domain: 'meta' })
	}
	expect(mockModule.loadRelevantMemoriesForTool).toHaveBeenCalled()
	expect(mockModule.runPackageRetrievers).not.toHaveBeenCalled()
})
