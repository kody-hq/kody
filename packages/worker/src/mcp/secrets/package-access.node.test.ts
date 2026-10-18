import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	parsePackageAccessRequiredBatchMessage,
	parsePackageAccessRequiredMessage,
} from './errors.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	getCommunityForkByForkedPackageId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	findSecret: vi.fn(),
	getOrgById: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityForkByForkedPackageId: (...args: Array<unknown>) =>
		mockModule.getCommunityForkByForkedPackageId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageManifestBySourceId(...args),
}))

vi.mock('./service.ts', () => ({
	findSecret: (...args: Array<unknown>) => mockModule.findSecret(...args),
}))

vi.mock('#worker/orgs/repo.ts', () => ({
	getOrgById: (...args: Array<unknown>) => mockModule.getOrgById(...args),
}))

const {
	assertCanSetSecrets,
	assertPackageCanAccessResolvedSecret,
	buildPackageApprovalErrorForMounts,
	findMissingPackageApprovals,
	PackageSecretAccessDeniedError,
	resolveSecretPageOrgSlug,
} = await import('./package-access.ts')

const env = { APP_DB: {} as D1Database } as Env
const savedPackage = {
	id: 'pkg-1',
	kodyId: 'discord-gateway',
	name: '@kentcdodds/discord-gateway',
	sourceId: 'source-1',
}
const communityFork = {
	id: 'fork-1',
	listingId: 'listing-1',
	forkerUserId: 'user-1',
	originCommit: 'abc123',
	forkedPackageId: 'pkg-1',
	forkedSourceId: 'source-1',
	targetKodyId: 'discord-gateway',
	createdAt: '2026-01-01T00:00:00.000Z',
	adoptedAt: null,
	adoptionNote: null,
}
const adoptedFork = {
	...communityFork,
	adoptedAt: '2026-07-01T00:00:00.000Z',
	adoptionNote: 'Reviewed source; trusted for my use.',
}
const userSecretResolved = {
	credentialId: 'cred-user-token',
	found: true as const,
	value: 'secret',
	scope: 'user' as const,
	allowedHosts: [] as Array<string>,
	allowedPackages: [] as Array<string>,
}
const grantedToPkg1 = { ...userSecretResolved, allowedPackages: ['pkg-1'] }
const discordMount = {
	discordBotToken: {
		name: 'discordBotTokenKentPersonalAutomation',
		scope: 'user' as const,
	},
}

function accessInput(
	overrides: Partial<
		Parameters<typeof assertPackageCanAccessResolvedSecret>[0]
	> = {},
) {
	return {
		env: { APP_DB: {} as D1Database },
		baseUrl: 'https://example.com',
		orgSlug: 'ada',
		userId: ownerIdFromStored('user-1'),
		storageContext: { sessionId: null, packageId: 'pkg-1' },
		secretName: 'userToken',
		resolved: userSecretResolved,
		...overrides,
	}
}

function expectAccessDenied(error: unknown) {
	expect(error).toBeInstanceOf(PackageSecretAccessDeniedError)
	expect(error).toBeInstanceOf(McpCallerError)
	expect(parsePackageAccessRequiredMessage((error as Error).message)).toEqual({
		secretName: 'userToken',
		packageName: 'discord-gateway',
	})
	return true
}

function lookups(
	pkg: unknown,
	fork: unknown,
	options?: { packageLoads?: number },
) {
	// `use` intent goes through packageHasImplicitUserSecretReadAccess first
	// (one package load). Denied paths load the package again for the approval
	// URL, so pass packageLoads: 2.
	const packageLoads = options?.packageLoads ?? 1
	for (let i = 0; i < packageLoads; i++) {
		mockModule.getSavedPackageById.mockResolvedValueOnce(pkg)
	}
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValueOnce(fork)
}

function clearLookups() {
	mockModule.getSavedPackageById.mockClear()
	mockModule.getCommunityForkByForkedPackageId.mockClear()
}

test('package secret access grants cover owned, self-authored, forked, adopted, and mutate intents', async () => {
	await expect(
		assertPackageCanAccessResolvedSecret(
			accessInput({
				secretName: 'packageToken',
				resolved: { ...userSecretResolved, scope: 'package' },
			}),
		),
	).resolves.toBeUndefined()
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()

	lookups(savedPackage, null)
	await expect(
		assertPackageCanAccessResolvedSecret(accessInput()),
	).resolves.toBeUndefined()
	expect(mockModule.getCommunityForkByForkedPackageId).toHaveBeenCalledWith(
		expect.anything(),
		{ forkerUserId: 'user-1', forkedPackageId: 'pkg-1' },
	)

	lookups(savedPackage, communityFork, { packageLoads: 2 })
	await expect(
		assertPackageCanAccessResolvedSecret(accessInput()),
	).rejects.toSatisfy(expectAccessDenied)

	clearLookups()
	await expect(
		assertPackageCanAccessResolvedSecret(
			accessInput({ resolved: grantedToPkg1 }),
		),
	).resolves.toBeUndefined()
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()
	expect(mockModule.getCommunityForkByForkedPackageId).not.toHaveBeenCalled()

	lookups(savedPackage, adoptedFork)
	await expect(
		assertPackageCanAccessResolvedSecret(accessInput()),
	).resolves.toBeUndefined()

	// Mutate always needs an allowed-packages grant (self-authored and adopted
	// forks alike); the fork lookup is skipped for mutate.
	clearLookups()
	mockModule.getSavedPackageById.mockResolvedValueOnce(savedPackage)
	await expect(
		assertPackageCanAccessResolvedSecret(accessInput({ intent: 'mutate' })),
	).rejects.toSatisfy(expectAccessDenied)
	expect(mockModule.getSavedPackageById).toHaveBeenCalledTimes(1)
	expect(mockModule.getCommunityForkByForkedPackageId).not.toHaveBeenCalled()

	mockModule.getSavedPackageById.mockClear()
	await expect(
		assertPackageCanAccessResolvedSecret(
			accessInput({ intent: 'mutate', resolved: grantedToPkg1 }),
		),
	).resolves.toBeUndefined()
	// Grant short-circuits before package/fork lookups.
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()
	expect(mockModule.getCommunityForkByForkedPackageId).not.toHaveBeenCalled()
})

test('package secret access authorizes the stamp package, not the importing run', async () => {
	lookups(
		{
			...savedPackage,
			id: 'pkg-2',
			kodyId: 'importer',
			name: '@user/importer',
		},
		{ ...communityFork, forkedPackageId: 'pkg-2', targetKodyId: 'importer' },
	)
	const importerRun = { sessionId: null, packageId: 'pkg-2' }
	await expect(
		assertPackageCanAccessResolvedSecret(
			accessInput({ storageContext: importerRun, resolved: grantedToPkg1 }),
		),
	).rejects.toBeInstanceOf(PackageSecretAccessDeniedError)
	await expect(
		assertPackageCanAccessResolvedSecret(
			accessInput({
				storageContext: importerRun,
				authorityPackageId: 'pkg-1',
				resolved: grantedToPkg1,
			}),
		),
	).resolves.toBeUndefined()
})

test("package secret access does not resolve another org's package", async () => {
	const otherOrgPackageId = '91d7d9e4-6b88-44da-ab19-01fe26845ac5'
	// Implicit-access probe + not-found path each call getSavedPackageById.
	mockModule.getSavedPackageById.mockResolvedValue(null)
	await expect(
		assertPackageCanAccessResolvedSecret(
			accessInput({
				storageContext: { sessionId: null, packageId: otherOrgPackageId },
			}),
		),
	).rejects.toSatisfy((error: unknown) => {
		expect(error).toBeInstanceOf(PackageSecretAccessDeniedError)
		expect((error as Error).message).toBe(
			`Package "${otherOrgPackageId}" was not found for secret access.`,
		)
		return true
	})
	expect(mockModule.getCommunityForkByForkedPackageId).not.toHaveBeenCalled()

	mockModule.getSavedPackageById.mockReset()
	lookups(savedPackage, null)
	await expect(
		assertPackageCanAccessResolvedSecret(accessInput()),
	).resolves.toBeUndefined()
})

test('package secret access shares one package load across concurrent use checks (KODY-9K)', async () => {
	clearLookups()
	mockModule.getSavedPackageById.mockResolvedValue(savedPackage)
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue(null)
	// WeakMap inflight is keyed by APP_DB identity — share one handle.
	const sharedEnv = { APP_DB: {} as D1Database }

	await Promise.all([
		assertPackageCanAccessResolvedSecret(
			accessInput({ env: sharedEnv, secretName: 'a' }),
		),
		assertPackageCanAccessResolvedSecret(
			accessInput({ env: sharedEnv, secretName: 'b' }),
		),
		assertPackageCanAccessResolvedSecret(
			accessInput({ env: sharedEnv, secretName: 'c' }),
		),
	])

	expect(mockModule.getSavedPackageById).toHaveBeenCalledTimes(1)
	expect(mockModule.getCommunityForkByForkedPackageId).toHaveBeenCalledTimes(1)
})

test('assertCanSetSecrets fails closed for mutate grants before any provider work', async () => {
	mockModule.getSavedPackageById.mockResolvedValue(savedPackage)
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue(null)
	mockModule.findSecret.mockResolvedValue(userSecretResolved)
	await expect(
		assertCanSetSecrets({
			env: {
				APP_DB: {} as D1Database,
				SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
			},
			userId: ownerIdFromStored('user-1'),
			baseUrl: 'https://example.com',
			orgSlug: 'ada',
			secrets: [
				{ name: 'xRefreshToken', scope: 'user' },
				{ name: 'xAccessToken', scope: 'user' },
			],
			storageContext: { sessionId: null, appId: null, packageId: 'pkg-1' },
		}),
	).rejects.toBeInstanceOf(PackageSecretAccessDeniedError)
	expect(mockModule.findSecret).toHaveBeenCalled()
})

test('package approval helpers parse structured messages and skip trusted packages', async () => {
	expect(buildPackageApprovalErrorForMounts({ entries: [] })).toBeNull()
	const approvalMessage = buildPackageApprovalErrorForMounts({
		entries: [
			{
				secretName: 'discordBotTokenKentPersonalAutomation',
				packageId: 'pkg-1',
				kodyId: 'discord-gateway',
				approvalUrl: 'https://example.com/@ada/-/secrets/user/discordBotToken',
			},
		],
	})
	expect(parsePackageAccessRequiredMessage(approvalMessage ?? '')).toEqual({
		secretName: 'discordBotTokenKentPersonalAutomation',
		packageName: 'discord-gateway',
	})

	const batchNames = ['discordBotToken', 'xAccessToken']
	const batchMessage = buildPackageApprovalErrorForMounts({
		baseUrl: 'https://example.com',
		entries: batchNames.map((secretName) => ({
			secretName,
			packageId: 'pkg-1',
			kodyId: 'release',
			approvalUrl: `https://example.com/@ada/-/secrets/user/${secretName}?package_id=pkg-1`,
		})),
	})
	const batchParsed = parsePackageAccessRequiredBatchMessage(batchMessage ?? '')
	expect(batchParsed?.entries).toEqual(
		batchNames.map((secretName) =>
			expect.objectContaining({
				secretName,
				packageId: 'pkg-1',
				kodyId: 'release',
			}),
		),
	)
	expect(batchParsed?.bulkApprovalUrl).toContain('/@ada/-/secrets/approve?')

	const approvalsInput = {
		env,
		baseUrl: 'https://example.com',
		orgSlug: 'ada',
		userId: ownerIdFromStored('user-1'),
		packageId: 'pkg-1',
		mounts: discordMount,
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: 'pkg-1',
			storageId: 'pkg-1',
		},
	}
	for (const trustedFork of [null, adoptedFork]) {
		lookups(savedPackage, trustedFork)
		await expect(findMissingPackageApprovals(approvalsInput)).resolves.toEqual(
			[],
		)
	}
	expect(mockModule.findSecret).not.toHaveBeenCalled()

	lookups(savedPackage, communityFork)
	mockModule.findSecret.mockResolvedValueOnce({
		found: true,
		value: 'bot-token',
		scope: 'user',
		allowedPackages: [],
	})
	const entries = await findMissingPackageApprovals(approvalsInput)
	expect(entries).toHaveLength(1)
	expect(entries[0]).toMatchObject({
		secretName: 'discordBotTokenKentPersonalAutomation',
		packageId: 'pkg-1',
		kodyId: 'discord-gateway',
	})
	expect(mockModule.loadPackageManifestBySourceId).not.toHaveBeenCalled()
})

test('resolveSecretPageOrgSlug prefers the org row over a renamed username', async () => {
	mockModule.getOrgById.mockResolvedValueOnce({ slug: 'ada' })
	await expect(
		resolveSecretPageOrgSlug({
			db: {} as D1Database,
			userId: ownerIdFromStored('user-1'),
			orgSlug: 'ada2',
			caller: {
				request: { org: { slug: 'ada2' } },
				user: { username: 'ada2' },
			},
		}),
	).resolves.toBe('ada')
	expect(mockModule.getOrgById).toHaveBeenCalledWith(
		{},
		ownerIdFromStored('user-1'),
	)
})

test('findMissingPackageApprovals uses the team org slug and keeps empty links safe', async () => {
	lookups(savedPackage, communityFork)
	mockModule.findSecret.mockResolvedValueOnce({
		found: true,
		value: 'bot-token',
		scope: 'user',
		allowedPackages: [],
	})
	mockModule.getOrgById.mockResolvedValueOnce({ slug: 'acme' })
	const teamEntries = await findMissingPackageApprovals({
		env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('org-acme'),
		packageId: 'pkg-1',
		mounts: discordMount,
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: 'pkg-1',
			storageId: 'pkg-1',
		},
	})
	expect(teamEntries[0]?.approvalUrl).toBe(
		'https://example.com/@acme/-/secrets/user/discordBotTokenKentPersonalAutomation?package_id=pkg-1&package=discord-gateway',
	)

	lookups(savedPackage, communityFork)
	mockModule.findSecret.mockResolvedValueOnce({
		found: true,
		value: 'bot-token',
		scope: 'user',
		allowedPackages: [],
	})
	mockModule.getOrgById.mockResolvedValueOnce(null)
	const unresolved = await findMissingPackageApprovals({
		env,
		baseUrl: 'https://example.com',
		userId: ownerIdFromStored('org-acme'),
		packageId: 'pkg-1',
		mounts: discordMount,
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: 'pkg-1',
			storageId: 'pkg-1',
		},
	})
	expect(unresolved[0]?.approvalUrl).toBe('')
})
