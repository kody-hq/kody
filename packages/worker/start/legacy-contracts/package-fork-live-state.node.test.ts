import { expect, test } from 'vitest'
import { jsx } from 'react/jsx-runtime'
import {
	PackageInstallContext,
	renderPackageRepoActions,
} from '../components/package-title-actions.tsx'
import { ForkTargetForm } from '../components/fork-target-dialog.tsx'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { type ForkTargetChoice, pressFork } from '../fork-target.ts'

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
	choosesForkTarget?: boolean
	forkTarget?: ForkTargetChoice | null
}) {
	return renderStartPage(
		jsx(PackageInstallContext.Provider, {
			value: {
				busy: context.busy ?? false,
				existingFork: context.existingFork ?? null,
				inProgress: context.inProgress ?? null,
				choosesForkTarget: context.choosesForkTarget ?? false,
				forkTarget: context.forkTarget ?? null,
				onInstall: () => {},
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

async function press(input: {
	owners: typeof owners
	currentOrg?: string | null
}) {
	const forks: Array<string | null> = []
	const choices: Array<ForkTargetChoice> = []
	await pressFork({
		loadOwners: async () => input.owners,
		currentOrg: input.currentOrg ?? null,
		fork: (org) => {
			forks.push(org)
		},
		choose: (choice) => {
			choices.push(choice)
		},
	})
	return { forks, choices }
}

test('with one forkable org, pressing Fork forks into it without a chooser', async () => {
	const { forks, choices } = await press({ owners: owners.slice(0, 1) })
	expect(forks).toEqual([null])
	expect(choices).toEqual([])
})

test('with several forkable orgs, pressing Fork opens the chooser on personal', async () => {
	const { forks, choices } = await press({ owners })
	expect(forks).toEqual([])
	expect(choices).toEqual([{ owners, selected: 'viewer' }])
})

test('the chooser preselects the ?org= pick when it is a forkable org', async () => {
	const picked = await press({ owners, currentOrg: 'Example-Team' })
	expect(picked.choices[0]?.selected).toBe('example-team')
	const unknown = await press({ owners, currentOrg: 'elsewhere' })
	expect(unknown.choices[0]?.selected).toBe('viewer')
})

test('the title row shows only the Fork button, never an inline org picker', async () => {
	const html = await render({ choosesForkTarget: true })
	expect(html).toContain('data-community-install')
	expect(html).toContain('aria-haspopup="dialog"')
	expect(html).not.toContain('<select')
	expect(html).not.toContain('Fork into')
	expect(html).not.toContain('fork-target-dialog')
	expect(await render({})).not.toContain('aria-haspopup')
})

test('the chooser form lists creatable orgs with the pick preselected', async () => {
	const html = await renderStartPage(
		jsx(ForkTargetForm, {
			choice: { owners, selected: 'viewer' },
			onConfirm: () => {},
			onDismiss: () => {},
		}),
	)
	expect(html).toMatch(/<label[^>]*>[\s\S]*Workspace[\s\S]*<select/)
	expect(html).toMatch(
		/<option value="viewer" selected[^>]*>Personal workspace</,
	)
	expect(html).toMatch(/<option value="example-team"[^>]*>Example Team</)
	expect(html).toContain('data-testid="fork-target-cancel"')
	expect(html).toContain('data-testid="fork-target-confirm"')
})
