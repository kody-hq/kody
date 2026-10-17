import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { loadProfileData } from '#app/profile-data.ts'
import { loadProfile } from '../../../start/server/public-data.ts'
import {
	toProfileShellLoaderData,
	toProfileListLoaderData,
} from '#universal/loader-data.ts'
import { type CommunityProfileRecord } from '#worker/community/types.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	getCommunityProfileByUsername: vi.fn(),
	getProfileActivity: vi.fn(),
	listProfileRepositories: vi.fn(),
	listOrganizationsForPerson: vi.fn(),
}))

vi.mock('#worker/orgs/repo.ts', () => ({
	listOrganizationsForPerson: (...args: Array<unknown>) =>
		mockModule.listOrganizationsForPerson(...args),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/profile-service.ts', () => ({
	getCommunityProfileByUsername: (...args: Array<unknown>) =>
		mockModule.getCommunityProfileByUsername(...args),
	getProfileActivity: (...args: Array<unknown>) =>
		mockModule.getProfileActivity(...args),
	listProfileRepositories: (...args: Array<unknown>) =>
		mockModule.listProfileRepositories(...args),
}))

const native = vi.hoisted(() => ({
	env: {} as Env,
	request: new Request('https://example.com/login'),
	setResponseHeader: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerOnlyFn: <T>(fn: T) => fn,
	createServerFn: () => {
		let validate = (data: unknown) => data
		const builder = {
			validator: (fn: typeof validate | { parse(data: unknown): unknown }) => {
				validate = typeof fn === 'function' ? fn : (data) => fn.parse(data)
				return builder
			},
			handler:
				(fn: (input: { data: unknown }) => unknown) =>
				(input: { data: unknown }) =>
					fn({ data: validate(input.data) }),
		}
		return builder
	},
}))
vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	get env() {
		return native.env
	},
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => native.request,
	setResponseHeader: native.setResponseHeader,
}))
vi.mock('#app/env.ts', () => ({ getEnv: () => native.env }))

vi.mock('#app/session-info.ts', () => ({
	loadSessionInfo: async () => ({
		session: { organizations: await mockModule.listOrganizationsForPerson() },
		setCookie: undefined,
	}),
}))
async function nativeProfile(username: string) {
	native.env = {
		COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
	} as Env
	native.request = new Request(`https://example.com/@${username}`)
	return loadProfile({ data: { username, query: '' } })
}

const publicProfile = {
	userId: ownerIdFromStored('stable-alice'),
	username: 'alice',
	displayName: 'Alice',
	bio: 'Hello',
	avatarKey: null,
	visibility: 'public',
	joinedAt: '2026-01-01T00:00:00.000Z',
	publicPackageCount: 1,
	listingCount: 1,
} satisfies CommunityProfileRecord

const packageFixture = [
	{
		packageId: 'pkg-1',
		name: '@alice/helper',
		kodyId: 'helper',
		description: 'Helpful package',
		tags: ['tools'],
		updatedAt: '2026-07-01T00:00:00.000Z',
		createdAt: '2026-06-01T00:00:00.000Z',
		communityListingId: 'listing-1',
		communityListingKodyId: 'helper',
		communityPublishedAt: '2026-07-01T00:00:00.000Z',
		needsRepublish: false,
		hasPackage: true,
		hasApp: false,
		webhookCount: 0,
		jobCount: 0,
		isPrivate: false,
		isInternetVisible: false,
		hidden: false,
		publishedCommit: 'abc1234567890',
		listingIconCommit: 'abc1234567890',
		repoIconCommit: null,
	},
]

const activityFixture = [
	{
		type: 'listing_published' as const,
		actorUserId: 'stable-alice',
		actorUsername: 'alice',
		actorDisplayName: 'Alice',
		actorAvatarKey: null,
		listingId: 'listing-1',
		listingName: '@alice/helper',
		listingKodyId: 'helper',
		createdAt: '2026-07-01T00:00:00.000Z',
	},
]

type ProfileResponseBody = {
	ok: boolean
	query?: string | null
	packages?: Array<unknown>
	activity?: Array<unknown>
	loaderData?: { profileShell?: unknown; profileList?: unknown }
}

const env = {} as Env
const apiKeys = [
	'activity',
	'isSelf',
	'loggedIn',
	'ok',
	'packages',
	'profile',
	'query',
]

function setupPublicProfileMocks() {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.getCommunityProfileByUsername.mockResolvedValue(publicProfile)
	mockModule.listProfileRepositories.mockResolvedValue(packageFixture)
	mockModule.getProfileActivity.mockResolvedValue(activityFixture)
}

async function call(path: string, username = 'alice') {
	mockModule.listProfileRepositories.mockClear()
	const url = new URL(`https://example.com${path}`)
	const data = await loadProfileData(
		env,
		new Request(url),
		username,
		undefined,
		{
			query: url.searchParams.get('q')?.trim() ?? '',
			limit: (() => {
				const value = Number.parseInt(url.searchParams.get('limit') ?? '', 10)
				return Number.isFinite(value) && value > 0
					? Math.min(100, value)
					: undefined
			})(),
		},
	)
	return {
		status: data ? 200 : 404,
		body: (data ?? {
			ok: false,
			error: "This profile isn't available.",
		}) as ProfileResponseBody,
	}
}

function lastPackagesQuery() {
	return mockModule.listProfileRepositories.mock.calls.at(-1)?.[0]
}

test('profile API respects visibility, ignores owner-only filters for guests, and forwards search limits', async () => {
	setupPublicProfileMocks()
	const guest = await call('/profiles/alice.json')
	expect(guest.status).toBe(200)
	expect(Object.keys(guest.body).sort()).toEqual(apiKeys)
	expect(guest.body).toMatchObject({
		ok: true,
		profile: { displayName: 'Alice' },
		packages: [{ iconUrl: '/community/listing-1/icon/abc1234567890' }],
		isSelf: false,
		loggedIn: false,
	})
	expect(guest.body.packages).toHaveLength(1)
	expect(guest.body.activity).toHaveLength(1)
	expect(lastPackagesQuery()).toMatchObject({
		ownerStableUserId: 'stable-alice',
		ownerUsername: 'alice',
		includePrivate: false,
	})
	expect(lastPackagesQuery()).not.toHaveProperty('limit')

	const guestFilter = await call(
		'/profiles/alice.json?visibility=private&listing=published&hidden=yes',
	)
	expect(guestFilter.status).toBe(200)
	expect(Object.keys(guestFilter.body).sort()).toEqual(apiKeys)
	expect(lastPackagesQuery()).toMatchObject({ includePrivate: false })

	const search = await call('/profiles/alice.json?q=helper')
	expect(search.status).toBe(200)
	expect(search.body.query).toBe('helper')
	expect(search.body.packages).toHaveLength(1)
	expect(lastPackagesQuery()).toMatchObject({ includePrivate: false })
	expect(lastPackagesQuery()).not.toHaveProperty('query')

	const capped = await call('/profiles/alice.json?q=helper&limit=10')
	expect(capped.status).toBe(200)
	expect(lastPackagesQuery()).toMatchObject({
		includePrivate: false,
		query: 'helper',
		limit: 10,
	})

	mockModule.getCommunityProfileByUsername.mockResolvedValue({
		...publicProfile,
		visibility: 'private',
	})
	const hidden = await call('/profiles/alice.json')
	expect(hidden.status).toBe(404)
	expect(hidden.body.ok).toBe(false)

	mockModule.getCommunityProfileByUsername.mockResolvedValueOnce(null)
	const unknown = await call('/profiles/missing.json', 'missing')
	expect(unknown.status).toBe(404)

	// Own private profile is visible to self, including private packages.
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		userId: 1,
		mcpUser: { userId: ownerIdFromStored('stable-alice') },
	})
	mockModule.listProfileRepositories.mockResolvedValue([])
	mockModule.getProfileActivity.mockResolvedValue([])
	const own = await call(
		'/profiles/alice.json?visibility=private&listing=ahead&hidden=yes',
	)
	expect(own.status).toBe(200)
	expect(Object.keys(own.body).sort()).toEqual(apiKeys)
	expect(own.body).toMatchObject({
		ok: true,
		isSelf: true,
		profile: { visibility: 'private' },
	})
	expect(lastPackagesQuery()).toMatchObject({
		ownerStableUserId: 'stable-alice',
		includePrivate: true,
	})
})

test('profile page shell embeds the person and the unfiltered package list, or 404s when unavailable', async () => {
	setupPublicProfileMocks()
	const page = await nativeProfile('alice')
	if (!page.data) throw new Error('Expected public profile')
	expect(toProfileShellLoaderData(page.data)).toEqual({
		ok: true,
		username: 'alice',
		displayName: 'Alice',
		bio: 'Hello',
		avatarUrl: null,
		joinedAt: '2026-01-01T00:00:00.000Z',
		isSelf: false,
		loggedIn: false,
		visibility: 'public',
	})
	expect(toProfileListLoaderData(page.data)).toEqual({
		profile: {
			username: 'alice',
			displayName: 'Alice',
			bio: 'Hello',
			avatarUrl: null,
			visibility: 'public',
			joinedAt: '2026-01-01T00:00:00.000Z',
			publicPackageCount: 1,
			listingCount: 1,
		},
		packages: [
			{
				name: '@alice/helper',
				kodyId: 'helper',
				description: 'Helpful package',
				tags: ['tools'],
				updatedAt: '2026-07-01T00:00:00.000Z',
				createdAt: '2026-06-01T00:00:00.000Z',
				communityListingId: 'listing-1',
				communityListingKodyId: 'helper',
				communityPublishedAt: '2026-07-01T00:00:00.000Z',
				needsRepublish: false,
				hasPackage: true,
				hasApp: false,
				webhookCount: 0,
				jobCount: 0,
				iconUrl: '/community/listing-1/icon/abc1234567890',
			},
		],
		activity: [
			{
				type: 'listing_published',
				actorUsername: 'alice',
				actorDisplayName: 'Alice',
				actorAvatarUrl: null,
				listingId: 'listing-1',
				listingName: '@alice/helper',
				listingKodyId: 'helper',
				createdAt: '2026-07-01T00:00:00.000Z',
			},
		],
	})

	mockModule.getCommunityProfileByUsername.mockResolvedValue(null)
	mockModule.listOrganizationsForPerson.mockResolvedValue([])
	await expect(nativeProfile('missing')).rejects.toMatchObject({
		isNotFound: true,
	})
})

test('an organization handle is a home for everyone its switcher lists and a 404 for everyone else', async () => {
	setupPublicProfileMocks()
	mockModule.getCommunityProfileByUsername.mockResolvedValue(null)
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		userId: 1,
		mcpUser: { userId: ownerIdFromStored('stable-alice') },
	})
	mockModule.listOrganizationsForPerson.mockResolvedValue([
		{ slug: 'alice', displayName: null, role: 'owner', personal: true },
		{ slug: 'acme', displayName: 'Acme', role: 'member', personal: false },
		{ slug: 'globex', displayName: 'Globex', role: null, personal: false },
	])

	const member = await nativeProfile('acme')
	expect(member).toMatchObject({
		data: null,
		orgHome: { slug: 'acme', role: 'member' },
		head: { title: 'Acme' },
	})
	const collaborator = await nativeProfile('globex')
	expect(collaborator).toMatchObject({
		data: null,
		orgHome: { slug: 'globex', role: null },
		head: { title: 'Globex' },
	})
	await expect(nativeProfile('zeta')).rejects.toMatchObject({
		isNotFound: true,
	})
})

test('organization homes and public profiles never remember an org in a cookie', async () => {
	setupPublicProfileMocks()
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		userId: 1,
		mcpUser: { userId: ownerIdFromStored('stable-alice') },
	})
	mockModule.listOrganizationsForPerson.mockResolvedValue([
		{ slug: 'alice', displayName: null, role: 'owner', personal: true },
		{ slug: 'acme', displayName: 'Acme', role: 'member', personal: false },
	])
	native.setResponseHeader.mockClear()
	await nativeProfile('alice')
	expect(native.setResponseHeader).not.toHaveBeenCalledWith(
		'Set-Cookie',
		expect.anything(),
	)
	mockModule.getCommunityProfileByUsername.mockResolvedValue(null)
	await nativeProfile('acme')
	expect(native.setResponseHeader).not.toHaveBeenCalledWith(
		'Set-Cookie',
		expect.anything(),
	)
	native.setResponseHeader.mockClear()
	await expect(nativeProfile('zeta')).rejects.toMatchObject({
		isNotFound: true,
	})
	expect(native.setResponseHeader).not.toHaveBeenCalledWith(
		'Set-Cookie',
		expect.anything(),
	)
})

test('explicit repository filters ignore RPC URL state and remain distinct in the request cache', async () => {
	setupPublicProfileMocks()
	const request = new Request(
		'https://example.com/_serverFn/profile?q=wrong&limit=99',
	)
	const first = await loadProfileData(env, request, 'alice', undefined, {
		query: 'first',
		limit: 2,
	})
	expect(first?.query).toBe('first')
	expect(lastPackagesQuery()).toMatchObject({
		query: 'first',
		limit: 2,
		includePrivate: false,
	})
	const second = await loadProfileData(env, request, 'alice', undefined, {
		query: 'second',
		limit: 3,
	})
	expect(second?.query).toBe('second')
	expect(lastPackagesQuery()).toMatchObject({
		query: 'second',
		limit: 3,
		includePrivate: false,
	})
	expect(mockModule.readAuthenticatedAppUser).toHaveBeenLastCalledWith(
		request,
		env,
		undefined,
	)
})
