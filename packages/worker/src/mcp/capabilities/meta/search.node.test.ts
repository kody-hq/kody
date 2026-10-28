import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as accessControl from '#mcp/capabilities/access-control.ts'
import type * as capabilityRegistry from '#mcp/capabilities/registry.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import type * as secretsService from '#mcp/secrets/service.ts'
import type * as memoryToolContext from '#mcp/tools/memory-tool-context.ts'
import type * as entitlementsService from '#worker/entitlements/service.ts'
import type * as integrationsService from '#worker/integrations/service.ts'
import type * as packageRepo from '#worker/package-registry/repo.ts'
import type * as searchRateLimit from '#worker/search-rate-limit.ts'
import { type CapabilityContext } from '../types.ts'

const mockModule = vi.hoisted(() => ({
	getCapabilityRegistryForContext: vi.fn(
		async (
			..._args: Parameters<
				typeof capabilityRegistry.getCapabilityRegistryForContext
			>
		) => ({
			capabilityDomains: [
				{
					name: 'meta',
					description: 'Search and registry metadata.',
				},
			],
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
		typeof packageRepo.listSavedPackagesByUserId
	>(async () => []),
	listUserSecretsForSearch: vi.fn<
		typeof secretsService.listUserSecretsForSearch
	>(async () => []),
	listJoinedIntegrations: vi.fn<
		typeof integrationsService.listJoinedIntegrations
	>(async () => []),
	loadRelevantMemoriesForTool: vi.fn<
		typeof memoryToolContext.loadRelevantMemoriesForTool
	>(async () => null),
	acknowledgeToolMemories: vi.fn<
		typeof memoryToolContext.acknowledgeToolMemories
	>(async () => undefined),
	buildMemoryRetrievalQuery: vi.fn<
		typeof memoryToolContext.buildMemoryRetrievalQuery
	>((input) =>
		[
			input?.task,
			input?.query,
			...(input?.entities ?? []),
			...(input?.constraints ?? []),
		]
			.filter(Boolean)
			.join('\n'),
	),
}))

vi.mock('#mcp/capabilities/registry.ts', () => ({
	getCapabilityRegistryForContext: (
		...args: Parameters<
			typeof capabilityRegistry.getCapabilityRegistryForContext
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
	resolveSavedPackageRefWithCommunityProvenance: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackageRef(...args),
	listSavedPackagesByUserId: (
		...args: Parameters<typeof packageRepo.listSavedPackagesByUserId>
	) => mockModule.listSavedPackagesByUserId(...args),
	listSavedPackagesWithCommunityProvenanceByUserId: (
		...args: Parameters<typeof packageRepo.listSavedPackagesByUserId>
	) => mockModule.listSavedPackagesByUserId(...args),
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	listUserSecretsForSearch: (
		...args: Parameters<typeof secretsService.listUserSecretsForSearch>
	) => mockModule.listUserSecretsForSearch(...args),
}))

vi.mock('#worker/integrations/service.ts', () => ({
	listJoinedIntegrations: (
		...args: Parameters<typeof integrationsService.listJoinedIntegrations>
	) => mockModule.listJoinedIntegrations(...args),
}))

vi.mock('#mcp/tools/memory-tool-context.ts', () => ({
	loadRelevantMemoriesForTool: (
		...args: Parameters<typeof memoryToolContext.loadRelevantMemoriesForTool>
	) => mockModule.loadRelevantMemoriesForTool(...args),
	acknowledgeToolMemories: (
		...args: Parameters<typeof memoryToolContext.acknowledgeToolMemories>
	) => mockModule.acknowledgeToolMemories(...args),
	buildMemoryRetrievalQuery: (
		...args: Parameters<typeof memoryToolContext.buildMemoryRetrievalQuery>
	) => mockModule.buildMemoryRetrievalQuery(...args),
}))

const mockFeatureFlags = vi.hoisted(() => ({
	override: null as Record<string, boolean> | null,
}))

const mockUserPlan = vi.hoisted(() => ({
	plan: 'free' as 'free' | 'standard' | 'pro' | 'max',
}))

vi.mock('#mcp/capabilities/access-control.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof accessControl>()
	return {
		...actual,
		resolveCallerFeatureFlags: async (
			...args: Parameters<typeof actual.resolveCallerFeatureFlags>
		) => {
			if (mockFeatureFlags.override) return mockFeatureFlags.override
			return actual.resolveCallerFeatureFlags(...args)
		},
		resolveCallerFeatureFlagEvaluations: async (
			...args: Parameters<typeof actual.resolveCallerFeatureFlagEvaluations>
		) => {
			if (mockFeatureFlags.override) {
				return Object.fromEntries(
					Object.entries(mockFeatureFlags.override).map(([key, enabled]) => [
						key,
						{ enabled, source: 'global' as const },
					]),
				) as Awaited<
					ReturnType<typeof actual.resolveCallerFeatureFlagEvaluations>
				>
			}
			return actual.resolveCallerFeatureFlagEvaluations(...args)
		},
	}
})

vi.mock('#worker/entitlements/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof entitlementsService>()
	return {
		...actual,
		getUserPlan: async () => mockUserPlan.plan,
	}
})

vi.mock('#worker/search-rate-limit.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof searchRateLimit>()
	return {
		...actual,
		consumeSearchRateLimit: vi.fn(async () => mockUserPlan.plan),
	}
})

const { searchCapability } = await import('./search.ts')

const packageId = '550e8400-e29b-41d4-a716-446655440000'

function createContext(
	user: { userId: string; username: string } | null,
): CapabilityContext {
	return {
		env: {
			APP_DB: {},
			WRANGLER_IS_LOCAL_DEV: 'true',
		} as unknown as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://heykody.dev',
			user: user
				? {
						...user,
						userId: personIdFromStored(user.userId),
						email: 'user@example.com',
						displayName: 'User',
					}
				: null,
		}),
	}
}

function createSavedPackage(hidden = false) {
	return {
		id: packageId,
		userId: ownerIdFromStored('user-1'),
		name: '@user/daily-notes',
		kodyId: 'daily-notes',
		description: 'Daily notes package',
		tags: ['notes'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-02T00:00:00.000Z',
	}
}

test('meta search wires exact package identity, hidden gating, and natural-language discovery', async () => {
	mockModule.getSavedPackageById
		.mockResolvedValueOnce(createSavedPackage())
		.mockResolvedValueOnce(createSavedPackage(true))
		.mockResolvedValueOnce(createSavedPackage(true))
	mockModule.resolveSavedPackageRef.mockResolvedValueOnce(createSavedPackage())
	const context = createContext({
		userId: ownerIdFromStored('user-1'),
		username: 'user',
	})

	const byAccountUrl = await searchCapability.handler(
		{
			query: `https://heykody.dev/account/packages/${packageId}`,
			conversationId: 'meta-account-url',
		},
		context,
	)
	expect(byAccountUrl.matches).toMatchObject([
		{ type: 'package', packageId, hidden: false },
	])

	const byHostedUrl = await searchCapability.handler(
		{
			query: '/@user/packages/daily-notes',
			conversationId: 'meta-hosted-url',
		},
		context,
	)
	expect(byHostedUrl.matches).toMatchObject([
		{ type: 'package', packageId, kodyId: 'daily-notes' },
	])

	const hidden = await searchCapability.handler(
		{ query: packageId, conversationId: 'meta-hidden' },
		context,
	)
	expect(hidden.matches).toEqual([])
	expect(hidden.telemetry?.jevRerank).toBeUndefined()
	expect(hidden.phaseTimings?.jevRerankMs).toBeUndefined()
	const included = await searchCapability.handler(
		{
			query: packageId,
			includeHiddenPackages: true,
			conversationId: 'meta-hidden-included',
		},
		context,
	)
	expect(included.matches).toMatchObject([
		{ type: 'package', packageId, hidden: true },
	])

	const naturalLanguage = await searchCapability.handler(
		{ query: 'search docs', conversationId: 'meta-natural-language' },
		context,
	)
	expect(naturalLanguage.matches).toMatchObject([
		{ type: 'capability', entityRef: 'capability:search_docs' },
		{ type: 'guide', entityRef: 'guide:search_and_execute' },
	])
	expect(naturalLanguage.telemetry?.jevRerank).toMatchObject({
		enabled: true,
		outcome: 'skipped-plan',
	})
	expect(naturalLanguage.phaseTimings?.jevRerankMs).toEqual(expect.any(Number))

	await expect(
		searchCapability.handler(
			{ query: packageId, conversationId: 'meta-unauthenticated' },
			createContext(null),
		),
	).rejects.toThrow(/Authenticated MCP user is required/)

	expect(mockModule.getSavedPackageById).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			packageId,
		}),
	)
	expect(mockModule.resolveSavedPackageRef).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			userId: ownerIdFromStored('user-1'),
			ref: 'daily-notes',
			match: 'slug',
		}),
	)
	expect(mockModule.getCapabilityRegistryForContext).toHaveBeenCalledTimes(1)

	mockUserPlan.plan = 'standard'
	try {
		const jevEnabled = await searchCapability.handler(
			{ query: 'search docs', conversationId: 'meta-jev-timing' },
			context,
		)
		const jevEntry = jevEnabled.serverTiming?.find(
			(entry) => entry.name === 'jevRerank',
		)
		expect(jevEntry).toEqual({
			name: 'jevRerank',
			durationMs: expect.any(Number),
		})
		expect(jevEnabled.telemetry?.jevRerank?.enabled).toBe(true)
		expect([
			'skipped-offline',
			'skipped-small-pool',
			'skipped-no-ai',
			'applied',
			'fallback-error',
		]).toContain(jevEnabled.telemetry?.jevRerank?.outcome)
		expect(jevEntry?.durationMs).toBe(jevEnabled.phaseTimings?.jevRerankMs)
		const timingNames = jevEnabled.serverTiming?.map((entry) => entry.name)
		expect(timingNames).toEqual(
			expect.arrayContaining([
				'rateLimit',
				'usernameLookup',
				'identityResolution',
				'rowAndRegistryLoad',
				'loadAndRank',
				'unaccounted',
			]),
		)
	} finally {
		mockUserPlan.plan = 'free'
	}
})

test('meta search supports domain browsing and empty discovery', async () => {
	const context = createContext({
		userId: ownerIdFromStored('user-1'),
		username: 'user',
	})

	const browse = await searchCapability.handler(
		{ domain: 'meta', conversationId: 'meta-domain-browse' },
		context,
	)
	expect(browse.matches).toEqual([
		expect.objectContaining({
			type: 'capability',
			entityRef: 'capability:search_docs',
			domain: 'meta',
		}),
	])

	const memoryCallsBeforeEmpty =
		mockModule.loadRelevantMemoriesForTool.mock.calls.length
	const empty = await searchCapability.handler(
		{ conversationId: 'meta-empty-index' },
		context,
	)
	expect(empty.matches).toEqual([
		expect.objectContaining({
			type: 'domain',
			id: 'meta',
			capabilityCount: 1,
		}),
	])
	expect(mockModule.loadRelevantMemoriesForTool).toHaveBeenCalledTimes(
		memoryCallsBeforeEmpty,
	)
})
