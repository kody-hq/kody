import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { authorizeRepoSessionPackageWrite } from '#mcp/capabilities/repo/authorize-repo-session-package.ts'

const mocks = vi.hoisted(() => ({
	resolveConnectionProfileGrants: vi.fn(),
	resolvePackageOwnerContext: vi.fn(),
	getSavedPackageById: vi.fn(),
	resolveSavedPackageRef: vi.fn(),
	getSavedPackageByName: vi.fn(),
	updateSavedPackage: vi.fn(),
	getEntitySourceByIdForUser: vi.fn(),
	resolveArtifactSourceHead: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
	resolveSavedPackage: vi.fn(),
	getRepoSessionById: vi.fn(),
	sqlQuery: vi.fn(),
	deleteSavedPackageProjection: vi.fn(),
	publishCommunityListing: vi.fn(),
	unpublishCommunityListing: vi.fn(),
	getCommunityListingById: vi.fn(),
	createStubSavedPackage: vi.fn(),
	assertWithinEntitlement: vi.fn(),
}))

vi.mock('#worker/connection-profiles/repo.ts', () => ({
	resolveConnectionProfileGrants: (...args: Array<unknown>) =>
		mocks.resolveConnectionProfileGrants(...args),
}))

vi.mock('#worker/package-registry/package-owner.ts', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		resolvePackageOwnerContext: (...args: Array<unknown>) =>
			mocks.resolvePackageOwnerContext(...args),
	}
})

vi.mock('#worker/package-registry/repo.ts', async (importOriginal) => {
	const actual = await importOriginal()
	return {
		...(actual as object),
		getSavedPackageById: (...args: Array<unknown>) =>
			mocks.getSavedPackageById(...args),
		resolveSavedPackageRef: (...args: Array<unknown>) =>
			mocks.resolveSavedPackageRef(...args),
		getSavedPackageByName: (...args: Array<unknown>) =>
			mocks.getSavedPackageByName(...args),
		updateSavedPackage: (...args: Array<unknown>) =>
			mocks.updateSavedPackage(...args),
	}
})

vi.mock('#worker/repo/entity-sources.ts', async (importOriginal) => {
	const actual = await importOriginal()
	return {
		...(actual as object),
		getEntitySourceByIdForUser: (...args: Array<unknown>) =>
			mocks.getEntitySourceByIdForUser(...args),
	}
})

vi.mock('#worker/repo/artifacts.ts', async (importOriginal) => {
	const actual = await importOriginal()
	return {
		...(actual as object),
		resolveArtifactSourceHead: (...args: Array<unknown>) =>
			mocks.resolveArtifactSourceHead(...args),
	}
})

vi.mock('#worker/repo/source-sync.ts', () => ({
	syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mocks.syncArtifactSourceSnapshot(...args),
}))

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: (...args: Array<unknown>) =>
		mocks.resolveSavedPackage(...args),
}))

vi.mock('#worker/repo/repo-sessions.ts', async (importOriginal) => {
	const actual = await importOriginal()
	return {
		...(actual as object),
		getRepoSessionById: (...args: Array<unknown>) =>
			mocks.getRepoSessionById(...args),
	}
})

vi.mock('#worker/storage-runner.ts', () => ({
	assertStorageRunnerWriteWithinEntitlement: vi.fn(),
	isReadOnlyStorageSqlQuery: () => false,
	storageRunnerRpc: () => ({
		sqlQuery: (...args: Array<unknown>) => mocks.sqlQuery(...args),
	}),
}))

vi.mock('#worker/entitlements/service.ts', () => ({
	estimateEntitlementStorageSqlWriteBytes: () => 0,
	assertWithinEntitlement: (...args: Array<unknown>) =>
		mocks.assertWithinEntitlement(...args),
}))

vi.mock('#worker/package-registry/service.ts', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		deleteSavedPackageProjection: (...args: Array<unknown>) =>
			mocks.deleteSavedPackageProjection(...args),
	}
})

vi.mock('#worker/community/service.ts', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		publishCommunityListing: (...args: Array<unknown>) =>
			mocks.publishCommunityListing(...args),
		unpublishCommunityListing: (...args: Array<unknown>) =>
			mocks.unpublishCommunityListing(...args),
	}
})

vi.mock('#worker/community/repo.ts', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		getCommunityListingById: (...args: Array<unknown>) =>
			mocks.getCommunityListingById(...args),
	}
})

vi.mock('./create-stub-package.ts', () => ({
	createStubSavedPackage: (...args: Array<unknown>) =>
		mocks.createStubSavedPackage(...args),
}))

const { packageUpdateCapability } = await import('./package-update.ts')
const { savePackageCapability } = await import('./save-package.ts')
const { publishExternalPushCapability } =
	await import('./publish-external-push.ts')
const { getGitRemoteCapability } = await import('./get-git-remote.ts')
const { storageQueryCapability } =
	await import('#mcp/capabilities/storage/storage-query.ts')
const { deletePackageCapability } = await import('./delete-package.ts')
const { communityPublishCapability } =
	await import('#mcp/capabilities/community/publish.ts')
const { communityUnpublishCapability } =
	await import('#mcp/capabilities/community/unpublish.ts')

const savedPackage = {
	id: 'pkg-1',
	userId: ownerIdFromStored('user-1'),
	name: '@user/pkg',
	kodyId: 'pkg',
	description: 'A package',
	tags: [] as Array<string>,
	searchText: null,
	sourceId: 'source-1',
	hasApp: false,
	hidden: false,
	isPrivate: true,
	isInternetVisible: false,
	lockedAt: null,
	createdAt: '2026-04-18T00:00:00.000Z',
	updatedAt: '2026-04-18T00:00:00.000Z',
}

const sourceRow = {
	id: 'source-1',
	user_id: ownerIdFromStored('user-1'),
	entity_kind: 'package' as const,
	entity_id: 'pkg-1',
	repo_id: 'repo-1',
	published_commit: 'commit-1',
	indexed_commit: null,
	manifest_path: 'package.json',
	source_root: '/',
	last_external_check_at: null,
	external_check_until: null,
	created_at: '2026-04-18T00:00:00.000Z',
	updated_at: '2026-04-18T00:00:00.000Z',
}

function callerContext(options?: { profile?: boolean }) {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://heykody.dev',
		connectionProfileName: options?.profile === false ? null : 'work',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'user@example.com',
			displayName: 'User',
			username: 'user',
		},
	})
}

function ctx(options?: { profile?: boolean }) {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: callerContext(options),
	}
}

function grants(actions: Array<'read' | 'execute' | 'write'>) {
	mocks.resolveConnectionProfileGrants.mockResolvedValue([
		{ resourceType: 'package', resourceId: 'pkg-1', actions },
	])
}

function reset() {
	for (const mock of Object.values(mocks)) mock.mockReset()
	mocks.resolvePackageOwnerContext.mockResolvedValue({
		ownerUserId: ownerIdFromStored('user-1'),
		ownerScope: 'user',
		ownerEmail: 'user@example.com',
		actorUserId: 'user-1',
	})
	mocks.getSavedPackageById.mockResolvedValue(savedPackage)
	mocks.resolveSavedPackageRef.mockResolvedValue(savedPackage)
	mocks.getEntitySourceByIdForUser.mockResolvedValue(sourceRow)
	mocks.resolveSavedPackage.mockResolvedValue(savedPackage)
	mocks.updateSavedPackage.mockResolvedValue(true)
	mocks.getRepoSessionById.mockResolvedValue({
		id: 'session-1',
		user_id: ownerIdFromStored('user-1'),
		source_id: 'source-1',
	})
}

async function denial(run: () => Promise<unknown>) {
	const error = await run().catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(AuthorizationError)
	expect(error).toMatchObject({ code: 'connection_profile' })
}

const saveFiles = [
	{
		path: 'package.json',
		content: JSON.stringify({
			name: '@user/pkg',
			exports: { '.': './src/index.ts' },
			kody: { id: 'pkg', description: 'A package' },
		}),
	},
	{
		path: 'src/index.ts',
		content: 'export default async function main() { return { ok: true } }\n',
	},
]

test('packageSave denies a read-only profile and allows write', async () => {
	reset()
	grants(['read'])
	await denial(() =>
		savePackageCapability.handler(
			{ package_id: 'pkg-1', files: saveFiles },
			ctx(),
		),
	)
	expect(mocks.syncArtifactSourceSnapshot).not.toHaveBeenCalled()
	expect(mocks.getSavedPackageByName).not.toHaveBeenCalled()

	reset()
	grants(['write'])
	mocks.getSavedPackageByName.mockRejectedValue(new Error('past-profile-check'))
	await expect(
		savePackageCapability.handler(
			{ package_id: 'pkg-1', files: saveFiles },
			ctx(),
		),
	).rejects.toThrow('past-profile-check')
	expect(mocks.getSavedPackageByName).toHaveBeenCalled()
})

test('packagePublishExternalPush denies a read-only profile and allows write', async () => {
	reset()
	grants(['read'])
	await denial(() =>
		publishExternalPushCapability.handler({ package_id: 'pkg-1' }, ctx()),
	)
	expect(mocks.resolveArtifactSourceHead).not.toHaveBeenCalled()

	reset()
	grants(['write'])
	mocks.resolveArtifactSourceHead.mockRejectedValue(
		new Error('past-profile-check'),
	)
	await expect(
		publishExternalPushCapability.handler({ package_id: 'pkg-1' }, ctx()),
	).rejects.toThrow('past-profile-check')
})

test('packageGetGitRemote write denies a read-only profile and allows write', async () => {
	reset()
	grants(['read'])
	await denial(() =>
		getGitRemoteCapability.handler(
			{ package_id: 'pkg-1', scope: 'write' },
			ctx(),
		),
	)
	expect(mocks.resolveArtifactSourceHead).not.toHaveBeenCalled()

	reset()
	grants(['write'])
	await expect(
		getGitRemoteCapability.handler(
			{ package_id: 'pkg-1', scope: 'write' },
			ctx(),
		),
	).rejects.toThrow('source safety policy')
})

test('packageUpdate denies a read-only profile and allows write', async () => {
	reset()
	grants(['read'])
	await denial(() =>
		packageUpdateCapability.handler(
			{ package_id: 'pkg-1', changes: { hidden: true } },
			ctx(),
		),
	)
	expect(mocks.updateSavedPackage).not.toHaveBeenCalled()

	reset()
	grants(['write'])
	await expect(
		packageUpdateCapability.handler(
			{ package_id: 'pkg-1', changes: { hidden: true } },
			ctx(),
		),
	).resolves.toMatchObject({ ok: true, package: { package_id: 'pkg-1' } })
	expect(mocks.updateSavedPackage).toHaveBeenCalled()
})

test('repo session package writes deny a read-only profile and allow write', async () => {
	reset()
	grants(['read'])
	await denial(() =>
		authorizeRepoSessionPackageWrite({
			env: { APP_DB: {} } as Env,
			request: callerContext().request,
			userId: ownerIdFromStored('user-1'),
			sessionId: 'session-1',
		}),
	)

	reset()
	grants(['write'])
	await expect(
		authorizeRepoSessionPackageWrite({
			env: { APP_DB: {} } as Env,
			request: callerContext().request,
			userId: ownerIdFromStored('user-1'),
			sessionId: 'session-1',
		}),
	).resolves.toBeUndefined()

	reset()
	mocks.getRepoSessionById.mockResolvedValue(null)
	await expect(
		authorizeRepoSessionPackageWrite({
			env: { APP_DB: {} } as Env,
			request: callerContext().request,
			userId: ownerIdFromStored('user-1'),
			sessionId: 'session-1',
		}),
	).rejects.toThrow('Repo session was not found.')
	await expect(
		authorizeRepoSessionPackageWrite({
			env: { APP_DB: {} } as Env,
			request: callerContext().request,
			userId: ownerIdFromStored('user-1'),
			sessionId: 'session-1',
			allowMissingSession: true,
		}),
	).resolves.toBeUndefined()
})

test('packageDelete denies a read-only profile and allows write', async () => {
	reset()
	grants(['read'])
	await denial(() =>
		deletePackageCapability.handler(
			{ package_id: 'pkg-1', confirm_name: '@user/pkg' },
			ctx(),
		),
	)
	expect(mocks.deleteSavedPackageProjection).not.toHaveBeenCalled()

	reset()
	grants(['write'])
	mocks.deleteSavedPackageProjection.mockRejectedValue(
		new Error('past-profile-check'),
	)
	await expect(
		deletePackageCapability.handler(
			{ package_id: 'pkg-1', confirm_name: '@user/pkg' },
			ctx(),
		),
	).rejects.toThrow('past-profile-check')
	expect(mocks.deleteSavedPackageProjection).toHaveBeenCalled()
})

test('communityPublish denies a read-only profile and allows write', async () => {
	reset()
	grants(['read'])
	await denial(() =>
		communityPublishCapability.handler({ package_id: 'pkg-1' }, ctx()),
	)
	expect(mocks.publishCommunityListing).not.toHaveBeenCalled()

	reset()
	grants(['write'])
	mocks.publishCommunityListing.mockRejectedValue(
		new Error('past-profile-check'),
	)
	await expect(
		communityPublishCapability.handler({ package_id: 'pkg-1' }, ctx()),
	).rejects.toThrow('past-profile-check')
	expect(mocks.publishCommunityListing).toHaveBeenCalled()
})

test('communityUnpublish denies a read-only profile and allows write', async () => {
	reset()
	grants(['read'])
	mocks.getCommunityListingById.mockResolvedValue({
		id: 'listing-1',
		ownerUserId: 'user-1',
		packageId: 'pkg-1',
		kodyId: 'pkg',
		name: '@user/pkg',
	})
	await denial(() =>
		communityUnpublishCapability.handler(
			{ listing_id: 'listing-1', confirm_name: 'pkg' },
			ctx(),
		),
	)
	expect(mocks.unpublishCommunityListing).not.toHaveBeenCalled()

	reset()
	grants(['write'])
	mocks.getCommunityListingById.mockResolvedValue({
		id: 'listing-1',
		ownerUserId: 'user-1',
		packageId: 'pkg-1',
		kodyId: 'pkg',
		name: '@user/pkg',
	})
	mocks.unpublishCommunityListing.mockRejectedValue(
		new Error('past-profile-check'),
	)
	await expect(
		communityUnpublishCapability.handler(
			{ listing_id: 'listing-1', confirm_name: 'pkg' },
			ctx(),
		),
	).rejects.toThrow('past-profile-check')
	expect(mocks.unpublishCommunityListing).toHaveBeenCalled()
})

test('packageSave and packageGetGitRemote deny profile-bound create and allow it without a profile', async () => {
	reset()
	grants(['read', 'write'])
	mocks.getSavedPackageById.mockResolvedValue(null)
	mocks.resolveSavedPackageRef.mockResolvedValue(null)
	await denial(() => savePackageCapability.handler({ files: saveFiles }, ctx()))
	expect(mocks.assertWithinEntitlement).not.toHaveBeenCalled()
	expect(mocks.syncArtifactSourceSnapshot).not.toHaveBeenCalled()

	reset()
	mocks.resolveSavedPackageRef.mockResolvedValue(null)
	mocks.assertWithinEntitlement.mockRejectedValue(
		new Error('past-profile-check'),
	)
	await expect(
		savePackageCapability.handler(
			{ files: saveFiles },
			ctx({ profile: false }),
		),
	).rejects.toThrow('past-profile-check')
	expect(mocks.assertWithinEntitlement).toHaveBeenCalled()

	reset()
	grants(['write'])
	mocks.resolveSavedPackageRef.mockResolvedValue(null)
	await denial(() =>
		getGitRemoteCapability.handler(
			{ kody_id: 'new-pkg', create: true, scope: 'write' },
			ctx(),
		),
	)
	expect(mocks.createStubSavedPackage).not.toHaveBeenCalled()

	reset()
	mocks.resolveSavedPackageRef.mockResolvedValue(null)
	mocks.createStubSavedPackage.mockRejectedValue(
		new Error('past-profile-check'),
	)
	await expect(
		getGitRemoteCapability.handler(
			{ kody_id: 'new-pkg', create: true, scope: 'write' },
			ctx({ profile: false }),
		),
	).rejects.toThrow('past-profile-check')
	expect(mocks.createStubSavedPackage).toHaveBeenCalled()
})

test('storageQuery on a package bucket denies a read-only profile and allows write', async () => {
	reset()
	grants(['read'])
	await denial(() =>
		storageQueryCapability.handler(
			{ storage_id: 'package:pkg-1', query: 'DELETE FROM notes' },
			ctx() as never,
		),
	)
	expect(mocks.sqlQuery).not.toHaveBeenCalled()

	reset()
	grants(['write'])
	mocks.sqlQuery.mockResolvedValue({
		columns: [],
		rows: [],
		rowCount: 0,
		rowsRead: 0,
		rowsWritten: 0,
		truncated: false,
	})
	await expect(
		storageQueryCapability.handler(
			{
				storage_id: 'package:pkg-1',
				query: 'DELETE FROM notes',
				writable: true,
			},
			ctx() as never,
		),
	).resolves.toMatchObject({ ok: true, storage_id: 'package:pkg-1' })
})
