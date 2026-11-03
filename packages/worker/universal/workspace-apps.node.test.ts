import { expect, test } from 'vitest'
import type { PublicProfilePackageItem } from './community-public-types.ts'
import { filterWorkspaceApps } from './workspace-apps.ts'

const app = (
	name: string,
	options: Partial<PublicProfilePackageItem> = {},
): PublicProfilePackageItem => ({
	name,
	kodyId: name,
	description: '',
	tags: [],
	updatedAt: '2026-01-01',
	createdAt: '2026-01-01',
	communityListingId: null,
	communityListingKodyId: null,
	communityPublishedAt: null,
	needsRepublish: false,
	hasPackage: true,
	hasApp: true,
	webhookCount: 0,
	jobCount: 0,
	iconUrl: null,
	isPrivate: false,
	...options,
})
const apps = [
	app('Notes', { isPrivate: true, tags: ['writing'], updatedAt: '2026-02-01' }),
	app('Calendar', { description: 'Team events', createdAt: '2026-03-01' }),
]

test('search and package visibility combine', () => {
	expect(
		filterWorkspaceApps(apps, {
			query: ' WRITING ',
			visibility: 'private',
			sort: 'name',
		}).map((item) => item.name),
	).toEqual(['Notes'])
	expect(
		filterWorkspaceApps(apps, {
			query: 'events',
			visibility: 'private',
			sort: 'name',
		}),
	).toEqual([])
})

test('sorts by name, update, or creation without changing the input', () => {
	for (const [sort, expected] of [
		['name', ['Calendar', 'Notes']],
		['updated', ['Notes', 'Calendar']],
		['created', ['Calendar', 'Notes']],
	] as const) {
		expect(
			filterWorkspaceApps(apps, { query: '', visibility: 'all', sort }).map(
				(item) => item.name,
			),
		).toEqual(expected)
	}
	expect(apps.map((item) => item.name)).toEqual(['Notes', 'Calendar'])
})
