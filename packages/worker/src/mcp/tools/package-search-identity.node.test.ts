import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	resolveSavedPackageRef: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	resolveSavedPackageRef: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackageRef(...args),
	getSavedPackageWithCommunityProvenanceById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	resolveSavedPackageRefWithCommunityProvenance: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackageRef(...args),
}))

const { parsePackageSearchIdentity, resolvePackageIdentitySearch } =
	await import('./package-search-identity.ts')

const packageId = '550e8400-e29b-41d4-a716-446655440000'

function createSavedPackage(input?: { hidden?: boolean; userId?: string }) {
	return {
		id: packageId,
		userId: input?.userId ?? 'user-1',
		kodyId: 'daily-notes',
		name: '@user/daily-notes',
		description: 'Daily notes package',
		tags: ['notes'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: true,
		hidden: input?.hidden ?? false,
		isPrivate: false,
		isInternetVisible: false,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-02T00:00:00.000Z',
	}
}

test('package identity parser accepts exact ids and current-origin URLs and rejects unsafe ones', () => {
	const common = { baseUrl: 'https://heykody.dev', username: 'user' }
	// Hosted package apps run on their own origin in production, so the URL a
	// user copies from the address bar is on that host.
	const hosted = {
		...common,
		packageAppBaseUrl: 'https://kody.run',
		packageAppLegacyHosts: 'kodyapps.dev',
	}
	const byId = { kind: 'package-id', value: packageId, authoritative: true }
	const byKodyId = {
		kind: 'kody-id',
		value: 'daily-notes',
		authoritative: true,
	}
	const notIdentity = { kind: 'not-package-identity' }
	const invalid = { kind: 'invalid-package-identity' }
	const cases: Array<
		[Partial<Parameters<typeof parsePackageSearchIdentity>[0]>, string, object]
	> = [
		[common, packageId, byId],
		[common, 'daily-notes', { ...byKodyId, authoritative: false }],
		[common, '@user/daily-notes', byKodyId],
		[common, '@other/daily-notes', notIdentity],
		[common, `/account/packages/${packageId}`, byId],
		[
			common,
			`https://heykody.dev/account/packages/${packageId}?tab=source#top`,
			byId,
		],
		[common, '/@user/packages/daily-notes', byKodyId],
		[common, 'https://heykody.dev/@user/packages/daily-notes', byKodyId],
		[common, 'find a package for daily notes', notIdentity],
		[hosted, 'https://kody.run/@user/packages/daily-notes', byKodyId],
		[hosted, 'https://kodyapps.dev/@user/packages/daily-notes', byKodyId],
		// A deep link inside a running app is not a package identity — unchanged
		// from how the app origin already treated `/@user/packages/x/<rest>`.
		[
			hosted,
			'https://kodyapps.dev/@user/packages/daily-notes/report?tab=1',
			notIdentity,
		],
		// The canonical hosted URL is the caller's per-user subdomain, where the
		// username lives in the hostname and the path carries only the mount.
		[hosted, 'https://user.kody.run/daily-notes?tab=source#top', byKodyId],
		[hosted, 'https://user.kodyapps.dev/daily-notes?tab=source#top', byKodyId],
		// Legacy `/packages/{kodyId}` subdomain mounts still resolve.
		[
			hosted,
			'https://user.kody.run/packages/daily-notes?tab=source#top',
			byKodyId,
		],
		[
			hosted,
			'https://user.kodyapps.dev/packages/daily-notes?tab=source#top',
			byKodyId,
		],
		[hosted, 'https://user.kodyapps.dev/daily-notes/report?tab=1', notIdentity],
		[
			hosted,
			'https://user.kodyapps.dev/packages/daily-notes/report?tab=1',
			notIdentity,
		],
		// Kody-owned first segments are never package identity.
		[hosted, 'https://user.kodyapps.dev/-', notIdentity],
		[hosted, 'https://user.kodyapps.dev/robots.txt', notIdentity],
		// Another user's subdomain, even for the same kody id.
		[hosted, 'https://other.kodyapps.dev/daily-notes', invalid],
		// Nested labels are never a user subdomain.
		[hosted, 'https://a.user.kodyapps.dev/daily-notes', invalid],
		// Embedded credentials stay refused on the subdomain form too.
		[hosted, 'https://user:password@user.kodyapps.dev/daily-notes', invalid],
		// Wrong scheme for the configured package-app origin.
		[hosted, 'http://user.kodyapps.dev/daily-notes', invalid],
		// The app origin keeps working, and relative URLs still resolve against it.
		[hosted, 'https://heykody.dev/@user/packages/daily-notes', byKodyId],
		[hosted, `/account/packages/${packageId}`, byId],
		// Another user's package, even on the package-app origin.
		[hosted, 'https://kodyapps.dev/@other/packages/daily-notes', invalid],
		// The package-app origin never serves account pages.
		[hosted, `https://kodyapps.dev/account/packages/${packageId}`, invalid],
		// Neighbouring hosts are not this deployment.
		[hosted, 'https://evil-kodyapps.dev/@user/packages/daily-notes', invalid],
		[
			hosted,
			'https://kodyapps.dev.attacker.example/@user/packages/daily-notes',
			invalid,
		],
		[
			hosted,
			'https://user:password@kodyapps.dev/@user/packages/daily-notes',
			invalid,
		],
		// Deployments that serve package apps inline (no separate origin) must
		// not start accepting that host.
		[common, 'https://kodyapps.dev/@user/packages/daily-notes', invalid],
		[
			{ ...common, packageAppBaseUrl: 'not-a-url' },
			'https://kodyapps.dev/@user/packages/daily-notes',
			invalid,
		],
		[common, `https://attacker.example/account/packages/${packageId}`, invalid],
		[common, 'https://attacker.example/@user/packages/daily-notes', invalid],
		[common, 'https://heykody.dev/account/packages/%E0%A4%A', invalid],
		[common, 'https://heykody.dev/@user/packages/%E0%A4%A', invalid],
		[common, 'https://heykody.dev/@other/packages/daily-notes', invalid],
		[common, '/@INVALID/packages/daily-notes', invalid],
		[
			common,
			`https://user:password@heykody.dev/account/packages/${packageId}`,
			invalid,
		],
	]
	expect(
		cases.map(([options, query]) => [
			query,
			parsePackageSearchIdentity({
				...common,
				...options,
				query,
			}),
		]),
	).toEqual(cases.map(([, query, expected]) => [query, expected]))
})

function resolve(
	overrides: Partial<Parameters<typeof resolvePackageIdentitySearch>[0]> = {},
) {
	return resolvePackageIdentitySearch({
		db: {} as D1Database,
		userId: ownerIdFromStored('user-1'),
		query: packageId,
		baseUrl: 'https://heykody.dev',
		username: 'user',
		includeHiddenPackages: false,
		...overrides,
	})
}

const noMatch = { recognized: true, match: null }

test('package identity resolution is user-scoped, gates hidden matches, and skips unsafe lookups', async () => {
	const hidden = createSavedPackage({ hidden: true })
	mockModule.getSavedPackageById
		.mockResolvedValueOnce(createSavedPackage())
		.mockResolvedValueOnce(hidden)
		.mockResolvedValueOnce(hidden)
		.mockResolvedValueOnce(null)
	mockModule.resolveSavedPackageRef
		.mockResolvedValueOnce(createSavedPackage())
		.mockResolvedValueOnce(null)

	await expect(resolve()).resolves.toMatchObject({
		recognized: true,
		match: {
			type: 'package',
			packageId,
			kodyId: 'daily-notes',
			hidden: false,
		},
	})
	await expect(resolve()).resolves.toEqual(noMatch)
	await expect(resolve({ includeHiddenPackages: true })).resolves.toMatchObject(
		{
			recognized: true,
			match: { packageId, hidden: true },
		},
	)
	await expect(
		resolve({
			userId: ownerIdFromStored('user-2'),
			includeHiddenPackages: true,
		}),
	).resolves.toEqual(noMatch)
	await expect(resolve({ query: 'daily-notes' })).resolves.toMatchObject({
		recognized: true,
		match: { kodyId: 'daily-notes' },
	})
	await expect(resolve({ query: 'email' })).resolves.toEqual({
		recognized: false,
	})
	expect(mockModule.getSavedPackageById).toHaveBeenNthCalledWith(
		4,
		{},
		{ userId: ownerIdFromStored('user-2'), packageId },
	)

	for (const input of [
		{ query: `https://other.example/account/packages/${packageId}` },
		{ query: 'https://heykody.dev/@other/packages/daily-notes' },
		{ userId: null, query: packageId, username: null },
	]) {
		await expect(
			resolve({ ...input, includeHiddenPackages: true }),
		).resolves.toEqual(noMatch)
	}
	expect(mockModule.getSavedPackageById).toHaveBeenCalledTimes(4)
	expect(mockModule.resolveSavedPackageRef).toHaveBeenCalledTimes(2)
})

test('package identity match includes listingAhead only when the fork is behind', async () => {
	mockModule.getSavedPackageById
		.mockResolvedValueOnce({ ...createSavedPackage(), listingAhead: true })
		.mockResolvedValueOnce({ ...createSavedPackage(), listingAhead: false })

	await expect(resolve()).resolves.toMatchObject({
		recognized: true,
		match: { listingAhead: true },
	})
	const current = await resolve()
	expect(current).toMatchObject({ recognized: true })
	if (!current.recognized) throw new Error('Expected recognized identity')
	expect(current.match).not.toHaveProperty('listingAhead')
})
