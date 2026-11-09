import { expect, test } from 'vitest'
import { createElement as jsx } from 'react'
import { renderStartPage as renderToString } from './test-support/render-start-page.ts'
import { type OrganizationSummary } from '#universal/org-pages.ts'
import {
	WorkspaceSwitcher,
	workspaceSwitcherRows,
	type WorkspaceSwitcherData,
} from './components/workspace-switcher.tsx'

const ada: OrganizationSummary = {
	slug: 'ada',
	displayName: 'Ada',
	role: 'owner',
	personal: true,
}

const defaultData: WorkspaceSwitcherData = {
	currentSlug: 'ada',
	organizations: [ada],
	inviteCount: 0,
	username: 'ada',
	displayName: 'Ada Lovelace',
	avatarUrl: null,
	switchTarget: { section: 'secrets' },
}

function rowHref(data: Partial<WorkspaceSwitcherData>, slug: string) {
	return workspaceSwitcherRows({ ...defaultData, ...data }).orgRows.find(
		(row) => row.key === slug,
	)?.href
}

test('switcher preserves the URL org when the session omits it', async () => {
	const data = {
		currentSlug: 'acme',
		switchTarget: { section: 'settings' },
	} satisfies Partial<WorkspaceSwitcherData>
	const html = await renderToString(
		jsx(WorkspaceSwitcher, { ...defaultData, ...data, placement: 'rail' }),
	)
	expect(html).toContain('aria-label="@acme: switch organization"')
	expect(rowHref(data, 'acme')).toBe('/@acme/-/settings')
	expect(rowHref(data, 'ada')).toBe('/@ada/-/overview')
})

test('switching to a workspace that cannot open the current section returns to its home', async () => {
	const collaborator = {
		switchTarget: { section: 'settings' },
		organizations: [
			{ slug: 'acme', displayName: 'Acme', role: null, personal: false },
			ada,
		],
	} satisfies Partial<WorkspaceSwitcherData>
	expect(rowHref(collaborator, 'acme')).toBe('/@acme')

	const billing = {
		currentSlug: 'acme',
		switchTarget: { section: 'teams' },
		organizations: [
			{ slug: 'acme', displayName: 'Acme', role: 'billing', personal: false },
			{ slug: 'zeta', displayName: 'Zeta', role: 'billing', personal: false },
			ada,
		],
	} satisfies Partial<WorkspaceSwitcherData>
	expect(rowHref(billing, 'zeta')).toBe('/@zeta/-/overview')
})
