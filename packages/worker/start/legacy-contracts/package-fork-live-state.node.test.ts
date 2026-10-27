import { expect, test } from 'vitest'
import { jsx } from 'react/jsx-runtime'
import {
	PackageInstallContext,
	renderPackageRepoActions,
} from '../components/package-title-actions.tsx'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { type CommunityInstallOrgPicker } from '../use-community-install-org.ts'

const fork = {
	listingId: 'listing-1',
	trusted: false,
	loggedIn: true,
	loginHref: '/login',
	viewerInstall: null,
}

function render(context: {
	existingFork?: { targetName: string; href: string } | null
	inProgress?: { startedAt: string } | null
	busy?: boolean
	orgPicker?: CommunityInstallOrgPicker | null
}) {
	return renderStartPage(
		jsx(PackageInstallContext.Provider, {
			value: {
				busy: context.busy ?? false,
				confirmed: false,
				existingFork: context.existingFork ?? null,
				inProgress: context.inProgress ?? null,
				onInstall: () => {},
				onDisarm: () => {},
				orgPicker: context.orgPicker ?? null,
			},
			children: renderPackageRepoActions({
				fork,
				publishHref: null,
				packageAppHref: null,
			}),
		}),
	)
}

test('a fork still being created shows as in progress, not as a fresh Fork button', async () => {
	const html = await render({
		inProgress: { startedAt: '2026-10-23T18:49:00.000Z' },
	})
	expect(html).toContain('data-fork-in-progress')
	expect(html).toContain('Fork in progress')
	expect(html).toContain('aria-busy="true"')
	expect(html).toMatch(/<button[^>]*disabled/)
	expect(html).not.toContain('>Fork<')
})

test('a fork the page data missed renders as Open fork linking to it', async () => {
	const html = await render({
		existingFork: { targetName: '@viewer/demo', href: '/@viewer/demo' },
	})
	expect(html).toContain('data-package-title-status="open"')
	expect(html).toContain('href="/@viewer/demo"')
	expect(html).toContain('Open fork')
	expect(html).not.toContain('data-community-install')
})

test('with no fork anywhere the Fork button is offered', async () => {
	const html = await render({})
	expect(html).toContain('data-community-install')
	expect(html).not.toContain('data-fork-in-progress')
})

const owners = [
	{ slug: 'viewer', displayName: null, personal: true },
	{ slug: 'example-team', displayName: 'Example Team', personal: false },
]

test('the Fork into picker lists creatable orgs and marks the picked one', async () => {
	const html = await render({
		orgPicker: { owners, selected: 'example-team', onSelect: () => {} },
	})
	expect(html).toContain('data-testid="community-install-org"')
	expect(html).toContain('Fork into')
	expect(html).toMatch(/<option value="viewer"[^>]*>Personal workspace</)
	expect(html).toMatch(
		/<option value="example-team" selected[^>]*>Example Team</,
	)
	expect(html).toContain('data-community-install')
})

test('the picker defaults to the personal org and is hidden with one org', async () => {
	const personal = await render({
		orgPicker: { owners, selected: null, onSelect: () => {} },
	})
	expect(personal).toMatch(/<option value="viewer" selected/)
	expect(await render({})).not.toContain('community-install-org')
})

test('the picker is disabled while a fork is being created', async () => {
	const html = await render({
		busy: true,
		orgPicker: { owners, selected: null, onSelect: () => {} },
	})
	expect(html).toMatch(
		/<select[^>]*data-testid="community-install-org"[^>]*disabled|<select[^>]*disabled[^>]*data-testid="community-install-org"/,
	)
})
