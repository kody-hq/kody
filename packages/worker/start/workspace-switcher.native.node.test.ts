import { expect, test } from 'vitest'
import { createElement as jsx } from 'react'
import { renderStartPage as renderToString } from './test-support/render-start-page.ts'
import { type OrganizationSummary } from '#universal/org-pages.ts'
import {
	WorkspaceSwitcher,
	type WorkspaceSwitcherData,
} from './components/workspace-switcher.tsx'

const ada: OrganizationSummary = {
	slug: 'ada',
	displayName: 'Ada',
	role: 'owner',
	personal: true,
}

function render(data: Partial<WorkspaceSwitcherData>) {
	return renderToString(
		jsx(WorkspaceSwitcher, {
			currentSlug: 'ada',
			organizations: [ada],
			inviteCount: 0,
			username: 'ada',
			displayName: 'Ada Lovelace',
			avatarUrl: null,
			switchTarget: { section: 'secrets' },
			...data,
			placement: 'rail',
		}),
	)
}

function rowHref(html: string, slug: string) {
	const at = html.indexOf(`data-testid="org-switcher-${slug}"`)
	if (at === -1) throw new Error(`No row for ${slug}`)
	const start = html.lastIndexOf('<a', at)
	const tag = html.slice(start, html.indexOf('>', at) + 1)
	return /href="([^"]*)"/.exec(tag)?.[1]
}

test('switcher preserves the URL org when the session omits it', async () => {
	const html = await render({
		currentSlug: 'acme',
		switchTarget: { section: 'settings' },
	})
	expect(html).toContain('aria-label="@acme: switch organization"')
	expect(rowHref(html, 'acme')).toBe('/@acme/-/settings')
	expect(rowHref(html, 'ada')).toBe('/@ada/-/overview')
})

test('switching to a workspace that cannot open the current section returns to its home', async () => {
	const collaborator = await render({
		switchTarget: { section: 'settings' },
		organizations: [
			{ slug: 'acme', displayName: 'Acme', role: null, personal: false },
			ada,
		],
	})
	expect(rowHref(collaborator, 'acme')).toBe('/@acme')

	const billing = await render({
		currentSlug: 'acme',
		switchTarget: { section: 'teams' },
		organizations: [
			{ slug: 'acme', displayName: 'Acme', role: 'billing', personal: false },
			{ slug: 'zeta', displayName: 'Zeta', role: 'billing', personal: false },
			ada,
		],
	})
	expect(rowHref(billing, 'zeta')).toBe('/@zeta/-/overview')
})
