import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { beforeEach, expect, test, vi } from 'vitest'
import { type CommunityForkListRow } from '#worker/community/repo.ts'

const state = vi.hoisted(() => ({
	publicForks: [] as Array<CommunityForkListRow>,
	publicCount: 0,
	candidates: [] as Array<CommunityForkListRow>,
	readable: new Set<string>(),
}))
vi.mock('#worker/community/repo.ts', () => ({
	listPublicCommunityForks: async () => state.publicForks,
	countCommunityForksByListingIds: async (_: unknown, ids: Array<string>) =>
		Object.fromEntries(ids.map((id) => [id, state.publicCount])),
	listPrivateCommunityForkCandidatesForPerson: async () => state.candidates,
}))
vi.mock('#app/package-viewer-access.ts', () => ({
	viewerCanReadSavedPackage: async (input: { packageId: string }) =>
		state.readable.has(input.packageId),
}))

const { loadVisibleCommunityForks } = await import('./community-forks-data.ts')

function fork(
	id: string,
	createdAt: string,
	isPrivate: boolean,
): CommunityForkListRow {
	return {
		forkId: id,
		createdAt,
		packageId: `pkg-${id}`,
		kodyId: 'ship-pr',
		description: '',
		isPrivate,
		ownerId: `org-${id}`,
		ownerSlug: id,
		ownerDisplayName: null,
		ownerAvatarKey: null,
		publishedCommit: null,
	}
}

const env = { APP_DB: {} } as Env
const viewer = { userId: personIdFromStored('person-1'), username: 'viewer' }

beforeEach(() => {
	state.publicForks = [fork('alice', '2026-10-01', false)]
	state.publicCount = 1
	state.candidates = [
		fork('mine', '2026-10-03', true),
		fork('notmine', '2026-10-02', true),
	]
	state.readable = new Set(['pkg-mine'])
})

test('anonymous visitors only see public forks', async () => {
	const result = await loadVisibleCommunityForks({
		env,
		listingId: 'listing-1',
		viewer: null,
	})
	expect(result.total).toBe(1)
	expect(result.forks.map((item) => item.name)).toEqual(['@alice/ship-pr'])
})

test('signed-in viewers also see private forks they can read, newest first', async () => {
	const result = await loadVisibleCommunityForks({
		env,
		listingId: 'listing-1',
		viewer,
	})
	expect(result.total).toBe(2)
	expect(
		result.forks.map((item) => [item.name, item.href, item.isPrivate]),
	).toEqual([
		['@mine/ship-pr', '/@mine/ship-pr', true],
		['@alice/ship-pr', '/@alice/ship-pr', false],
	])
})
