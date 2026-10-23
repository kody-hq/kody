import { expect, test } from 'vitest'
import { jsx } from 'react/jsx-runtime'
import {
	PackageInstallContext,
	renderPackageRepoActions,
} from '../components/package-title-actions.tsx'
import { renderStartPage } from '../test-support/render-start-page.ts'

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
