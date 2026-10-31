import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	prepareCommunityFork: vi.fn(),
	preparePrivatePackageFork: vi.fn(),
	persistPreparedCommunityFork: vi.fn(),
	runRepoChecks: vi.fn(),
	refreshSavedPackageProjection: vi.fn(),
	getSavedPackageById: vi.fn(),
	existingFork: null as null | Record<string, unknown>,
}))

vi.mock('./service.ts', () => ({
	prepareCommunityFork: mockModule.prepareCommunityFork,
	persistPreparedCommunityFork: mockModule.persistPreparedCommunityFork,
	// Claim + existing-fork lookup are covered in community-service and
	// fork-claims tests; here every install is a first fork.
	runIdempotentCommunityFork: (
		_input: unknown,
		handlers: {
			create: (hold: { claimId: string }) => Promise<unknown>
			existing: (fork: unknown) => Promise<unknown>
		},
	) =>
		mockModule.existingFork
			? handlers.existing(mockModule.existingFork)
			: handlers.create({ claimId: 'test-claim' }),
	preparePrivatePackageFork: mockModule.preparePrivatePackageFork,
	runIdempotentPrivatePackageFork: (
		_input: unknown,
		handlers: {
			create: (hold: { claimId: string }) => Promise<unknown>
			existing: (fork: unknown) => Promise<unknown>
		},
	) =>
		mockModule.existingFork
			? handlers.existing(mockModule.existingFork)
			: handlers.create({ claimId: 'test-claim' }),
	buildAlreadyForkedMessage: (input: { targetName: string }) =>
		`You already forked this listing as "${input.targetName}".`,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: mockModule.getSavedPackageById,
}))

vi.mock('#worker/repo/checks.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#worker/repo/checks.ts')>()
	return {
		...actual,
		runRepoChecks: mockModule.runRepoChecks,
	}
})

vi.mock('#worker/package-registry/service.ts', () => ({
	refreshSavedPackageProjection: mockModule.refreshSavedPackageProjection,
}))

import {
	installCommunityListing,
	installPrivatePackageFork,
} from './install.ts'

const env = { APP_DB: {} as D1Database } as Env
const files = {
	'package.json': '{"name":"@userb/demo"}',
	'src/index.ts': 'export default async function main() {}',
}
const crossScopeReferences = [
	{ file: 'src/index.ts', specifier: 'kody:@usera/' },
]
const forkFields = {
	forkId: 'fork-1',
	packageId: 'package-1',
	sourceId: 'source-1',
	targetKodyId: 'demo',
	targetName: '@userb/demo',
	originCommit: 'commit-1',
}

function preparedFork(overrides: { crossScopeReferences?: unknown } = {}) {
	return {
		env,
		baseUrl: 'https://kody.test',
		userId: ownerIdFromStored('user-b'),
		listingId: 'listing-1',
		listingName: '@owner/demo',
		listingKodyId: 'demo',
		originCommit: 'commit-1',
		actor: 'human' as const,
		packageId: 'package-1',
		targetKodyId: 'demo',
		targetName: '@userb/demo',
		files,
		crossScopeReferences: [],
		...overrides,
	}
}

function forkResult(
	overrides: {
		crossScopeReferences?: unknown
		files?: Record<string, string>
		filesCount?: number
		originCommit?: string
	} = {},
) {
	return {
		...forkFields,
		crossScopeReferences: [],
		filesCount: 2,
		files,
		...overrides,
	}
}

function install(overrides: { waitUntil?: () => void } = {}) {
	return installCommunityListing({
		env,
		baseUrl: 'https://kody.test',
		userId: ownerIdFromStored('user-b'),
		userEmail: 'userb@example.com',
		expectedPackageScope: 'userb',
		listingId: 'listing-1',
		expectedPinnedCommit: 'commit-1',
		...overrides,
	})
}

function mockCleanInstall() {
	mockModule.prepareCommunityFork.mockResolvedValue(preparedFork())
	mockModule.persistPreparedCommunityFork.mockResolvedValue(forkResult())
	mockModule.runRepoChecks.mockResolvedValue({
		ok: true,
		results: [{ kind: 'manifest', ok: true, message: 'ok' }],
	})
	mockModule.refreshSavedPackageProjection.mockResolvedValue(undefined)
}

async function waitFor(condition: () => boolean) {
	for (let attempt = 0; attempt < 50 && !condition(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
	expect(condition()).toBe(true)
}

test('install publishes clean forks, keeps failed checks inert, and propagates errors', async () => {
	mockCleanInstall()
	await expect(install()).resolves.toEqual({
		status: 'installed',
		...forkFields,
	})
	// The user's trust/acknowledgement decision is pinned to the commit they
	// saw, so a concurrent republish cannot swap in unreviewed content.
	expect(mockModule.prepareCommunityFork).toHaveBeenCalledWith(
		expect.objectContaining({ expectedPinnedCommit: 'commit-1' }),
	)
	expect(mockModule.runRepoChecks).toHaveBeenCalledWith(
		expect.objectContaining({
			manifestPath: 'package.json',
			sourceRoot: '/',
			env,
			baseUrl: 'https://kody.test',
			userId: ownerIdFromStored('user-b'),
			expectedPackageScope: 'userb',
			requirePackageDocs: false,
			enforceCredentialStamp: false,
		}),
	)
	// The checks workspace serves the fork's rewritten snapshot files.
	const workspace = mockModule.runRepoChecks.mock.calls[0]?.[0]?.workspace
	await expect(workspace.readFile('package.json')).resolves.toBe(
		files['package.json'],
	)
	await expect(workspace.readFile('/src/index.ts')).resolves.toBe(
		files['src/index.ts'],
	)
	await expect(workspace.readFile('missing.ts')).resolves.toBeNull()
	await expect(workspace.glob('**/*')).resolves.toEqual([
		{ path: 'package.json', type: 'file' },
		{ path: 'src/index.ts', type: 'file' },
	])
	expect(mockModule.refreshSavedPackageProjection).toHaveBeenCalledWith({
		audit: null,
		creatorUserId: null,
		env,
		baseUrl: 'https://kody.test',
		userId: ownerIdFromStored('user-b'),
		userEmail: 'userb@example.com',
		packageId: 'package-1',
		sourceId: 'source-1',
		sourceFiles: files,
		waitUntil: undefined,
	})

	const waitUntil = vi.fn()
	await install({ waitUntil })
	expect(mockModule.refreshSavedPackageProjection).toHaveBeenLastCalledWith(
		expect.objectContaining({ waitUntil, sourceFiles: files }),
	)

	mockModule.prepareCommunityFork.mockResolvedValue(
		preparedFork({ crossScopeReferences }),
	)
	mockModule.persistPreparedCommunityFork.mockResolvedValue(
		forkResult({ crossScopeReferences }),
	)
	const failedCheck = {
		kind: 'bundle',
		ok: false,
		message: 'unresolved kody import',
	}
	mockModule.runRepoChecks.mockResolvedValue({
		ok: false,
		results: [{ kind: 'manifest', ok: true, message: 'ok' }, failedCheck],
	})
	mockModule.refreshSavedPackageProjection.mockClear()
	await expect(install()).resolves.toEqual({
		status: 'adaptation_required',
		...forkFields,
		failedChecks: [failedCheck],
		crossScopeReferences,
	})
	expect(mockModule.refreshSavedPackageProjection).not.toHaveBeenCalled()

	mockModule.prepareCommunityFork.mockRejectedValueOnce(
		new Error('banned from community participation'),
	)
	await expect(install()).rejects.toThrow('banned from community participation')

	mockCleanInstall()
	mockModule.refreshSavedPackageProjection.mockRejectedValue(
		new Error('saved_packages entitlement exceeded'),
	)
	await expect(install()).rejects.toThrow('saved_packages entitlement exceeded')
})

test('install overlaps Artifacts persist with publish checks', async () => {
	mockCleanInstall()
	const persistGate = Promise.withResolvers<void>()
	const checksGate = Promise.withResolvers<void>()
	const started: Array<string> = []
	mockModule.persistPreparedCommunityFork.mockImplementation(async () => {
		started.push('persist')
		await persistGate.promise
		return forkResult()
	})
	mockModule.runRepoChecks.mockImplementation(async () => {
		started.push('checks')
		await checksGate.promise
		return { ok: true, results: [] }
	})
	const installPromise = install()
	await waitFor(() => started.includes('persist') && started.includes('checks'))
	persistGate.resolve()
	checksGate.resolve()
	await expect(installPromise).resolves.toMatchObject({ status: 'installed' })

	const checksFailPersistGate = Promise.withResolvers<void>()
	let persistStarted = false
	let persistFinished = false
	mockModule.persistPreparedCommunityFork.mockImplementation(async () => {
		persistStarted = true
		await checksFailPersistGate.promise
		persistFinished = true
		return forkResult()
	})
	mockModule.runRepoChecks.mockRejectedValue(
		new Error('isolated check isolate reset'),
	)
	mockModule.refreshSavedPackageProjection.mockClear()
	const checksThrowPromise = install()
	await waitFor(() => persistStarted)
	expect(persistFinished).toBe(false)
	checksFailPersistGate.resolve()
	await expect(checksThrowPromise).rejects.toThrow(
		'isolated check isolate reset',
	)
	expect(persistFinished).toBe(true)
	expect(mockModule.refreshSavedPackageProjection).not.toHaveBeenCalled()

	const persistFailChecksGate = Promise.withResolvers<void>()
	let checksStarted = false
	let checksFinished = false
	mockModule.persistPreparedCommunityFork.mockRejectedValue(
		new Error('artifact bootstrap failed'),
	)
	mockModule.runRepoChecks.mockImplementation(async () => {
		checksStarted = true
		await persistFailChecksGate.promise
		checksFinished = true
		return { ok: true, results: [] }
	})
	const persistThrowPromise = install()
	await waitFor(() => checksStarted)
	expect(checksFinished).toBe(false)
	persistFailChecksGate.resolve()
	await expect(persistThrowPromise).rejects.toThrow('artifact bootstrap failed')
	expect(checksFinished).toBe(true)
})

test('install re-checks and projects the synced fork files when fallback differs from prepare', async () => {
	mockCleanInstall()
	const syncedFiles = {
		'package.json': '{"name":"@userb/demo","version":"2.0.0"}',
		'src/index.ts': 'export default async function main() { return 2 }',
		'README.md': '# dest HEAD',
	}
	mockModule.persistPreparedCommunityFork.mockResolvedValue(
		forkResult({
			files: syncedFiles,
			filesCount: Object.keys(syncedFiles).length,
			originCommit: 'commit-dest-head',
		}),
	)
	mockModule.runRepoChecks
		.mockResolvedValueOnce({ ok: true, results: [] })
		.mockResolvedValueOnce({ ok: true, results: [] })

	await expect(install()).resolves.toMatchObject({
		status: 'installed',
		originCommit: 'commit-dest-head',
	})

	expect(mockModule.runRepoChecks).toHaveBeenCalledTimes(2)
	expect(mockModule.refreshSavedPackageProjection).toHaveBeenCalledWith(
		expect.objectContaining({ sourceFiles: syncedFiles }),
	)
})

test('install returns the existing fork instead of forking again', async () => {
	mockCleanInstall()
	mockModule.prepareCommunityFork.mockClear()
	mockModule.persistPreparedCommunityFork.mockClear()
	mockModule.existingFork = {
		id: 'fork-existing',
		listingId: 'listing-1',
		forkerUserId: 'user-b',
		originCommit: 'commit-1',
		forkedPackageId: 'package-existing',
		forkedSourceId: 'source-existing',
		targetKodyId: 'demo',
		createdAt: '2026-10-23T18:00:00.000Z',
		adoptedAt: null,
		adoptionNote: null,
	}
	try {
		// Inert fork (no live package yet): still the same fork, needs adapting.
		mockModule.getSavedPackageById.mockResolvedValueOnce(null)
		expect(await install()).toEqual({
			status: 'adaptation_required',
			forkId: 'fork-existing',
			packageId: 'package-existing',
			sourceId: 'source-existing',
			targetKodyId: 'demo',
			targetName: '@userb/demo',
			originCommit: 'commit-1',
			alreadyInstalled: true,
			message: 'You already forked this listing as "@userb/demo".',
			failedChecks: [],
			crossScopeReferences: [],
		})
		// Published fork: installed under its live name.
		mockModule.getSavedPackageById.mockResolvedValueOnce({
			id: 'package-existing',
			name: '@userb/demo-renamed',
			sourceId: 'source-live',
		})
		expect(await install()).toMatchObject({
			status: 'installed',
			alreadyInstalled: true,
			targetName: '@userb/demo-renamed',
			sourceId: 'source-live',
		})
		expect(mockModule.prepareCommunityFork).not.toHaveBeenCalled()
		expect(mockModule.persistPreparedCommunityFork).not.toHaveBeenCalled()
	} finally {
		mockModule.existingFork = null
	}
})

test('private package fork uses the reader-checked prepare and publishes clean forks', async () => {
	mockModule.existingFork = null
	mockCleanInstall()
	mockModule.preparePrivatePackageFork.mockResolvedValue({
		...preparedFork(),
		listingId: null,
		upstreamOwnerId: 'owner-org',
		upstreamPackageId: 'source-package',
		claimKey: 'package:source-package',
	})
	mockModule.prepareCommunityFork.mockClear()
	const result = await installPrivatePackageFork({
		env,
		baseUrl: 'https://kody.test',
		userId: ownerIdFromStored('user-b'),
		userEmail: 'userb@example.com',
		expectedPackageScope: 'userb',
		sourcePackage: {
			ownerId: ownerIdFromStored('owner-org'),
			packageId: 'source-package',
		},
		reader: { userId: 'user-b', username: 'userb' } as Parameters<
			typeof installPrivatePackageFork
		>[0]['reader'],
	})
	expect(result).toMatchObject({ status: 'installed', packageId: 'package-1' })
	expect(mockModule.prepareCommunityFork).not.toHaveBeenCalled()
	expect(mockModule.preparePrivatePackageFork).toHaveBeenCalledWith(
		expect.objectContaining({
			sourcePackage: { ownerId: 'owner-org', packageId: 'source-package' },
			reader: { userId: 'user-b', username: 'userb' },
		}),
	)
	expect(mockModule.persistPreparedCommunityFork).toHaveBeenCalledWith(
		expect.objectContaining({
			listingId: null,
			upstreamPackageId: 'source-package',
		}),
		{ claimId: 'test-claim' },
	)
})
