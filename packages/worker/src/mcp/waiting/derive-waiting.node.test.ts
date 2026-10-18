import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import type * as memoryRepo from '#mcp/memory/repo.ts'
import { type McpMemoryRow } from '#mcp/memory/types.ts'
import type * as secretsService from '#mcp/secrets/service.ts'
import { type ListedSecret } from '#mcp/secrets/types.ts'
import type * as guildMembership from '#worker/discord/guild-membership.ts'
import { persistIntegrationTokens } from '#worker/integrations/credentials.ts'
import { inferIntegrationRefreshPolicy } from '#worker/integrations/refresh-policy.ts'
import { writeIntegrationAuthFailure } from '#worker/integrations/repo.ts'
import type * as integrationsService from '#worker/integrations/service.ts'
import { type JoinedIntegration } from '#worker/integrations/types.ts'
import type * as jobsDataModule from '#worker/jobs/jobs-data.ts'
import type * as packageRepo from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import type * as runRecordsService from '#worker/run-records/service.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { accountActivitySummaryWindowMs } from '#universal/account-activity-filters.ts'
import { buildWaitingItems, waitingFirstUseIds } from '#universal/waiting.ts'
import { collectWaitingSignals } from './derive-waiting.ts'

type CountJobsForUser = ReturnType<
	typeof jobsDataModule.jobsData
>['countJobsForUser']

const mockModule = vi.hoisted(() => ({
	summarizeRunRecords: vi.fn<typeof runRecordsService.summarizeRunRecords>(
		async () => ({
			since: new Date(0).toISOString(),
			total: 0,
			errors: 0,
			ignored: 0,
			resolved: 0,
			running: 0,
			bySurface: [],
		}),
	),
	listJoinedIntegrations: vi.fn<
		typeof integrationsService.listJoinedIntegrations
	>(async () => []),
	listSecrets: vi.fn<typeof secretsService.listSecrets>(async () => []),
	listSavedPackagesByUserId: vi.fn<
		typeof packageRepo.listSavedPackagesByUserId
	>(async () => []),
	listMemoriesByUserId: vi.fn<typeof memoryRepo.listMemoriesByUserId>(
		async () => [],
	),
	countJobsForUser: vi.fn<CountJobsForUser>(async () => 0),
	readOfficialDiscordMembershipForUser: vi.fn<
		typeof guildMembership.readOfficialDiscordMembershipForUser
	>(async () => false),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	summarizeRunRecords: (
		...args: Parameters<typeof runRecordsService.summarizeRunRecords>
	) => mockModule.summarizeRunRecords(...args),
}))

vi.mock('#worker/integrations/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof integrationsService>()
	return {
		...actual,
		listJoinedIntegrations: (
			...args: Parameters<typeof integrationsService.listJoinedIntegrations>
		) => mockModule.listJoinedIntegrations(...args),
	}
})

vi.mock('#mcp/secrets/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof secretsService>()
	return {
		...actual,
		listSecrets: (...args: Parameters<typeof secretsService.listSecrets>) =>
			mockModule.listSecrets(...args),
	}
})

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: (
		...args: Parameters<typeof packageRepo.listSavedPackagesByUserId>
	) => mockModule.listSavedPackagesByUserId(...args),
}))

vi.mock('#mcp/memory/repo.ts', () => ({
	listMemoriesByUserId: (
		...args: Parameters<typeof memoryRepo.listMemoriesByUserId>
	) => mockModule.listMemoriesByUserId(...args),
}))

vi.mock('#worker/jobs/jobs-data.ts', () => ({
	jobsData: () => ({
		countJobsForUser: (...args: Parameters<CountJobsForUser>) =>
			mockModule.countJobsForUser(...args),
	}),
}))

vi.mock('#worker/discord/guild-membership.ts', () => ({
	readOfficialDiscordMembershipForUser: (
		...args: Parameters<
			typeof guildMembership.readOfficialDiscordMembershipForUser
		>
	) => mockModule.readOfficialDiscordMembershipForUser(...args),
}))

function createStubDb(
	stamps?: {
		first_search_at?: string | null
		first_execute_at?: string | null
		first_saved_package_at?: string | null
		onboarding_checklist_dismissed_at?: string | null
		saved_package_count?: number
	},
	queries: Array<string> = [],
) {
	return {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
			queries.push(normalized)
			return {
				bind() {
					return {
						async first() {
							if (!stamps) return null
							if (normalized.includes('from saved_packages')) {
								return { count: stamps.saved_package_count ?? 0 }
							}
							if (normalized.includes('from users')) {
								return {
									first_search_at: stamps.first_search_at ?? null,
									first_execute_at: stamps.first_execute_at ?? null,
									first_saved_package_at: stamps.first_saved_package_at ?? null,
									onboarding_checklist_dismissed_at:
										stamps.onboarding_checklist_dismissed_at ?? null,
								}
							}
							return null
						},
						async all() {
							return { results: [] }
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

const user = {
	userId: 11,
	stableUserId: ownerIdFromStored('user-aaa'),
	email: 'waiting@example.com',
	username: 'waiting',
	emailVerified: true,
}

test('waiting signals read MCP OAuth grants from OAUTH_KV when the provider helpers are absent', async () => {
	const { kv } = createMemoryKvNamespace({
		'grant:user-aaa:grant-1': JSON.stringify({
			id: 'grant-1',
			userId: ownerIdFromStored('user-aaa'),
			clientId: 'host-client',
			scope: ['mcp'],
		}),
		'grant:user-bbb:grant-2': JSON.stringify({
			id: 'grant-2',
			userId: ownerIdFromStored('user-bbb'),
			clientId: 'host-client',
			scope: ['mcp'],
		}),
	})
	const connected = await collectWaitingSignals({
		env: { APP_DB: createStubDb(), OAUTH_KV: kv } as Env,
		user,
	})
	expect(connected.onboardingRemaining).not.toContain('connect-agent')

	const disconnected = await collectWaitingSignals({
		env: { APP_DB: createStubDb(), OAUTH_KV: kv } as Env,
		user: { ...user, stableUserId: ownerIdFromStored('user-ccc') },
	})
	expect(disconnected.onboardingRemaining).toContain('connect-agent')

	const noOAuthSurface = await collectWaitingSignals({
		env: { APP_DB: createStubDb() } as Env,
		user,
	})
	expect(noOAuthSurface.onboardingRemaining).toContain('connect-agent')
})

const stampedAt = '2026-09-01T00:00:00.000Z'
const allStamped = {
	first_search_at: stampedAt,
	first_execute_at: stampedAt,
	first_saved_package_at: stampedAt,
	onboarding_checklist_dismissed_at: stampedAt,
}
const fixtureTimestamp = '2026-08-01T00:00:00.000Z'
const demoPackage: SavedPackageRecord = {
	id: 'pkg-1',
	userId: ownerIdFromStored('user-aaa'),
	name: 'demo',
	kodyId: 'demo',
	description: '',
	tags: [],
	searchText: null,
	sourceId: 'source-1',
	hasApp: false,
	hasSkills: false,
	hidden: false,
	isPrivate: false,
	isInternetVisible: false,
	lockedAt: null,
	createdAt: fixtureTimestamp,
	updatedAt: fixtureTimestamp,
}

const commuteMemory: McpMemoryRow = {
	id: 'mem-1',
	user_id: ownerIdFromStored('user-aaa'),
	category: null,
	status: 'active',
	subject: 'Commute',
	summary: '',
	details: '',
	tags_json: '[]',
	source_uris_json: '[]',
	dedupe_key: null,
	created_at: fixtureTimestamp,
	updated_at: fixtureTimestamp,
	last_accessed_at: null,
	deleted_at: null,
}

const githubIntegration: JoinedIntegration = {
	lane: 'user',
	app: {
		userId: ownerIdFromStored('user-aaa'),
		slug: 'github',
		provider: 'github',
		label: null,
		clientId: 'github-client-id',
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
		createdAt: fixtureTimestamp,
		updatedAt: fixtureTimestamp,
	},
	connection: {
		userId: ownerIdFromStored('user-aaa'),
		credentialId: 'cred-integration',
		name: 'github',
		appSlug: 'github',
		platformAppSlug: null,
		accountLabel: null,
		description: '',
		scopes: [],
		requiredHosts: [],
		usageMode: 'any',
		allowedPackageIds: [],
		connectedAt: fixtureTimestamp,
		tokenRefreshedAt: null,
		createdAt: fixtureTimestamp,
		updatedAt: fixtureTimestamp,
		lastAuthFailure: null,
	},
}

const apiKeySecret: ListedSecret = {
	credentialId: 'cred-api-key',
	name: 'apiKey',
	scope: 'user',
	description: '',
	packageId: null,
	allowedHosts: [],
	allowedPackages: [],
	createdAt: fixtureTimestamp,
	updatedAt: fixtureTimestamp,
	expiresAt: null,
	ttlMs: 60,
}

function stubEnv(stamps?: Parameters<typeof createStubDb>[0]) {
	return { APP_DB: createStubDb(stamps) } as Env
}

function mockFirstUseProbesPresent(discordMember: boolean) {
	mockModule.listMemoriesByUserId.mockResolvedValue([commuteMemory])
	mockModule.listSavedPackagesByUserId.mockResolvedValue([demoPackage])
	mockModule.countJobsForUser.mockResolvedValue(1)
	mockModule.listJoinedIntegrations.mockResolvedValue([githubIntegration])
	mockModule.listSecrets.mockResolvedValue([apiKeySecret])
	mockModule.readOfficialDiscordMembershipForUser.mockResolvedValue(
		discordMember,
	)
}

test('waiting error-rate card uses open Activity errors, not monthly rollups', async () => {
	const now = new Date('2026-09-05T00:00:00.000Z')
	const since = new Date(
		now.getTime() - accountActivitySummaryWindowMs,
	).toISOString()
	const env = stubEnv()
	const summary = { since, running: 0, bySurface: [] }

	mockModule.summarizeRunRecords.mockResolvedValueOnce({
		...summary,
		total: 162103,
		errors: 0,
		ignored: 800,
		resolved: 407,
	})
	const triaged = await collectWaitingSignals({ env, user, now })
	expect(mockModule.summarizeRunRecords).toHaveBeenCalledWith({
		env,
		userId: user.stableUserId,
		since,
	})
	expect(triaged.errorRate).toEqual({ errorCount: 0, eventCount: 162103 })
	expect(
		buildWaitingItems(triaged, 'ada').map((item) => item.kind),
	).not.toContain('error-rate')

	mockModule.summarizeRunRecords.mockResolvedValueOnce({
		...summary,
		total: 20,
		errors: 12,
		ignored: 0,
		resolved: 0,
	})
	const open = await collectWaitingSignals({ env, user, now })
	expect(open.errorRate).toEqual({ errorCount: 12, eventCount: 20 })
	expect(
		buildWaitingItems(open, 'ada').find((item) => item.id === 'error-rate'),
	).toEqual(
		expect.objectContaining({
			title: 'Error rate is elevated',
			href: '/@ada/-/activity',
		}),
	)
})

test('waiting first-use signals emit cards only when the probe knows they are missing', async () => {
	const missing = await collectWaitingSignals({
		env: stubEnv({
			first_search_at: null,
			first_execute_at: null,
			first_saved_package_at: null,
			onboarding_checklist_dismissed_at: stampedAt,
		}),
		user,
	})
	expect(missing.firstUseMissing).toEqual([...waitingFirstUseIds])
	expect(buildWaitingItems(missing, 'ada').map((item) => item.id)).toEqual(
		waitingFirstUseIds.map((id) => `first-use:${id}`),
	)
	expect(missing.onboardingDismissed).toBe(true)

	mockFirstUseProbesPresent(true)
	const present = await collectWaitingSignals({
		env: stubEnv(allStamped),
		user,
	})
	expect(present.firstUseMissing).toEqual([])
	expect(
		buildWaitingItems(present, 'ada').filter(
			(item) => item.kind === 'first-use',
		),
	).toEqual([])

	mockModule.listMemoriesByUserId.mockRejectedValueOnce(new Error('d1 blip'))
	mockModule.countJobsForUser.mockRejectedValueOnce(new Error('jobs down'))
	mockModule.listJoinedIntegrations.mockRejectedValueOnce(
		new Error('integrations down'),
	)
	mockModule.listSecrets.mockRejectedValueOnce(new Error('secrets down'))
	mockModule.listSavedPackagesByUserId.mockRejectedValueOnce(
		new Error('packages down'),
	)
	mockModule.readOfficialDiscordMembershipForUser.mockResolvedValueOnce(null)
	const unknown = await collectWaitingSignals({ env: stubEnv(), user })
	expect(unknown.firstUseMissing).toEqual([])

	mockFirstUseProbesPresent(false)
	const discordOpen = await collectWaitingSignals({
		env: stubEnv(allStamped),
		user,
	})
	expect(discordOpen.firstUseMissing).toEqual(['discord'])
	expect(buildWaitingItems(discordOpen, 'ada').map((item) => item.id)).toEqual([
		'first-use:discord',
	])
})

test('waiting onboarding checklist reuses first-use probes and falls back to its own package count when the probe fails', async () => {
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([demoPackage])
	const queries: Array<string> = []
	const signals = await collectWaitingSignals({
		env: {
			APP_DB: createStubDb(
				{
					first_search_at: null,
					first_execute_at: null,
					first_saved_package_at: stampedAt,
				},
				queries,
			),
		} as Env,
		user,
	})

	expect(signals.onboardingRemaining).not.toContain('give-access')
	expect(signals.onboardingRemaining).not.toContain('install-starter')
	expect(mockModule.listMemoriesByUserId).toHaveBeenCalledTimes(1)
	// Only the entitlement-caps snapshot counts saved packages.
	expect(
		queries.filter((query) => query.includes('from saved_packages')),
	).toHaveLength(1)
	expect(
		queries.filter(
			(query) =>
				query.includes('first_search_at') || query.includes('first_execute_at'),
		),
	).toHaveLength(1)

	mockModule.listSavedPackagesByUserId.mockRejectedValueOnce(
		new Error('packages down'),
	)
	const fallback = await collectWaitingSignals({
		env: stubEnv({
			first_search_at: null,
			first_execute_at: null,
			saved_package_count: 2,
		}),
		user,
	})
	expect(fallback.onboardingRemaining).not.toContain('give-access')
	expect(fallback.onboardingRemaining).not.toContain('install-starter')
})

test('waiting shows missing_refresh_token only for connections whose refresh is expected', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		...createInMemoryUserMeterEnv().env,
	} as Env
	const actual = await vi.importActual<typeof integrationsService>(
		'#worker/integrations/service.ts',
	)
	for (const [name, tokenPayload] of [
		['github-bot', { access_token: 'gho_bot' }],
		['github-kent', { access_token: 'gho_kent', scope: 'repo' }],
		['google', { access_token: 'ya29', expires_in: 3599 }],
	] as const) {
		await actual.upsertIntegration({
			env,
			userId: user.stableUserId,
			config: {
				name,
				tokenUrl: 'https://example.com/oauth/token',
				flow: 'pkce',
				clientId: `${name}-client`,
				requiredHosts: ['example.com'],
			},
		})
		await persistIntegrationTokens({
			env,
			userId: user.stableUserId,
			name,
			accessToken: tokenPayload.access_token,
			refreshPolicy: inferIntegrationRefreshPolicy(tokenPayload),
		})
		await writeIntegrationAuthFailure({
			db: env.APP_DB,
			userId: user.stableUserId,
			name,
			reason: 'missing_refresh_token',
			reconnectable: true,
			expectedTokenRefreshedAt: null,
		})
	}
	mockModule.listJoinedIntegrations.mockResolvedValueOnce(
		await actual.listJoinedIntegrations({
			env,
			userId: user.stableUserId,
		}),
	)

	const signals = await collectWaitingSignals({ env: stubEnv(), user })
	expect(signals.integrationAuth).toEqual([
		expect.objectContaining({
			name: 'google',
			reason: 'missing_refresh_token',
		}),
	])
	expect(
		buildWaitingItems(signals, 'ada')
			.filter((item) => item.kind === 'integration-auth')
			.map((item) => item.id),
	).toEqual(['integration-auth:google'])
})
