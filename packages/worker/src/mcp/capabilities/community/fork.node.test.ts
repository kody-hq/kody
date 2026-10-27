import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mocks = vi.hoisted(() => ({
	forkCommunityListing: vi.fn(),
	authorizePackageCreate: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	forkCommunityListing: (...args: Array<unknown>) =>
		mocks.forkCommunityListing(...args),
}))

vi.mock('#worker/authorization/authorize.ts', async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>()
	return {
		...actual,
		authorizePackageCreate: (...args: Array<unknown>) =>
			mocks.authorizePackageCreate(...args),
	}
})

const { communityForkCapability } = await import('./fork.ts')

const personId = 'a'.repeat(64)
const personalOrgIdValue = 'b'.repeat(64)

function createContext(user: { personalOrgId?: string }) {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl: 'https://example.com',
			executionOrigin: 'interactive',
			user: {
				userId: personIdFromStored(personId),
				...(user.personalOrgId
					? { personalOrgId: ownerIdFromStored(user.personalOrgId) }
					: {}),
				email: 'adwin@example.com',
				displayName: 'Adwin',
				username: 'adwin',
			},
		}),
	}
}

test('communityFork stores the fork under the personal org when it differs from the person id', async () => {
	mocks.forkCommunityListing.mockReset()
	mocks.authorizePackageCreate.mockReset()
	mocks.authorizePackageCreate.mockResolvedValue(undefined)
	mocks.forkCommunityListing.mockResolvedValue({
		forkId: 'fork-1',
		packageId: 'pkg-1',
		sourceId: 'source-1',
		targetKodyId: 'google',
		targetName: '@adwin/google',
		originCommit: 'commit-1',
		crossScopeReferences: [],
		filesCount: 3,
		files: {},
	})
	// New signups mint a personal org id distinct from the person id
	// (#3053). The fork must land in the org that packageList and
	// repoOpenSession read, not under the person id.
	await communityForkCapability.handler(
		{ listing_id: 'listing-1' },
		createContext({ personalOrgId: personalOrgIdValue }),
	)

	expect(mocks.forkCommunityListing).toHaveBeenCalledTimes(1)
	expect(mocks.forkCommunityListing).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: personalOrgIdValue,
			followerOrgId: personalOrgIdValue,
			creatorUserId: personId,
			expectedPackageScope: 'adwin',
			listingId: 'listing-1',
		}),
	)
})

test('communityFork keeps legacy equal-id personal orgs working', async () => {
	mocks.forkCommunityListing.mockReset()
	mocks.authorizePackageCreate.mockReset()
	mocks.authorizePackageCreate.mockResolvedValue(undefined)
	mocks.forkCommunityListing.mockResolvedValue({
		forkId: 'fork-1',
		packageId: 'pkg-1',
		sourceId: 'source-1',
		targetKodyId: 'google',
		targetName: '@adwin/google',
		originCommit: 'commit-1',
		crossScopeReferences: [],
		filesCount: 3,
		files: {},
	})
	await communityForkCapability.handler(
		{ listing_id: 'listing-1' },
		createContext({}),
	)

	expect(mocks.forkCommunityListing).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: personId,
			followerOrgId: personId,
			creatorUserId: personId,
			expectedPackageScope: 'adwin',
		}),
	)
})

test('communityFork returns an existing fork with already_forked and a message', async () => {
	mocks.forkCommunityListing.mockReset()
	mocks.authorizePackageCreate.mockReset()
	mocks.authorizePackageCreate.mockResolvedValue(undefined)
	mocks.forkCommunityListing.mockResolvedValue({
		forkId: 'fork-1',
		packageId: 'pkg-1',
		sourceId: 'source-1',
		targetKodyId: 'google',
		targetName: '@adwin/google',
		originCommit: 'commit-1',
		crossScopeReferences: [],
		filesCount: 0,
		files: {},
		alreadyForked: true,
		message: 'You already forked this listing as "@adwin/google".',
	})
	const result = await communityForkCapability.handler(
		{ listing_id: 'listing-1' },
		createContext({}),
	)
	expect(result).toMatchObject({
		fork_id: 'fork-1',
		package_id: 'pkg-1',
		already_forked: true,
		message: 'You already forked this listing as "@adwin/google".',
	})
	expect(result).not.toHaveProperty('files_count')

	mocks.forkCommunityListing.mockResolvedValue({
		forkId: 'fork-2',
		packageId: 'pkg-2',
		sourceId: 'source-2',
		targetKodyId: 'google-2',
		targetName: '@adwin/google-2',
		originCommit: 'commit-1',
		crossScopeReferences: [],
		filesCount: 3,
		files: {},
	})
	expect(
		await communityForkCapability.handler(
			{ listing_id: 'listing-1', kody_id: 'google-2' },
			createContext({}),
		),
	).toMatchObject({ files_count: 3, already_forked: false })
})
