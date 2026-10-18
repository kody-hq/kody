import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import { fullGitCommitShaRequiredMessage } from '#worker/package-registry/package-publish-lock.ts'
import { buildUnknownRequestedCommitMessage } from '#worker/repo/requested-commit-error.ts'

const mockModule = vi.hoisted(() => ({
	writablePackage: null as null | {
		id: string
		userId: string
		name: string
		kodyId: string
		description: string
		tags: Array<string>
		searchText: string | null
		sourceId: string
		hasApp: boolean
		hidden: boolean
		isPrivate: boolean
		lockedAt: string | null
		createdAt: string
		updatedAt: string
	},
	setSavedPackageLockedAt: vi.fn(),
	reloadAccountPackagesAfterWrite: vi.fn(),
	getEntitySourceById: vi.fn(),
	resolveArtifactSourceHead: vi.fn(),
	publishFromExternalRef: vi.fn(),
	getCommunityListingByOwnerAndPackage: vi.fn(),
	loadPublicTreeFiles: vi.fn(async (_input: { commit: string | null }) => ({
		files: {} as Record<string, string>,
		fromListingSnapshot: false,
	})),
	readArtifactTreeAtCommit: vi.fn(
		async (_input: { commit: string }): Promise<Record<string, string>> => ({}),
	),
}))

vi.mock('#app/account-package-write-access.ts', () => ({
	loadWritableAccountSavedPackage: vi.fn(
		async (input: { user: { mcpUser: { userId: string } } }) => {
			if (!mockModule.writablePackage) {
				return {
					ok: false as const,
					response: new Response(
						JSON.stringify({ ok: false, error: 'Package not found.' }),
						{ status: 404 },
					),
				}
			}
			return {
				ok: true as const,
				package: {
					savedPackage: mockModule.writablePackage,
					ownerUserId: mockModule.writablePackage.userId,
					actorUserId: input.user.mcpUser.userId,
				},
			}
		},
	),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	setSavedPackageLockedAt: mockModule.setSavedPackageLockedAt,
}))
vi.mock('#app/account-packages-data.ts', () => ({
	reloadAccountPackagesAfterWrite: (...args: Array<unknown>) =>
		mockModule.reloadAccountPackagesAfterWrite(...args),
}))
vi.mock('#worker/orgs/repo.ts', () => ({
	loadOrgBindingForOrg: vi.fn(async () => ({
		org: { id: ownerIdFromStored('user-1'), slug: 'user' },
		role: 'owner' as const,
	})),
}))
vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: mockModule.getEntitySourceById,
}))
vi.mock('#worker/repo/artifacts.ts', () => ({
	resolveArtifactSourceHead: mockModule.resolveArtifactSourceHead,
}))
vi.mock('#app/package-files-data.ts', () => ({
	loadPublicTreeFiles: mockModule.loadPublicTreeFiles,
}))
vi.mock('#worker/repo/artifact-file.ts', () => ({
	readArtifactTreeAtCommit: mockModule.readArtifactTreeAtCommit,
}))
vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: () => ({
		publishFromExternalRef: mockModule.publishFromExternalRef,
	}),
}))
vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingByOwnerAndPackage: (...args: Array<unknown>) =>
		mockModule.getCommunityListingByOwnerAndPackage(...args),
}))
vi.mock('#worker/app-base-url.ts', () => ({
	getAppBaseUrl: () => 'https://example.com',
}))

const {
	lockAccountPackage,
	unlockAccountPackage,
	approveAccountPackagePublish,
	loadAccountPackageApprovePublishData,
} = await import('./account-package-publish-lock.ts')

type ActionInput = Parameters<typeof lockAccountPackage>[0]

const env = { APP_DB: {} as D1Database } as Env
const user = {
	email: 'user@example.com',
	username: 'user',
	mcpUser: {
		userId: personIdFromStored('user-1'),
		email: 'user@example.com',
		username: 'user',
		displayName: 'User',
	},
} as ActionInput['user']

const fullCommit = '0123456789abcdef0123456789abcdef01234567'
const unknownCommit = 'fedcba9876543210fedcba9876543210fedcba98'
const shortCommit = '35aaf10'

const unlockedPackage = {
	id: 'pkg-1',
	userId: ownerIdFromStored('user-1'),
	name: '@user/notes',
	kodyId: 'notes',
	description: 'Notes',
	tags: [],
	searchText: null,
	sourceId: 'source-1',
	hasApp: false,
	hidden: false,
	isPrivate: false,
	isInternetVisible: false,
	lockedAt: null,
	createdAt: '2026-08-01T00:00:00.000Z',
	updatedAt: '2026-08-01T00:00:00.000Z',
}
const lockedPackage = {
	...unlockedPackage,
	lockedAt: '2026-08-28T12:00:00.000Z',
}

function sourceRow(publishedCommit: string) {
	return {
		id: 'source-1',
		user_id: ownerIdFromStored('user-1'),
		entity_kind: 'package',
		entity_id: 'pkg-1',
		repo_id: 'repo-1',
		published_commit: publishedCommit,
		manifest_path: 'package.json',
		source_root: '/',
	}
}

function act(input: { action: string; packageId: string; commit?: string }) {
	const context = {
		env,
		request: new Request('https://example.com/_serverFn/package', {
			method: 'POST',
		}),
		user,
		packageId: input.packageId,
	}
	if (input.action === 'lock') return lockAccountPackage(context)
	if (input.action === 'unlock') return unlockAccountPackage(context)
	return approveAccountPackagePublish({
		...context,
		commit: input.commit ?? '',
	})
}

function loadApprove(commit?: string) {
	const query = commit ? `?commit=${commit}` : ''
	return loadAccountPackageApprovePublishData({
		env,
		request: new Request(
			`https://example.com/@test-user/discord-gateway/approve-publish${query}`,
		),
		user,
		packageId: 'pkg-1',
	})
}

async function loadApproveOk(commit?: string) {
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(null)
	const loaded = await loadApprove(commit)
	if (!loaded.ok) throw new Error('expected loader success')
	return loaded
}

test('website lock and unlock write locked_at and approve-publish promotes a named commit without unlocking', async () => {
	mockModule.reloadAccountPackagesAfterWrite.mockRejectedValue(
		new Error('Unrelated package list unavailable'),
	)
	mockModule.writablePackage = unlockedPackage
	mockModule.setSavedPackageLockedAt.mockResolvedValue(true)

	expect(mockModule.setSavedPackageLockedAt).not.toHaveBeenCalled()

	const lockResponse = await act({ action: 'lock', packageId: 'pkg-1' })
	expect(lockResponse?.status).toBe(200)
	expect(lockResponse?.data).toEqual({ ok: true, packageId: 'pkg-1' })
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenCalledWith(env.APP_DB, {
		userId: ownerIdFromStored('user-1'),
		packageId: 'pkg-1',
		lockedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
	})

	mockModule.writablePackage = lockedPackage
	expect((await act({ action: 'lock', packageId: 'pkg-1' }))?.status).toBe(200)
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenCalledTimes(1)

	expect((await act({ action: 'unlock', packageId: 'pkg-1' }))?.status).toBe(
		200,
	)
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenLastCalledWith(
		env.APP_DB,
		{ userId: ownerIdFromStored('user-1'), packageId: 'pkg-1', lockedAt: null },
	)

	mockModule.getEntitySourceById.mockResolvedValue(sourceRow('commit-old'))
	mockModule.publishFromExternalRef.mockResolvedValue({
		status: 'published',
		previous_commit: 'commit-old',
		published_commit: fullCommit,
		manifest: {},
		checks: [],
	})
	const approveBody = {
		action: 'approve-publish',
		packageId: 'pkg-1',
		commit: fullCommit,
	} as const
	expect((await act(approveBody))?.status).toBe(200)
	expect(mockModule.publishFromExternalRef).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-1',
			userId: ownerIdFromStored('user-1'),
			newCommit: fullCommit,
			allowLockedPublish: true,
		}),
	)
	expect(mockModule.setSavedPackageLockedAt).toHaveBeenCalledTimes(2)

	mockModule.writablePackage = unlockedPackage
	expect((await act(approveBody))?.status).toBe(200)
	const unlockedPublish =
		mockModule.publishFromExternalRef.mock.calls.at(-1)?.[0]
	expect(unlockedPublish).toMatchObject({
		sourceId: 'source-1',
		userId: ownerIdFromStored('user-1'),
		newCommit: fullCommit,
	})
	expect(unlockedPublish).not.toHaveProperty('allowLockedPublish')
	expect(mockModule.reloadAccountPackagesAfterWrite).not.toHaveBeenCalled()

	mockModule.writablePackage = lockedPackage
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'deadbeef',
	})
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue(null)
	expect(await loadApprove(fullCommit)).toMatchObject({
		ok: true,
		publishedCommit: 'commit-old',
		pendingCommit: fullCommit,
		alreadyPublished: false,
		pendingIsDefaultHead: false,
		packageHref: '/@user/notes',
		package: { id: 'pkg-1', lockedAt: '2026-08-28T12:00:00.000Z' },
		listing: null,
		listingWillLagAfterPromote: false,
		diff: { files: [], omittedCount: 0 },
	})
})

test('approve-publish hrefs use the owning org slug for team packages', async () => {
	mockModule.writablePackage = {
		...unlockedPackage,
		userId: ownerIdFromStored('org-acme'),
		kodyId: 'shared',
		name: '@acme/shared',
	}
	mockModule.getEntitySourceById.mockResolvedValue({
		...sourceRow('commit-old'),
		user_id: ownerIdFromStored('org-acme'),
	})
	vi.mocked(loadOrgBindingForOrg).mockResolvedValueOnce({
		org: {
			id: ownerIdFromStored('org-acme'),
			slug: 'acme',
		},
		role: 'member',
	} as Awaited<ReturnType<typeof loadOrgBindingForOrg>>)
	const loaded = await loadApproveOk(fullCommit)
	expect(loaded.packageHref).toBe('/@acme/shared')
	expect(loaded.filesHref).toContain('/@acme/shared')
})

test('approve-publish loader hints when the catalog pin already lags published, and never claims promote will lag', async () => {
	const publishedCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	const pendingCommit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
	mockModule.writablePackage = unlockedPackage
	mockModule.getEntitySourceById.mockResolvedValue(sourceRow(publishedCommit))
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		commit: pendingCommit,
	})
	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue({
		id: 'listing-1',
		status: 'active',
		pinnedCommit: 'cccccccccccccccccccccccccccccccccccccccc',
		version: '1.4.0',
	})
	const alreadyBehind = await loadApprove(pendingCommit)
	if (!alreadyBehind.ok) throw new Error('expected loader success')
	expect(alreadyBehind.listing).toEqual({
		pinnedVersion: '1.4.0',
		promotedVersion: null,
		behind: true,
		updateHint: expect.stringContaining('automatically'),
		updateUrl: '/@user/notes/settings#update-public-listing',
	})
	expect(alreadyBehind.listingWillLagAfterPromote).toBe(false)

	mockModule.getCommunityListingByOwnerAndPackage.mockResolvedValue({
		id: 'listing-1',
		status: 'active',
		pinnedCommit: publishedCommit,
		version: '1.4.0',
	})
	const matchedPin = await loadApprove(pendingCommit)
	if (!matchedPin.ok) throw new Error('expected loader success')
	expect(matchedPin.listing).toBeNull()
	expect(matchedPin.listingWillLagAfterPromote).toBe(false)
})

test('approve-publish resolves HEAD, missing published, and missing HEAD diffs', async () => {
	const publishedCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	const pendingCommit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
	const emptyDiff = { files: [], omittedCount: 0 }
	const publishedReadmeTree = async (input: {
		commit: string | null
	}): Promise<{
		files: Record<string, string>
		fromListingSnapshot: boolean
	}> => ({
		files:
			input.commit === publishedCommit ? { 'README.md': '# published\n' } : {},
		fromListingSnapshot: false,
	})
	mockModule.writablePackage = unlockedPackage
	mockModule.getEntitySourceById.mockResolvedValue(sourceRow(publishedCommit))
	mockModule.loadPublicTreeFiles.mockImplementation(publishedReadmeTree)
	mockModule.readArtifactTreeAtCommit.mockImplementation(
		async (input: { commit: string }): Promise<Record<string, string>> =>
			input.commit === pendingCommit ? { 'README.md': '# head\n' } : {},
	)

	const fromArtifacts = await loadApproveOk(pendingCommit)
	expect(fromArtifacts).toMatchObject({ publishedCommit, pendingCommit })
	expect(fromArtifacts.diff.files).toEqual([
		{
			path: 'README.md',
			status: 'modified',
			patch: expect.stringContaining('+# head'),
		},
	])
	expect(mockModule.readArtifactTreeAtCommit).toHaveBeenCalledWith(
		expect.objectContaining({ repoId: 'repo-1', commit: pendingCommit }),
	)

	mockModule.readArtifactTreeAtCommit.mockRejectedValue(
		new Error('fetch failed'),
	)
	expect((await loadApproveOk(pendingCommit)).diff).toEqual(emptyDiff)

	mockModule.readArtifactTreeAtCommit.mockImplementation(
		async (input: { commit: string }) => {
			if (input.commit === publishedCommit) {
				throw new Error('published fetch failed')
			}
			return { 'README.md': '# head\n' }
		},
	)
	mockModule.loadPublicTreeFiles.mockResolvedValue({
		files: {},
		fromListingSnapshot: false,
	})
	expect((await loadApproveOk(pendingCommit)).diff).toEqual(emptyDiff)

	mockModule.resolveArtifactSourceHead.mockResolvedValue({ commit: null })
	mockModule.loadPublicTreeFiles.mockImplementation(publishedReadmeTree)
	const missingHead = await loadApproveOk()
	expect(missingHead.pendingCommit).toBeNull()
	expect(missingHead.diff).toEqual(emptyDiff)
})

test('approve-publish loader rejects a short commit SHA', async () => {
	mockModule.writablePackage = lockedPackage
	mockModule.getEntitySourceById.mockResolvedValue(sourceRow(fullCommit))
	mockModule.readArtifactTreeAtCommit.mockClear()
	const loaded = await loadApprove(shortCommit)
	expect(loaded).toEqual({
		ok: false,
		error: fullGitCommitShaRequiredMessage,
	})
	expect(mockModule.readArtifactTreeAtCommit).not.toHaveBeenCalled()
	expect(mockModule.publishFromExternalRef).not.toHaveBeenCalled()
})

test('approve-publish mutation rejects a short commit SHA', async () => {
	mockModule.writablePackage = lockedPackage
	mockModule.getEntitySourceById.mockResolvedValue(sourceRow(fullCommit))
	mockModule.publishFromExternalRef.mockClear()
	const response = await act({
		action: 'approve-publish',
		packageId: 'pkg-1',
		commit: shortCommit,
	})
	expect(response?.status).toBe(400)
	expect(response?.data).toEqual({
		ok: false,
		error: fullGitCommitShaRequiredMessage,
	})
	expect(mockModule.publishFromExternalRef).not.toHaveBeenCalled()
})

test('approve-publish mutation returns a distinct error for an unknown full SHA', async () => {
	mockModule.writablePackage = lockedPackage
	mockModule.getEntitySourceById.mockResolvedValue(sourceRow(fullCommit))
	mockModule.publishFromExternalRef.mockRejectedValueOnce(
		Object.assign(
			new Error(
				`Failed to checkout "${unknownCommit}" because commit ${unknownCommit} is not available locally. Do a git fetch to make the branch available locally.`,
			),
			{ name: 'CommitNotFetchedError', code: 'CommitNotFetchedError' },
		),
	)
	const response = await act({
		action: 'approve-publish',
		packageId: 'pkg-1',
		commit: unknownCommit,
	})
	expect(response?.status).toBe(400)
	expect(response?.data).toEqual({
		ok: false,
		error: buildUnknownRequestedCommitMessage(unknownCommit),
	})
	expect(response?.data.error).not.toContain('restorable backup')
	expect(response?.data.error).not.toContain('source recovery')
})

test('approve-publish keeps a source-recovery clone failure distinct from an unknown commit', async () => {
	mockModule.writablePackage = lockedPackage
	mockModule.getEntitySourceById.mockResolvedValue(sourceRow(fullCommit))
	const cloneMiss = new Error(
		'Artifacts git clone failed for https://example.test/repo.git: Could not find refs/heads/main.',
	)
	mockModule.publishFromExternalRef.mockRejectedValueOnce(
		new Error(
			`packagePublishExternalPush stopped by the production package source safety policy. Kody could not verify a restorable backup snapshot for source "source-1" at published commit "${fullCommit}": ${cloneMiss.message} Stop and report this source recovery problem instead of rebuilding or overwriting the package in place.`,
			{ cause: cloneMiss },
		),
	)
	await expect(
		act({
			action: 'approve-publish',
			packageId: 'pkg-1',
			commit: fullCommit,
		}),
	).rejects.toThrow('restorable backup snapshot')
})
