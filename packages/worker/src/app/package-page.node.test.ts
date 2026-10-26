import { DatabaseSync } from 'node:sqlite'
import {
	d1LockRetryBaseDelayMs,
	d1LockRetryMaxAttempts,
	transientDatabaseUnavailableMessage,
} from '@kody-internal/shared/d1-retry.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { type AccountPackageDetail } from '#universal/loader-data.ts'

const mockModule = vi.hoisted(() => ({
	resolvePackagePageUrl: vi.fn(),
	readAuthenticatedAppUser: vi.fn(),
	loadCommunityDetailData: vi.fn(),
	loadAccountPackageDetail: vi.fn(),
	getUserSocialRowByUsername: vi.fn(),
}))

vi.mock('#worker/community/package-url.ts', () => ({
	resolvePackagePageUrl: (...args: Array<unknown>) =>
		mockModule.resolvePackagePageUrl(...args),
	getCommunityPackageHref: (input: { username: string; kodyId: string }) =>
		`/@${input.username}/${input.kodyId}`,
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/community-data.ts', () => ({
	loadCommunityDetailData: (...args: Array<unknown>) =>
		mockModule.loadCommunityDetailData(...args),
}))

vi.mock('#app/account-packages-data.ts', () => ({
	loadAccountPackageDetail: (...args: Array<unknown>) =>
		mockModule.loadAccountPackageDetail(...args),
}))

vi.mock('#worker/community/profile-repo.ts', () => ({
	getUserSocialRowByUsername: (...args: Array<unknown>) =>
		mockModule.getUserSocialRowByUsername(...args),
}))

const { loadPackagePage } = await import('./package-page.ts')

function createEnv() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	const now = '2026-01-01T00:00:00.000Z'
	for (const personId of ['owner-1', 'guest-1']) {
		sqlite
			.prepare(
				`INSERT INTO orgs (id, slug, display_name, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?)`,
			)
			.run(personId, personId, personId, now, now)
		sqlite
			.prepare(
				`INSERT INTO org_memberships (org_id, user_id, role, created_at)
				 VALUES (?, ?, 'owner', ?)`,
			)
			.run(personId, personId, now)
	}
	return { APP_DB: createD1FromSqlite(sqlite) } as unknown as Env
}

const request = new Request('https://example.com/@owner/notes')
const env = createEnv()
const ownerUser = {
	username: 'owner',
	mcpUser: { userId: ownerIdFromStored('owner-1') },
}

function resolvesTo(
	kind: 'package' | 'redirect',
	overrides: {
		kodyId?: string
		listingId?: string | null
		listingKodyId?: string
		savedPackage?: Record<string, unknown>
	} = {},
) {
	mockModule.resolvePackagePageUrl.mockResolvedValue({
		kind,
		username: 'owner',
		kodyId: 'notes',
		userId: ownerIdFromStored('owner-1'),
		listingId: null,
		...(kind === 'package'
			? { savedPackage: { id: 'pkg-1', hidden: false, isPrivate: false } }
			: { packageId: 'pkg-1' }),
		...overrides,
	})
}

function load(kodyId = 'notes', username = 'owner') {
	return loadPackagePage({ env, request, username, kodyId })
}

function setProfileVisibility(profile_visibility: 'public' | 'private') {
	mockModule.getUserSocialRowByUsername.mockResolvedValue({
		profile_visibility,
	})
}

const listingDetail = {
	ok: true,
	listing: { id: 'listing-1', name: '@owner/notes' },
}
const ownerPackageDetail = {
	id: 'pkg-1',
	name: '@owner/notes',
	kodyId: 'notes',
}
const pkg = (overrides: Record<string, unknown>) => ({
	savedPackage: { id: 'pkg-1', hidden: false, isPrivate: false, ...overrides },
})

test('loadPackagePage applies the owner / community / public visibility matrix', async () => {
	setProfileVisibility('public')
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.resolvePackagePageUrl.mockResolvedValue(null)
	await expect(load('missing')).resolves.toEqual({ kind: 'not_found' })

	const anonymousCases = [
		{ name: 'hidden', ...pkg({ hidden: true }), expected: 'not_found' },
		{ name: 'private', ...pkg({ isPrivate: true }), expected: 'not_found' },
		{ name: 'public, unlisted', ...pkg({}), expected: 'unauthorized' },
	]
	for (const { name, savedPackage, expected } of anonymousCases) {
		resolvesTo('package', { savedPackage })
		expect({ name, result: await load() }).toEqual({
			name,
			result: { kind: expected },
		})
	}

	// Signed-in outsiders must see no-access for private packages, never the
	// generic "doesn't quite connect" 404 that made shared app handoffs look
	// like the package was unpublished.
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		username: 'guest',
		mcpUser: { userId: ownerIdFromStored('guest-1'), username: 'guest' },
	})
	resolvesTo('package', pkg({ isPrivate: true, name: '@owner/notes' }))
	await expect(load()).resolves.toEqual({
		kind: 'no_access',
		username: 'owner',
		kodyId: 'notes',
		packageName: '@owner/notes',
		viewerUsername: 'guest',
	})
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)

	mockModule.loadCommunityDetailData.mockResolvedValue(listingDetail)
	resolvesTo('package', { listingId: 'listing-1' })
	expect(await load()).toMatchObject({
		kind: 'page',
		hasPackage: true,
		viewerIsOwner: false,
		viewerCanManage: false,
		listing: { listing: { id: 'listing-1' } },
		ownerPackage: null,
	})

	mockModule.readAuthenticatedAppUser.mockResolvedValue(ownerUser)
	mockModule.loadAccountPackageDetail.mockResolvedValue(ownerPackageDetail)
	resolvesTo('package', pkg({ hidden: true }))
	expect(await load()).toMatchObject({
		kind: 'page',
		hasPackage: true,
		viewerIsOwner: true,
		viewerCanManage: true,
		ownerPackage: { id: 'pkg-1' },
		listing: null,
		ownerProfilePublic: true,
	})
	expect(mockModule.loadAccountPackageDetail).toHaveBeenCalledWith(
		expect.objectContaining({ creditAttributionUsername: 'owner' }),
	)

	// Unlisted renames only redirect the owner; listed renames redirect anyone.
	resolvesTo('redirect', { kodyId: 'renamed' })
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	await expect(load('old')).resolves.toEqual({ kind: 'not_found' })
	mockModule.readAuthenticatedAppUser.mockResolvedValue(ownerUser)
	await expect(load('old')).resolves.toEqual({
		kind: 'redirect',
		to: '/@owner/renamed',
		shared: false,
	})

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	resolvesTo('redirect', { listingId: 'listing-1' })
	await expect(load('notes', 'old')).resolves.toEqual({
		kind: 'redirect',
		to: '/@owner/notes',
		shared: true,
	})
})

test('loadPackagePage does not send anonymous visitors to an unpublished listing rename', async () => {
	const listingLag = {
		listingId: 'listing-1',
		listingKodyId: 'notes',
		savedPackage: {
			id: 'pkg-1',
			kodyId: 'notes-two',
			hidden: false,
			isPrivate: false,
			isInternetVisible: false,
		},
	}
	mockModule.loadCommunityDetailData.mockResolvedValue(listingDetail)
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)

	resolvesTo('package', listingLag)
	expect(await load()).toMatchObject({
		kind: 'page',
		viewerIsOwner: false,
		viewerCanManage: false,
		listing: { listing: { id: 'listing-1' } },
	})

	resolvesTo('package', { ...listingLag, kodyId: 'notes-two' })
	await expect(load('notes-two')).resolves.toEqual({
		kind: 'redirect',
		to: '/@owner/notes',
		shared: true,
	})

	mockModule.readAuthenticatedAppUser.mockResolvedValue(ownerUser)
	resolvesTo('package', listingLag)
	await expect(load()).resolves.toEqual({
		kind: 'redirect',
		to: '/@owner/notes-two',
		shared: false,
	})
})

test('loadPackagePage tells a signed-in non-owner they lack access to a private package', async () => {
	setProfileVisibility('private')
	mockModule.loadCommunityDetailData.mockResolvedValue(null)
	mockModule.loadAccountPackageDetail.mockClear()
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		email: 'guest@example.com',
		username: 'guest',
		mcpUser: { userId: ownerIdFromStored('guest-1'), username: 'guest' },
	})
	resolvesTo('package', pkg({ isPrivate: true, name: '@owner/notes' }))
	expect(await load()).toEqual({
		kind: 'no_access',
		username: 'owner',
		kodyId: 'notes',
		packageName: '@owner/notes',
		viewerUsername: 'guest',
	})
	expect(mockModule.loadAccountPackageDetail).not.toHaveBeenCalled()
})

test('ownerPackageForClient strips plain-repo sourceId for guests', async () => {
	const { ownerPackageForClient } = await import('#app/package-page.ts')
	const ownerPackage = {
		...ownerPackageDetail,
		sourceId: 'src-secret',
	} as AccountPackageDetail
	expect(
		ownerPackageForClient({
			ownerPackage,
			hasPackage: false,
			viewerIsOwner: false,
		})?.sourceId,
	).toBe('')
	expect(
		ownerPackageForClient({
			ownerPackage,
			hasPackage: false,
			viewerIsOwner: true,
		})?.sourceId,
	).toBe('src-secret')
	expect(
		ownerPackageForClient({
			ownerPackage,
			hasPackage: true,
			viewerIsOwner: false,
		})?.sourceId,
	).toBe('src-secret')
})

test('loadPackagePage retries transient D1 export locks then remaps exhaustion (KODY-B7)', async () => {
	const d1Export = new Error(
		'D1_ERROR: Currently processing a long-running export.',
	)
	setProfileVisibility('public')
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.loadCommunityDetailData.mockResolvedValue(listingDetail)

	mockModule.resolvePackagePageUrl
		.mockRejectedValueOnce(d1Export)
		.mockResolvedValueOnce({
			kind: 'package',
			username: 'owner',
			kodyId: 'notes',
			userId: ownerIdFromStored('owner-1'),
			listingId: 'listing-1',
			savedPackage: { id: 'pkg-1', hidden: false, isPrivate: false },
		})

	vi.useFakeTimers()
	try {
		const retrying = loadPackagePage({
			env,
			request: new Request('https://example.com/@owner/notes?retry=1'),
			username: 'owner',
			kodyId: 'notes',
		})
		await vi.advanceTimersByTimeAsync(d1LockRetryBaseDelayMs)
		await expect(retrying).resolves.toMatchObject({
			kind: 'page',
			listing: { listing: { id: 'listing-1' } },
		})
		expect(mockModule.resolvePackagePageUrl).toHaveBeenCalledTimes(2)
	} finally {
		vi.useRealTimers()
	}

	mockModule.resolvePackagePageUrl.mockReset()
	mockModule.resolvePackagePageUrl.mockRejectedValue(d1Export)
	vi.useFakeTimers()
	try {
		const exhausted = loadPackagePage({
			env,
			request: new Request('https://example.com/@owner/notes?retry=2'),
			username: 'owner',
			kodyId: 'notes',
		})
		const expectRejected = expect(exhausted).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof Error &&
				error.message === transientDatabaseUnavailableMessage &&
				error.cause === d1Export,
		)
		for (let attempt = 1; attempt < d1LockRetryMaxAttempts; attempt++) {
			await vi.advanceTimersByTimeAsync(
				d1LockRetryBaseDelayMs * 2 ** (attempt - 1),
			)
		}
		await expectRejected
		expect(mockModule.resolvePackagePageUrl).toHaveBeenCalledTimes(
			d1LockRetryMaxAttempts,
		)
	} finally {
		vi.useRealTimers()
	}
})
