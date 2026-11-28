import { expect, test } from 'vitest'
import { buildWaitingItems, type WaitingSignals } from './waiting.ts'

const quiet: WaitingSignals = {
	username: 'ada',
	emailVerified: true,
	onboardingDismissed: true,
	onboardingRemaining: [],
	mcpServers: [],
	integrationAuth: [],
	pausedEnablements: [],
	expiredSecrets: [],
	lockedPackages: [],
	pendingEmailChange: null,
	errorRate: null,
	entitlementCaps: [],
	firstUseMissing: [],
}

test('a held publish waits on the owner with both commits and the approval page', () => {
	expect(buildWaitingItems(quiet, 'ada')).toEqual([])

	const items = buildWaitingItems(
		{
			...quiet,
			heldPublishes: [
				{
					id: 'pkg-site',
					name: '@acme/site',
					kodyId: 'site',
					servingCommit: 'aaaaaaa1111111',
					heldCommit: 'bbbbbbb2222222',
				},
			],
			lockedPackages: [
				{ id: 'pkg-locked', name: '@acme/locked', kodyId: 'locked' },
			],
		},
		'acme',
	)

	// A locked package and a held publish are different items.
	expect(items.map((item) => item.kind)).toEqual([
		'publish-lock',
		'publish-held',
	])
	expect(items[1]).toEqual({
		id: 'publish-held:pkg-site',
		kind: 'publish-held',
		title: '@acme/site has a publish held for approval',
		why: 'Commit bbbbbbb asks for more capabilities than the version you approved. Everyone stays on aaaaaaa until an owner approves it.',
		who: 'you',
		doLabel: 'Review and approve',
		href: '/@acme/site/approve-capabilities',
		severity: 'block',
	})
})

test('an app with no one to run as waits on the owner with why its calls fail', () => {
	const items = buildWaitingItems(
		{
			...quiet,
			appsWithoutRunsAs: [
				{
					id: 'pkg-app',
					name: '@acme/app',
					message: 'An owner must publish it again.',
				},
			],
		},
		'acme',
	)
	expect(items).toEqual([
		{
			id: 'app-runs-as:pkg-app',
			kind: 'app-runs-as',
			title: '@acme/app has no one to run as',
			why: "Its app's server-side Kody calls that act as the publisher fail. An owner must publish it again.",
			who: 'you',
			doLabel: 'See who apps run as',
			href: expect.stringContaining('/package-apps#who-the-app-runs-as'),
			severity: 'block',
		},
	])
})
