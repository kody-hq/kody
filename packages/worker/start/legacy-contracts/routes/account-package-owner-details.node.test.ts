import { QueryClient } from '@tanstack/react-query'
import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { PackageSettingsRoute } from '../../pages/package-settings.tsx'
import { AccountPackageOwnerDetails } from '../../pages/account-package-owner-details.tsx'
import { type AccountPackageDetail } from '#universal/loader-data.ts'

function packageDetail(
	overrides: Partial<AccountPackageDetail> = {},
): AccountPackageDetail {
	return {
		id: 'pkg-1',
		name: '@kentcdodds/demo-app',
		kodyId: 'demo-app',
		description: '',
		tags: [],
		hasApp: true,
		sourceId: 'source-1',
		lockedAt: null,
		createdAt: '2026-09-12T00:00:00.000Z',
		updatedAt: '2026-09-12T00:00:00.000Z',
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		hasCommunityListing: false,
		listingNeedsRepublish: false,
		listingAhead: null,
		forkAhead: null,
		searchText: null,
		exports: null,
		publishedCommit: null,
		pendingCommit: null,
		pendingCommitKnown: true,
		publishedVersion: null,
		unpublishedChangeCount: null,
		ownerIsPersonal: true,
		communityFork: null,
		...overrides,
	}
}

test('owner details link Open Package App when the package declares an app', async () => {
	const html = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'kentcdodds',
			packageDetail: packageDetail({ hasApp: true }),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: true,
			onToggleLock: () => {},
		}),
	)

	expect(html).toContain('data-testid="open-package-app"')
	expect(html).toContain('href="/@kentcdodds/packages/demo-app/open"')
	expect(html).toContain('Open Package App')
	expect(html).toContain('data-icon="share"')
})

test('owner details show No app when the package has no app', async () => {
	const html = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'kentcdodds',
			packageDetail: packageDetail({ hasApp: false }),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: true,
			onToggleLock: () => {},
		}),
	)

	expect(html).toContain('No app')
	expect(html).not.toContain('data-testid="open-package-app"')
	expect(html).not.toContain('Open Package App')
})

test('owner details group visibility controls and use credentials wording', async () => {
	const html = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'kentcdodds',
			packageDetail: packageDetail({
				isPrivate: true,
				isInternetVisible: false,
				hasApp: true,
			}),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: false,
			onToggleLock: () => {},
		}),
	)

	expect(html).toContain('data-testid="package-visibility-controls"')
	expect(html).toContain('data-testid="package-internet-visible-controls"')
	expect(html).toContain('data-testid="package-make-public"')
	expect(html).not.toContain('data-testid="package-update-public-listing"')
	expect(html).toContain('Make public on the community')
	expect(html).toContain('Visibility')
	expect(html).toContain('data-testid="package-internet-visible-on"')
	expect(html).toContain('Make internet-visible')
	expect(html).toContain('Review credentials')
	expect(html).toContain('data-testid="package-approve-capabilities-link"')
	expect(html).toContain('/@kentcdodds/demo-app/approve-capabilities')
})

test('owner details publishing panel shows live version, newer changes, and primary CTA', async () => {
	const upToDate = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'kentcdodds',
			packageDetail: packageDetail({
				lockedAt: '2026-09-12T00:00:00.000Z',
				publishedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				pendingCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				publishedVersion: '1.5.0',
			}),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: false,
			onToggleLock: () => {},
		}),
	)

	expect(upToDate).toContain('data-testid="package-publishing-panel"')
	expect(upToDate).toContain('data-testid="package-publishing-live"')
	expect(upToDate).toContain('Live: 1.5.0')
	expect(upToDate).toContain('Anyone can see it on the community')
	expect(upToDate).toContain('data-testid="package-publishing-empty"')
	expect(upToDate).toContain('data-testid="account-approve-publish"')
	expect(upToDate).toContain('Review publish status')
	expect(upToDate).not.toContain('data-testid="package-publishing-newer"')

	const pending = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'kentcdodds',
			packageDetail: packageDetail({
				lockedAt: '2026-09-12T00:00:00.000Z',
				publishedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				pendingCommit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
				publishedVersion: '1.5.0',
				unpublishedChangeCount: 2,
			}),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: false,
			onToggleLock: () => {},
		}),
	)

	expect(pending).toContain('data-testid="package-publishing-newer"')
	expect(pending).toContain('2 changes since 1.5.0')
	expect(pending).toContain('Promote this commit')

	const personalPrivate = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'kentcdodds',
			packageDetail: packageDetail({
				isPrivate: true,
				ownerIsPersonal: true,
				publishedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				pendingCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				publishedVersion: '1.0.0',
			}),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: false,
			onToggleLock: () => {},
		}),
	)
	expect(personalPrivate).toContain('Only you can see it')

	const orgPrivate = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'acme',
			packageDetail: packageDetail({
				isPrivate: true,
				ownerIsPersonal: false,
				publishedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				pendingCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			}),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: false,
			onToggleLock: () => {},
		}),
	)
	expect(orgPrivate).toContain('People in your organization can see it')
})

test('owner details do not offer Update public listing when the catalog pin lags', async () => {
	const html = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'danj',
			packageDetail: packageDetail({
				isPrivate: false,
				hasCommunityListing: true,
				listingNeedsRepublish: true,
				publishedCommit: '4665dddb7b7347291bd99049ba0f67ca101ee082',
				publishedVersion: '1.5.0',
			}),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: false,
			onToggleLock: () => {},
		}),
	)

	expect(html).not.toContain('data-testid="package-update-public-listing"')
	expect(html).not.toContain('Update public listing')
	expect(html).toContain('data-testid="package-publishing-listing-syncing"')
	expect(html).toContain(
		'The community listing is catching up to this published version.',
	)
})

test('package managers without publish, delete, or adoption permission do not see those controls', async () => {
	const html = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'kentcdodds',
			packageDetail: packageDetail(),
			lockInFlight: false,
			viewerCanPublish: false,
			viewerCanDelete: false,
			viewerCanAdoptCommunityFork: false,
			onToggleLock: () => {},
		}),
	)
	expect(html).not.toContain('data-testid="package-visibility-controls"')
	expect(html).not.toContain('data-testid="package-publishing-panel"')
	expect(html).not.toContain('data-testid="account-package-delete"')
	expect(html).not.toContain('Delete package')
	expect(html).toContain('Not listed')
	expect(html).toContain('Forkable')
})

test('package settings forwards each server permission independently', async () => {
	for (const canPublish of [false, true]) {
		const html = await renderToString(
			jsx(PackageSettingsRoute, {
				data: {
					ok: true,
					listing: null,
					ownerProfilePublic: true,
					loggedIn: true,
					viewerIsAdmin: false,
					viewerIsOwner: false,
					viewerCanManage: true,
					viewerCanPublish: canPublish,
					viewerCanDelete: false,
					viewerCanAdoptCommunityFork: false,
					forkPrompt: '',
					viewerInstall: null,
					readmeContent: null,
					ownerPackage: packageDetail(),
					username: 'kentcdodds',
					kodyId: 'demo-app',
					isPrivate: false,
					invocationUrlOrigin: 'https://example.com',
				},
			}),
			'/@kentcdodds/demo-app/settings',
		)
		expect(html.includes('data-testid="package-visibility-controls"')).toBe(
			canPublish,
		)
		expect(html).not.toContain('Delete package')
	}
})

for (const fails of [false, true]) {
	test(`visibility pending state survives a new observer and clears after ${fails ? 'failure' : 'success'}`, async () => {
		const client = new QueryClient()
		let finish!: () => void
		const response = new Promise<void>((resolve) => {
			finish = resolve
		})
		const mutation = client.getMutationCache().build(client, {
			mutationKey: ['package', null, 'pkg-1'],
			meta: { operation: 'set-visibility' },
			mutationFn: async () => {
				await response
				if (fails) throw new Error('Response lost')
				return { ok: true }
			},
		})
		const settled = mutation.execute(undefined).catch(() => undefined)
		const render = () =>
			renderToString(
				jsx(AccountPackageOwnerDetails, {
					ownerUsername: 'kentcdodds',
					packageDetail: packageDetail(),
					lockInFlight: false,
					viewerCanPublish: true,
					viewerCanDelete: false,
					viewerCanAdoptCommunityFork: false,
					onToggleLock: () => {},
				}),
				'/@kentcdodds/demo-app/settings',
				null,
				(next) => {
					next.getMutationCache().add(mutation)
				},
			)
		try {
			// A navigation remount has no local submitting flag or original observer.
			const pending = await render()
			expect(pending).toMatch(
				/<button[^>]*disabled=""[^>]*data-testid="package-make-private"/,
			)
			finish()
			await settled
			const complete = await render()
			expect(complete).not.toMatch(
				/<button[^>]*disabled=""[^>]*data-testid="package-make-private"/,
			)
		} finally {
			finish()
			await settled
			client.clear()
		}
	})
}
