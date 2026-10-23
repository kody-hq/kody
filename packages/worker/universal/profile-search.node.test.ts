import { expect, test } from 'vitest'
import {
	buildProfileHref,
	filterProfilePackages,
	isProfilePackageFilterOnlyHrefChange,
	readProfilePackageFiltersFromHref,
} from './profile-search.ts'
import { type PublicProfilePackageItem } from './community-public-types.ts'

const listedApp = {
	name: '@kody/notes-app',
	kodyId: 'notes-app',
	description: 'Notes with a UI.',
	tags: ['notes'],
	updatedAt: '2026-08-01T00:00:00.000Z',
	createdAt: '2026-06-01T00:00:00.000Z',
	communityListingId: 'listing-1',
	communityListingKodyId: 'notes-app',
	communityPublishedAt: '2026-07-01T00:00:00.000Z',
	needsRepublish: true,
	hasPackage: true,
	hasApp: true,
	webhookCount: 0,
	jobCount: 0,
	iconUrl: null,
	isPrivate: false,
	hidden: false,
} satisfies PublicProfilePackageItem

const privateNoApp = {
	name: '@kody/aardvark',
	kodyId: 'secret',
	description: 'Private helper.',
	tags: [],
	updatedAt: '2026-07-01T00:00:00.000Z',
	createdAt: '2026-04-01T00:00:00.000Z',
	communityListingId: null,
	communityListingKodyId: null,
	communityPublishedAt: null,
	needsRepublish: false,
	hasPackage: true,
	hasApp: false,
	webhookCount: 0,
	jobCount: 0,
	iconUrl: null,
	isPrivate: true,
	hidden: true,
} satisfies PublicProfilePackageItem

const plainRepo = {
	name: '@kody/notes-repo',
	kodyId: 'notes-repo',
	description: 'Plain repo without a package.',
	tags: [],
	updatedAt: '2026-06-15T00:00:00.000Z',
	createdAt: '2026-03-01T00:00:00.000Z',
	communityListingId: null,
	communityListingKodyId: null,
	communityPublishedAt: null,
	needsRepublish: false,
	hasPackage: false,
	hasApp: false,
	webhookCount: 0,
	jobCount: 0,
	iconUrl: null,
	isPrivate: true,
	hidden: false,
} satisfies PublicProfilePackageItem

const privateListed = {
	...listedApp,
	name: '@kody/secret-app',
	kodyId: 'secret-app',
	isPrivate: true,
	hidden: false,
	needsRepublish: false,
} satisfies PublicProfilePackageItem

const defaultFilters = {
	query: '',
	visibility: 'all',
	listing: 'all',
	hidden: 'all',
	app: 'all',
	package: 'all',
	sort: 'updated',
	dir: 'desc',
} as const

type ProfileFilters = Parameters<typeof filterProfilePackages>[1]

test('profile package filter hrefs omit defaults and ignore owner-only params for guests', () => {
	expect(buildProfileHref({ username: 'kody' })).toBe('/@kody')
	expect(
		buildProfileHref({
			...defaultFilters,
			username: 'kody',
			query: '  notes  ',
		}),
	).toBe('/@kody?q=notes')
	expect(
		buildProfileHref({
			username: 'kody',
			query: 'notes',
			visibility: 'private',
			listing: 'unpublished',
			hidden: 'yes',
			app: 'yes',
			package: 'no',
			sort: 'name',
			dir: 'desc',
		}),
	).toBe(
		'/@kody?q=notes&visibility=private&listing=unpublished&hidden=yes&app=yes&package=no&sort=name&dir=desc',
	)
	expect(buildProfileHref({ username: 'kody', listing: 'ahead' })).toBe(
		'/@kody?listing=ahead',
	)
	expect(
		buildProfileHref({
			username: 'kody',
			query: 'notes',
			extraSearchParams: new URLSearchParams('limit=10&q=old'),
		}),
	).toBe('/@kody?q=notes&limit=10')

	expect(
		readProfilePackageFiltersFromHref(
			'/@kody?q=notes&visibility=private&listing=unpublished&hidden=yes&app=no&package=yes&sort=name&dir=desc',
			{ allowOwnerFilters: true },
		),
	).toEqual({
		query: 'notes',
		visibility: 'private',
		listing: 'unpublished',
		hidden: 'yes',
		app: 'no',
		package: 'yes',
		sort: 'name',
		dir: 'desc',
	})
	// Guest reads: owner-only params drop; sort picks its own default dir.
	const guestReads: Array<[string, Partial<ProfileFilters>]> = [
		['/@kody?visibility=private&listing=ahead&hidden=yes', {}],
		['/@kody?listing=published', { listing: 'published' }],
		['/@kody?app=yes', { app: 'yes' }],
		['/@kody?package=no', { package: 'no' }],
		['/@kody?sort=name', { sort: 'name', dir: 'asc' }],
		['/@kody?sort=created', { sort: 'created', dir: 'desc' }],
		['/@kody?sort=updated&dir=asc', { sort: 'updated', dir: 'asc' }],
		['/@kody?sort=bogus', {}],
	]
	expect(
		guestReads.map(([href]) => [href, readProfilePackageFiltersFromHref(href)]),
	).toEqual(
		guestReads.map(([href, overrides]) => [
			href,
			{ ...defaultFilters, ...overrides },
		]),
	)
})

test('chip and search profile href changes skip the loader', () => {
	const cases: Array<[string, string, boolean]> = [
		['/@kody', '/@kody?visibility=private', true],
		['/@kody?q=notes', '/@kody?q=notes&listing=published&app=yes', true],
		['/@kody?visibility=private', '/@kody?listing=unpublished', true],
		['/@kody', '/@kody?sort=name', true],
		['/@kody', '/@kody?package=no', true],
		['/@kody', '/@kody?dir=asc', true],
		['/@kody', '/@kody?q=notes', true],
		['/@kody?q=notes', '/@kody?q=obsidian&visibility=private', true],
		['/@kody?q=notes', '/@kody?q=notes&limit=10', false],
		['/@kody?limit=10', '/@kody?q=notes&limit=10', false],
		['/@kody', '/@other?visibility=private', false],
		['/community', '/community?visibility=private', false],
		['/@kody', '/@kody', false],
	]
	expect(
		cases.filter(
			([from, to, want]) =>
				isProfilePackageFilterOnlyHrefChange(from, to) !== want,
		),
	).toEqual([])
})

test('profile package chips, search, and sort filter the already-loaded list', () => {
	const packages = [listedApp, privateNoApp]
	const inventory = [listedApp, privateNoApp, privateListed, plainRepo]
	const ids = (
		list: Array<PublicProfilePackageItem>,
		overrides: Partial<ProfileFilters>,
	) =>
		filterProfilePackages(list, { ...defaultFilters, ...overrides }).map(
			(pkg) => pkg.kodyId,
		)
	expect(filterProfilePackages(packages, defaultFilters)).toEqual(packages)

	const cases: Array<
		[Array<PublicProfilePackageItem>, Partial<ProfileFilters>, Array<string>]
	> = [
		// Chips.
		[packages, { visibility: 'private' }, ['secret']],
		[packages, { listing: 'published' }, ['notes-app']],
		[packages, { listing: 'ahead' }, ['notes-app']],
		[packages, { hidden: 'yes' }, ['secret']],
		[packages, { app: 'yes' }, ['notes-app']],
		[packages, { app: 'no' }, ['secret']],
		[packages, { package: 'yes' }, ['notes-app', 'secret']],
		[inventory, { package: 'no' }, ['notes-repo']],
		[packages, { listing: 'unpublished' }, ['secret']],
		[inventory, { listing: 'unpublished' }, ['secret']],
		[inventory, { listing: 'published' }, ['notes-app', 'secret-app']],
		// Search by name, description, tags, and kody id.
		[packages, { query: 'notes' }, ['notes-app']],
		[packages, { query: 'NOTES UI' }, ['notes-app']],
		[packages, { query: 'secret' }, ['secret']],
		[packages, { query: 'private helper' }, ['secret']],
		[packages, { query: 'notes', visibility: 'private' }, []],
		[
			inventory,
			{ query: 'secret', visibility: 'private', listing: 'unpublished' },
			['secret'],
		],
		[packages, { query: 'zzzz-no-match' }, []],
		[packages, { query: 'notes helper' }, []],
		[packages, { query: '   ' }, ['notes-app', 'secret']],
		// Sort without changing the default order.
		[packages, {}, ['notes-app', 'secret']],
		[[privateNoApp, listedApp], {}, ['notes-app', 'secret']],
		[packages, { sort: 'name', dir: 'asc' }, ['secret', 'notes-app']],
		[
			[privateNoApp, listedApp],
			{ sort: 'name', dir: 'asc' },
			['secret', 'notes-app'],
		],
		[packages, { sort: 'name', dir: 'desc' }, ['notes-app', 'secret']],
		[packages, { sort: 'created' }, ['notes-app', 'secret']],
		[packages, { sort: 'created', dir: 'asc' }, ['secret', 'notes-app']],
		[packages, { sort: 'updated', dir: 'asc' }, ['secret', 'notes-app']],
	]
	expect(
		cases.map(([list, overrides]) => [overrides, ids(list, overrides)]),
	).toEqual(cases.map(([, overrides, want]) => [overrides, want]))
})
