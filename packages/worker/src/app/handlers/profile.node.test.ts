import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { loadProfileData } from '#app/profile-data.ts'
import { loadProfile } from '../../../start/server/public-data.ts'
import {
	toProfileShellLoaderData,
	toProfileListLoaderData,
} from '#universal/loader-data.ts'
import { type CommunityProfileRecord } from '#worker/community/types.ts'

const alicePersonId = 'stable-alice'
const aliceOrgId = 'org-alice-personal'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	getCommunityProfileByUsername: vi.fn(),
	getCommunityTeamOrgProfileBySlug: vi.fn(),
	getProfileActivity: vi.fn(),
	listProfileRepositories: vi.fn(),
	listOrganizationsForPerson: vi.fn(),
	findPublicOwnerIdentityByHandle: vi.fn(),
	loadOrgBindingForOrg: vi.fn(),
	computeEffectivePermissions: vi.fn(),
	canSeeResource: vi.fn(),
	checkPermission: vi.fn(),
}))

vi.mock('#worker/orgs/repo.ts', () => ({
	listOrganizationsForPerson: (...args: Array<unknown>) =>
		mockModule.listOrganizationsForPerson(...args),
	loadOrgBindingForOrg: (...args: Array<unknown>) =>
		mockModule.loadOrgBindingForOrg(...args),
}))

vi.mock('#worker/identity/user-lookup.ts', () => ({
	findPublicOwnerIdentityByHandle: (...args: Array<unknown>) =>
		mockModule.findPublicOwnerIdentityByHandle(...args),
}))

vi.mock('#worker/authorization/authorize.ts', () => ({
	computeEffectivePermissions: (...args: Array<unknown>) =>
		mockModule.computeEffectivePermissions(...args),
	canSeeResource: (...args: Array<unknown>) =>
		mockModule.canSeeResource(...args),
	checkPermission: (...args: Array<unknown>) =>
		mockModule.checkPermission(...args),
	packageResource: (input: { id: string; userId: string; label?: string }) => ({
		type: 'package',
		id: input.id,
		orgId: input.userId,
		label: input.label,
	}),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/profile-service.ts', () => ({
	getCommunityProfileByUsername: (...args: Array<unknown>) =>
		mockModule.getCommunityProfileByUsername(...args),
	getCommunityTeamOrgProfileBySlug: (...args: Array<unknown>) =>
		mockModule.getCommunityTeamOrgProfileBySlug(...args),
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
	userId: ownerIdFromStored(alicePersonId),
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

function setupPublicProfileMocks() {
	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	mockModule.getCommunityProfileByUsername.mockResolvedValue(publicProfile)
	mockModule.getCommunityTeamOrgProfileBySlug.mockResolvedValue(null)
	mockModule.listProfileRepositories.mockResolvedValue(packageFixture)
	mockModule.getProfileActivity.mockResolvedValue(activityFixture)
	mockModule.findPublicOwnerIdentityByHandle.mockResolvedValue({
		handle: 'alice',
		ownerId: ownerIdFromStored(aliceOrgId),
	})
	mockModule.loadOrgBindingForOrg.mockResolvedValue(null)
	mockModule.computeEffectivePermissions.mockResolvedValue({
		isOwner: false,
		permissions: new Set(),
	})
	mockModule.canSeeResource.mockReturnValue(false)
	mockModule.checkPermission.mockReturnValue({ allowed: false })
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
	expect(guest.body).toMatchObject({
		ok: true,
		profile: { displayName: 'Alice' },
		isSelf: false,
		loggedIn: false,
	})
	expect(lastPackagesQuery()).toMatchObject({
		ownerStableUserId: aliceOrgId,
		ownerUsername: 'alice',
		includePrivate: false,
	})
	expect(lastPackagesQuery()).not.toHaveProperty('limit')

	const guestFilter = await call(
		'/profiles/alice.json?visibility=private&listing=published&hidden=yes',
	)
	expect(guestFilter.status).toBe(200)
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

	mockModule.getCommunityProfileByUsername.mockResolvedValueOnce(null)
	const unknown = await call('/profiles/missing.json', 'missing')
	expect(unknown.status).toBe(404)

	// Own private profile is visible to self, including private packages.
	// Inventory is keyed by personal org id (distinct from person id).
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		userId: 1,
		mcpUser: { userId: ownerIdFromStored(alicePersonId) },
	})
	mockModule.loadOrgBindingForOrg.mockResolvedValue({
		org: { id: ownerIdFromStored(aliceOrgId), slug: 'alice' },
		role: 'owner',
	})
	mockModule.computeEffectivePermissions.mockResolvedValue({
		isOwner: true,
		permissions: new Set(),
	})
	mockModule.canSeeResource.mockReturnValue(true)
	mockModule.checkPermission.mockReturnValue({ allowed: true })
	mockModule.listProfileRepositories.mockResolvedValue([])
	mockModule.getProfileActivity.mockResolvedValue([])
	const own = await call(
		'/profiles/alice.json?visibility=private&listing=ahead&hidden=yes',
	)
	expect(own.status).toBe(200)
	expect(own.body).toMatchObject({
		ok: true,
		isSelf: true,
		profile: { visibility: 'private' },
	})
	expect(lastPackagesQuery()).toMatchObject({
		ownerStableUserId: aliceOrgId,
		includePrivate: true,
	})
})

test('profile page shell embeds the person and the unfiltered package list, or 404s when unavailable', async () => {
	setupPublicProfileMocks()
	const page = await nativeProfile('alice')
	if (!page.data) throw new Error('Expected public profile')
	expect(toProfileShellLoaderData(page.data)).toMatchObject({
		ok: true,
		username: 'alice',
		isSelf: false,
		visibility: 'public',
	})
	expect(toProfileListLoaderData(page.data)).toMatchObject({
		profile: {
			username: 'alice',
			visibility: 'public',
		},
		packages: [expect.objectContaining({ name: '@alice/helper' })],
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
	})
	const collaborator = await nativeProfile('globex')
	expect(collaborator).toMatchObject({
		data: null,
		orgHome: { slug: 'globex', role: null },
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
		ownerStableUserId: aliceOrgId,
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
		ownerStableUserId: aliceOrgId,
	})
	expect(mockModule.readAuthenticatedAppUser).toHaveBeenLastCalledWith(
		request,
		env,
		undefined,
	)
})

const acmeOrgId = 'org-acme-team'

function teamOrgProfile(visibility: 'public' | 'private') {
	return {
		orgId: ownerIdFromStored(acmeOrgId),
		slug: 'acme-team',
		displayName: 'Acme Team',
		bio: 'We build helpers.',
		avatarKey: null,
		visibility,
		joinedAt: '2026-02-01T00:00:00.000Z',
		publicPackageCount: 1,
		listingCount: 1,
	}
}

const teamOrgPackages = [
	{
		...packageFixture[0]!,
		packageId: 'pkg-public',
		name: '@acme-team/open-helper',
		kodyId: 'open-helper',
	},
	// The public-only SQL path already drops these; the page filters again.
	{
		...packageFixture[0]!,
		packageId: 'pkg-private',
		name: '@acme-team/secret-plans',
		kodyId: 'secret-plans',
		isPrivate: true,
	},
	{
		...packageFixture[0]!,
		packageId: 'pkg-hidden',
		name: '@acme-team/hidden-tool',
		kodyId: 'hidden-tool',
		hidden: true,
	},
]

function setupTeamOrgMocks(visibility: 'public' | 'private') {
	setupPublicProfileMocks()
	mockModule.getCommunityProfileByUsername.mockResolvedValue(null)
	mockModule.getCommunityTeamOrgProfileBySlug.mockResolvedValue(
		teamOrgProfile(visibility),
	)
	mockModule.listProfileRepositories.mockResolvedValue(teamOrgPackages)
	mockModule.getProfileActivity.mockClear()
	mockModule.listOrganizationsForPerson.mockResolvedValue([])
	native.setResponseHeader.mockClear()
}

function signIn(organizations: Array<Record<string, unknown>>) {
	mockModule.readAuthenticatedAppUser.mockResolvedValue({
		userId: 1,
		mcpUser: { userId: ownerIdFromStored('stable-alice') },
	})
	mockModule.listOrganizationsForPerson.mockResolvedValue([
		{ slug: 'alice', displayName: null, role: 'owner', personal: true },
		...organizations,
	])
}

test('a public team org page shows only public, non-hidden packages and no members or activity to a signed-out visitor', async () => {
	setupTeamOrgMocks('public')
	const page = await nativeProfile('acme-team')
	expect(page.orgHome).toBeNull()
	expect(page.data).toMatchObject({
		ownerKind: 'org',
		isSelf: false,
		loggedIn: false,
		activity: null,
		profile: {
			username: 'acme-team',
			displayName: 'Acme Team',
			bio: 'We build helpers.',
			visibility: 'public',
		},
	})
	expect(page.data?.packages.map((pkg) => pkg.name)).toEqual([
		'@acme-team/open-helper',
	])
	expect(lastPackagesQuery()).toMatchObject({
		ownerStableUserId: acmeOrgId,
		ownerUsername: 'acme-team',
		includePrivate: false,
	})
	expect(mockModule.getProfileActivity).not.toHaveBeenCalled()
	const serialized = JSON.stringify(page)
	expect(serialized).not.toContain('secret-plans')
	expect(serialized).not.toContain('hidden-tool')
	expect(serialized).not.toMatch(/members|"role"/)
	expect(native.setResponseHeader).not.toHaveBeenCalledWith(
		'Cache-Control',
		'no-store',
	)
	expect(native.setResponseHeader).not.toHaveBeenCalledWith(
		'Set-Cookie',
		expect.anything(),
	)
})

test('a private team org 404s exactly like an unknown handle for visitors and non-members', async () => {
	setupTeamOrgMocks('private')
	const privateError = await nativeProfile('acme-team').catch(
		(error: unknown) => error,
	)
	mockModule.getCommunityTeamOrgProfileBySlug.mockResolvedValue(null)
	const missingError = await nativeProfile('nobody-here').catch(
		(error: unknown) => error,
	)
	expect(privateError).toMatchObject({ isNotFound: true })
	expect(Object.keys(privateError as object).sort()).toEqual(
		Object.keys(missingError as object).sort(),
	)
	expect(mockModule.listProfileRepositories).not.toHaveBeenCalledWith(
		expect.objectContaining({ ownerUsername: 'acme-team' }),
	)

	setupTeamOrgMocks('private')
	signIn([
		{ slug: 'globex', displayName: 'Globex', role: 'member', personal: false },
	])
	await expect(nativeProfile('acme-team')).rejects.toMatchObject({
		isNotFound: true,
	})
})

test('members of a private team org still get the org home', async () => {
	setupTeamOrgMocks('private')
	signIn([
		{
			slug: 'acme-team',
			displayName: 'Acme Team',
			role: 'member',
			personal: false,
		},
	])
	const page = await nativeProfile('acme-team')
	expect(page).toMatchObject({
		data: null,
		orgHome: { slug: 'acme-team', role: 'member' },
	})
	expect(native.setResponseHeader).toHaveBeenCalledWith(
		'Cache-Control',
		'no-store',
	)
})

test('members of a public team org get the public page plus their org home; other signed-in people get only the public page', async () => {
	setupTeamOrgMocks('public')
	signIn([
		{
			slug: 'acme-team',
			displayName: 'Acme Team',
			role: 'owner',
			personal: false,
		},
	])
	const member = await nativeProfile('acme-team')
	expect(member.orgHome).toMatchObject({ slug: 'acme-team', role: 'owner' })
	expect(member.data).toMatchObject({ ownerKind: 'org', loggedIn: true })
	expect(member.data?.packages.map((pkg) => pkg.name)).toEqual([
		'@acme-team/open-helper',
	])
	expect(lastPackagesQuery()).toMatchObject({ includePrivate: false })
	expect(native.setResponseHeader).toHaveBeenCalledWith(
		'Cache-Control',
		'no-store',
	)

	setupTeamOrgMocks('public')
	signIn([])
	const outsider = await nativeProfile('acme-team')
	expect(outsider.orgHome).toBeNull()
	expect(outsider.data).toMatchObject({ ownerKind: 'org', loggedIn: true })
	expect(outsider.data?.packages.map((pkg) => pkg.name)).toEqual([
		'@acme-team/open-helper',
	])
})

test('a person handle never falls through to the team org lookup', async () => {
	setupPublicProfileMocks()
	mockModule.getCommunityTeamOrgProfileBySlug.mockClear()
	const page = await nativeProfile('alice')
	expect(page.data?.ownerKind).toBeUndefined()
	expect(mockModule.getCommunityTeamOrgProfileBySlug).not.toHaveBeenCalled()
})
