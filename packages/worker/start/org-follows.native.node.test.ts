import { createElement } from 'react'
import { expect, test } from 'vitest'
import { type OrgFollowRow } from '#universal/follows.ts'
import { OrgFollowsPage } from './pages/org-follows.tsx'
import { renderStartPage } from './test-support/render-start-page.ts'

const follow: OrgFollowRow = {
	id: 'follow-one',
	name: '@owner/project',
	kind: 'repo',
	href: '/@owner/project',
	status: 'active',
	events: ['pushed'],
	availableEvents: ['pushed'],
	createdAt: '2026-10-15T00:00:00Z',
	pausedAt: null,
	pausedReason: null,
	deleteAt: null,
	lastDeliverySkipAt: null,
	lastDeliverySkipReason: null,
}
function render(follows: OrgFollowRow[]) {
	return renderStartPage(
		createElement(OrgFollowsPage, {
			data: { ok: true, orgSlug: 'acme', follows },
			currentHref: '/@acme/-/follows',
		}),
		'/@acme/-/follows',
	)
}

test('native follows preserves repository links, status, disclosure details, and removal action', async () => {
	const html = await render([follow])
	expect(html).toContain('href="/@owner/project"')
	expect(html).toContain('data-follow-status="active"')
	expect(html).toContain('Repository')
	expect(html).toContain('Pushes')
	expect(html).toContain('<summary>Details</summary>')
	expect(html).toContain('follow-one')
	expect(html).toContain('follow.pushed')
	expect(html).toContain('data-testid="org-follow-unfollow"')
	expect(html).not.toContain('data-testid="org-follow-resume"')
})

test('paused follows show resume and a hydration-safe retention date', async () => {
	const html = await render([
		{
			...follow,
			status: 'paused',
			pausedReason: 'access_lost',
			pausedAt: '2026-10-15T00:00:00Z',
			deleteAt: '2026-11-14T00:00:00Z',
		},
	])
	expect(html).toContain('data-follow-status="paused"')
	expect(html).toContain('data-testid="org-follow-resume"')
	expect(html).toContain('It will be deleted on')
	expect(html).toContain('dateTime="2026-11-14T00:00:00.000Z"')
	expect(html).toContain('2026-11-14')
	expect(html).not.toContain('[object Object]')
})

test('empty follows offer discovery without rendering row actions', async () => {
	const html = await render([])
	expect(html).toContain('data-testid="org-follows-empty"')
	expect(html).toContain('>Community</a>')
	expect(html).not.toContain('data-testid="org-follow-unfollow"')
})
