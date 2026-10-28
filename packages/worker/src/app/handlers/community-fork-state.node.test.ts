import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import {
	acquireCommunityForkClaim,
	releaseCommunityForkClaim,
} from '#worker/community/fork-claims.ts'

const mocks = vi.hoisted(() => ({
	findExistingCommunityFork: vi.fn(),
	getSavedPackageById: vi.fn(),
	getPackageScopeByUserId: vi.fn(async () => 'viewer'),
}))
vi.mock('#worker/community/service.ts', () => ({
	findExistingCommunityFork: mocks.findExistingCommunityFork,
}))
vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: mocks.getSavedPackageById,
}))
vi.mock('#worker/package-registry/user-scope.ts', () => ({
	getPackageScopeByUserId: mocks.getPackageScopeByUserId,
}))

const { loadWebsiteCommunityForkState } =
	await import('./community-fork-state.ts')

const ownerId = 'a'.repeat(64)
const user = {
	mcpUser: { userId: ownerIdFromStored(ownerId) },
} as unknown as Parameters<typeof loadWebsiteCommunityForkState>[0]['user']

const fork = {
	id: 'fork-1',
	listingId: 'listing-1',
	forkerUserId: ownerId,
	originCommit: 'commit-1',
	forkedPackageId: 'package-1',
	forkedSourceId: 'source-1',
	targetKodyId: 'demo',
	createdAt: '2026-10-23T18:50:00.000Z',
	adoptedAt: null,
	adoptionNote: null,
}

test('fork state follows a fork from in progress to installed so a return visit never offers a second fork', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	const env = { APP_DB: createD1FromSqlite(sqlite) } as Env
	const read = () =>
		loadWebsiteCommunityForkState({ env, user, listingId: 'listing-1' })

	mocks.findExistingCommunityFork.mockResolvedValue(null)
	mocks.getSavedPackageById.mockResolvedValue(null)
	expect(await read()).toEqual({ state: 'none' })

	// The viewer clicked Fork, then navigated away while it ran.
	const claimId = await acquireCommunityForkClaim(env.APP_DB, {
		ownerId,
		listingId: 'listing-1',
	})
	expect(await read()).toEqual({
		state: 'in_progress',
		startedAt: expect.any(String),
	})

	// Install wrote the fork row but has not published yet: still in progress.
	mocks.findExistingCommunityFork.mockResolvedValue(fork)
	expect((await read()).state).toBe('in_progress')

	// Finished and published.
	await releaseCommunityForkClaim(env.APP_DB, {
		ownerId,
		listingId: 'listing-1',
		claimId: claimId!,
	})
	mocks.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		name: '@viewer/demo',
		sourceId: 'source-1',
	})
	expect(await read()).toEqual({
		state: 'installed',
		targetName: '@viewer/demo',
		href: '/@viewer/demo',
	})

	// An inert fork (checks failed) still links to the fork, never Fork again.
	mocks.getSavedPackageById.mockResolvedValue(null)
	expect(await read()).toEqual({
		state: 'adaptation_required',
		targetName: '@viewer/demo',
		href: '/@viewer/demo',
	})
})

test('fork state reads the picked org, so a personal fork does not mark another org as installed', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../../migrations/', import.meta.url))
	const env = { APP_DB: createD1FromSqlite(sqlite) } as Env
	const teamOwnerId = ownerIdFromStored('b'.repeat(64))
	mocks.findExistingCommunityFork.mockImplementation(
		async (input: { userId: string }) =>
			input.userId === ownerId ? fork : null,
	)
	mocks.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		name: '@viewer/demo',
		sourceId: 'source-1',
	})

	expect(
		await loadWebsiteCommunityForkState({
			env,
			user,
			listingId: 'listing-1',
			ownerId: teamOwnerId,
		}),
	).toEqual({ state: 'none' })
	expect(mocks.findExistingCommunityFork).toHaveBeenLastCalledWith(
		expect.objectContaining({ userId: teamOwnerId }),
	)

	// A fork still being created in the picked org shows as in progress there.
	await acquireCommunityForkClaim(env.APP_DB, {
		ownerId: teamOwnerId,
		listingId: 'listing-1',
	})
	expect(
		(
			await loadWebsiteCommunityForkState({
				env,
				user,
				listingId: 'listing-1',
				ownerId: teamOwnerId,
			})
		).state,
	).toBe('in_progress')

	// Omitting the org still reads the personal fork.
	expect(
		(await loadWebsiteCommunityForkState({ env, user, listingId: 'listing-1' }))
			.state,
	).toBe('installed')
})
