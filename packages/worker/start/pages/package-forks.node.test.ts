import { expect, test } from 'vitest'
import { jsx } from 'react/jsx-runtime'
import { type PackageForksLoaderData } from '#universal/package-forks.ts'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { PackageForksRoute } from './package-forks.tsx'

const shell: PackageForksLoaderData['shell'] = {
	username: 'kentcdodds',
	kodyId: 'ship-pr',
	name: '@kentcdodds/ship-pr',
	description: 'Ship pull requests.',
	isPrivate: false,
	isListed: true,
	listingId: 'listing-1',
	listingIconUrl: null,
	defaultBranch: 'main',
	publishedCommit: null,
	ownerProfilePublic: true,
	viewerIsOwner: false,
	viewerCanManage: false,
	viewerCanManageAccess: false,
}

const render = async (payload: Omit<PackageForksLoaderData, 'ok' | 'shell'>) =>
	(
		await renderStartPage(
			jsx(PackageForksRoute, { payload: { ok: true, shell, ...payload } }),
		)
	).replace(/<!-- -->/g, '')

test('lists visible forks with links and marks the private ones', async () => {
	const html = await render({
		total: 2,
		forks: [
			{
				id: 'fork-1',
				name: '@bob/ship-pr',
				href: '/@bob/ship-pr',
				description: '',
				isPrivate: true,
				createdAt: '2026-10-02T00:00:00.000Z',
				ownerSlug: 'bob',
				ownerDisplayName: null,
				ownerAvatarUrl: null,
				iconUrl: null,
			},
			{
				id: 'fork-2',
				name: '@alice/ship-pr',
				href: '/@alice/ship-pr',
				description: 'Alice’s copy.',
				isPrivate: false,
				createdAt: '2026-10-01T00:00:00.000Z',
				ownerSlug: 'alice',
				ownerDisplayName: 'Alice',
				ownerAvatarUrl: null,
				iconUrl: null,
			},
		],
	})
	expect(html).toContain('2 forks you can see')
	expect(html).toContain('href="/@bob/ship-pr"')
	expect(html).toContain('href="/@alice/ship-pr"')
	expect(html).toContain('Forked by Alice on October 1, 2026')
	expect(html.match(/data-testid="package-fork-private"/g)).toHaveLength(1)
	expect(html).not.toContain('data-testid="package-forks-empty"')
})

test('shows an empty state without revealing a count', async () => {
	const html = await render({ total: 0, forks: [] })
	expect(html).toContain('data-testid="package-forks-empty"')
	expect(html).not.toContain('you can see.')
})
