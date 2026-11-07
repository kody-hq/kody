import { expect, test } from 'vitest'
import type { PublicProfilePackageItem } from './community-public-types.ts'
import { workspaceAppsAgentPrompt } from './workspace-apps-agent-prompt.ts'
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

test('workspace apps agent prompt names the workspace and a dashboard example', () => {
	const prompt = workspaceAppsAgentPrompt('@acme')
	expect(prompt).toContain('@acme')
	expect(prompt).toContain('/@acme/-/apps')
	expect(prompt.toLowerCase()).toContain('dashboard')
	expect(prompt).toContain('guide:package_apps')
	expect(workspaceAppsAgentPrompt('acme')).toContain('@acme')
	expect(workspaceAppsAgentPrompt('acme')).not.toContain('@@acme')
})
