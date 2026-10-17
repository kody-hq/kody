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

function rowTag(html: string, slug: string) {
	const at = html.indexOf(`data-testid="org-switcher-${slug}"`)
	if (at === -1) throw new Error(`No row for ${slug}`)
	return html.slice(html.lastIndexOf('<a', at), html.indexOf('>', at) + 1)
}

function rowHref(html: string, slug: string) {
	return /href="([^"]*)"/.exec(rowTag(html, slug))?.[1]
}

test('switcher lists the signup organization, then others with roles, then create and waiting invites', async () => {
	const html = await render({
		currentSlug: 'acme',
		switchTarget: { section: 'secrets' },
		organizations: [
			{ slug: 'acme', displayName: 'Acme', role: 'member', personal: false },
			ada,
		],
		inviteCount: 2,
	})
	const panel = html.slice(html.indexOf('data-testid="org-switcher-panel"'))
	const adaAt = panel.indexOf('>@ada · Owner<')
	const acmeAt = panel.indexOf('>@acme · Member<')
	const createAt = panel.indexOf('>Create organization<')
	const invitesAt = panel.indexOf('>Invites<')
	expect(adaAt).toBeGreaterThan(-1)
	expect(acmeAt).toBeGreaterThan(adaAt)
	expect(createAt).toBeGreaterThan(acmeAt)
	expect(invitesAt).toBeGreaterThan(createAt)
	expect(panel.slice(invitesAt)).toMatch(/^>Invites<\/span>[\s\S]*?>2</)
	expect(html).toContain('aria-label="@acme: switch organization"')
	expect(panel).toContain('href="/account/organizations#invites"')
	// The rail's org is current: checked and announced, the other is not.
	expect(rowTag(html, 'acme')).toContain('aria-current="true"')
	expect(rowTag(html, 'acme')).toContain('data-selected')
	expect(rowTag(html, 'ada')).not.toContain('aria-current')
	expect(rowTag(html, 'ada')).not.toContain('data-selected')
	// Secrets follow the org, so both organizations keep the section.
	expect(rowHref(html, 'ada')).toBe('/@ada/-/secrets')
	expect(rowHref(html, 'acme')).toBe('/@acme/-/secrets')
	expect(html).toContain('data-icon="plus"')
	expect(html).toContain('data-icon="mail"')
	// The person's own links live in the avatar menu, not here.
	expect(html).not.toContain('action="/logout"')
	expect(html).not.toContain('>Account settings<')
})

test('a single organization is the person: their name and handle, no role, no invites row', async () => {
	const html = await render({ avatarUrl: '/profiles/ada/avatar/abc.jpg' })
	expect(html).toContain('aria-label="@ada: switch organization"')
	expect(html).toContain('>Ada Lovelace<')
	expect(html).toContain('>@ada<')
	expect(html).toContain('>Create organization<')
	expect(html).not.toContain('>Invites<')
	expect(html).not.toContain('Owner')
	expect(html.match(/data-testid="org-switcher-ada"/g)).toHaveLength(1)
	// The photo is drawn once on the trigger and once on the row.
	const trigger = html.slice(
		html.indexOf('data-testid="org-switcher"'),
		html.indexOf('data-testid="org-switcher-panel"'),
	)
	expect(trigger.match(/avatar\/abc\.jpg/g)).toHaveLength(1)
})

test('switcher stays on the URL org when the session lists only personal', async () => {
	const html = await render({
		currentSlug: 'acme',
		switchTarget: { section: 'settings' },
	})
	expect(html).toContain('aria-label="@acme: switch organization"')
	// The missing team gets its own member-shaped row.
	expect(rowTag(html, 'acme')).toContain('aria-current="true"')
	expect(rowHref(html, 'acme')).toBe('/@acme/-/settings')
	// The signup org has no Settings page, so it opens its overview.
	expect(rowHref(html, 'ada')).toBe('/@ada/-/overview')
})

test('switcher opens the org home when the current page is not open to that role there', async () => {
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
	expect(rowHref(billing, 'zeta')).toBe('/@zeta')
	// The signup org has no Teams page either, so it opens its overview.
	expect(rowHref(billing, 'ada')).toBe('/@ada/-/overview')
})

test('switcher keeps every org-owned section when switching between orgs', async () => {
	const sections = [
		'activity',
		'agents',
		'email',
		'integrations',
		'jobs',
		'mcp-servers',
		'memories',
		'repositories',
		'secret-providers',
		'secrets',
		'waiting',
		'webhooks',
		'workflows',
	] as const
	for (const section of sections) {
		const html = await render({
			switchTarget: { section },
			organizations: [
				ada,
				{ slug: 'acme', displayName: 'Acme', role: 'member', personal: false },
			],
		})
		expect([section, rowHref(html, 'acme')]).toEqual([
			section,
			`/@acme/-/${section}`,
		])
		expect([section, rowHref(html, 'ada')]).toEqual([
			section,
			`/@ada/-/${section}`,
		])
	}
})

test('switcher draws a team photo on the trigger and the account photo for the signup org', async () => {
	const html = await render({
		currentSlug: 'kody',
		switchTarget: { section: 'settings' },
		avatarUrl: '/profiles/ada/avatar/ada.png',
		organizations: [
			{
				slug: 'kody',
				displayName: 'Kody',
				role: 'owner',
				personal: false,
				avatarUrl: '/orgs/kody/avatar/new.png',
			},
			{ ...ada, avatarUrl: '/orgs/ada/avatar/ignored.png' },
		],
	})
	const trigger = html.slice(
		html.indexOf('data-testid="org-switcher"'),
		html.indexOf('data-testid="org-switcher-panel"'),
	)
	expect(trigger).toContain('src="/orgs/kody/avatar/new.png"')
	expect(trigger).not.toContain('/profiles/ada/avatar/ada.png')
	const panel = html.slice(html.indexOf('data-testid="org-switcher-panel"'))
	const adaAt = panel.indexOf('data-testid="org-switcher-ada"')
	const kodyAt = panel.indexOf('data-testid="org-switcher-kody"')
	const createAt = panel.indexOf('data-testid="org-switcher-create"')
	expect(panel.slice(panel.lastIndexOf('<a', kodyAt), createAt)).toContain(
		'src="/orgs/kody/avatar/new.png"',
	)
	expect(panel.slice(panel.lastIndexOf('<a', adaAt), kodyAt)).toContain(
		'src="/profiles/ada/avatar/ada.png"',
	)
	expect(html).not.toContain('/orgs/ada/avatar/ignored.png')
})
