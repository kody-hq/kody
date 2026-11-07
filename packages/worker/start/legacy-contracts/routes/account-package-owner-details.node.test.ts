import { QueryClient } from '@tanstack/react-query'
import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { PackageSettingsRoute } from '../../pages/package-settings.tsx'
import { AccountPackageOwnerDetails } from '../../pages/account-package-owner-details.tsx'
import type { AccountPackageDetail } from '#universal/loader-data.ts'

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

test('cookie warning callout is shown only in the owner package details view', async () => {
	const warning = {
		cookieName: '__kapp_a_session',
		reason: 'added_httponly' as const,
		lastSeenAt: '2026-10-22T12:00:00.000Z',
	}
	const ownerHtml = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'kentcdodds',
			packageDetail: packageDetail({ cookieWarnings: [warning] }),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: true,
			onToggleLock: () => {},
		}),
	)
	expect(ownerHtml).toContain('data-testid="package-cookie-warnings"')
	expect(ownerHtml).toContain('__kapp_a_session')

	const nonOwnerHtml = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'kentcdodds',
			packageDetail: packageDetail({ cookieWarnings: [warning] }),
			lockInFlight: false,
			viewerCanPublish: false,
			viewerCanDelete: false,
			viewerCanAdoptCommunityFork: false,
			onToggleLock: () => {},
		}),
	)
	expect(nonOwnerHtml).not.toContain('data-testid="package-cookie-warnings"')
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

test('owner details show custom domain status, with records only while not active', async () => {
	const html = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'acme',
			packageDetail: packageDetail({
				ownerIsPersonal: false,
				customDomains: [
					{
						id: 'domain-pending',
						hostname: 'apps.example.com',
						bindingKind: 'app',
						status: {
							state: 'pending',
							reason: 'Waiting for Cloudflare to find the CNAME.',
						},
						records: [
							{
								type: 'CNAME',
								name: 'apps.example.com',
								relativeName: 'apps',
								value: 'domains.kody.run',
								purpose: 'routing',
							},
						],
						verifiedAt: null,
						lastCheckedAt: '2026-10-20T12:00:00.000Z',
					},
					{
						id: 'domain-active',
						hostname: 'live.example.com',
						bindingKind: 'app',
						status: { state: 'active', reason: null },
						records: [
							{
								type: 'CNAME',
								name: 'live.example.com',
								relativeName: 'live',
								value: 'domains.kody.run',
								purpose: 'routing',
							},
						],
						verifiedAt: '2026-10-20T12:00:00.000Z',
						lastCheckedAt: '2026-10-20T12:00:00.000Z',
					},
				],
			}),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: true,
			onToggleLock: () => {},
		}),
	)
	expect(html).toContain('data-testid="package-custom-domains"')
	expect(html).toContain('data-custom-domain-state="pending"')
	expect(html).toContain('data-custom-domain-state="active"')
	expect(html).toContain('DNS only')
	expect(html).toContain('domains.kody.run')
	expect(html).toContain('href="https://live.example.com/"')
	expect(html).toContain('href="/@acme/-/settings"')
	const activeRow = html.slice(
		html.indexOf('data-testid="custom-domain-domain-active"'),
	)
	expect(activeRow).not.toContain('<table')
})

test('owner details omit the custom domain section when the package has none', async () => {
	const html = await renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'acme',
			packageDetail: packageDetail(),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: true,
			onToggleLock: () => {},
		}),
	)
	expect(html).not.toContain('package-custom-domains')
})

function renderOwner(overrides: Partial<AccountPackageDetail> = {}) {
	return renderToString(
		jsx(AccountPackageOwnerDetails, {
			ownerUsername: 'kentcdodds',
			packageDetail: packageDetail(overrides),
			lockInFlight: false,
			viewerCanPublish: true,
			viewerCanDelete: true,
			viewerCanAdoptCommunityFork: false,
			onToggleLock: () => {},
		}),
	)
}

function sectionHtml(html: string, testId: string) {
	const start = html.indexOf(`data-testid="${testId}"`)
	expect(start).toBeGreaterThan(-1)
	const sectionStart = html.lastIndexOf('<section', start)
	const end = html.indexOf('</section>', start)
	return html.slice(sectionStart, end)
}

test('owner settings split Visibility, Source sharing, and Public release into titled sections', async () => {
	const html = await renderOwner({
		publishedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		pendingCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		lockedAt: '2026-09-12T00:00:00.000Z',
	})

	const visibility = sectionHtml(html, 'package-settings-visibility')
	expect(visibility).toContain('>Visibility</h3>')
	expect(visibility).toContain('Choose who can use the hosted app.')
	expect(visibility).toContain(
		'data-testid="package-internet-visible-controls"',
	)
	expect(visibility).not.toContain('package-make-public')

	const sourceSharing = sectionHtml(html, 'package-settings-source-sharing')
	expect(sourceSharing).toContain('>Source sharing</h3>')
	expect(sourceSharing).toContain('Choose who can read and fork the source.')
	expect(sourceSharing).toContain('data-testid="package-make-private"')
	expect(sourceSharing).toContain('Anyone can see it on the community')
	expect(sourceSharing).not.toContain('package-internet-visible')

	const release = sectionHtml(html, 'package-publishing-panel')
	expect(release).toContain('>Public release</h3>')
	expect(release).toContain('Choose which version of this package is live.')
	expect(release).toContain('data-testid="package-published-commit"')
	expect(release).toContain('Publish lock is on.')

	expect(html).toContain('data-testid="package-settings-independent-note"')
	expect(html.indexOf('package-settings-visibility')).toBeLessThan(
		html.indexOf('package-settings-source-sharing'),
	)
	expect(html.indexOf('package-settings-source-sharing')).toBeLessThan(
		html.indexOf('package-publishing-panel'),
	)
	expect(html.match(/data-testid="package-publishing-panel"/g)).toHaveLength(1)
})

test('public release counts unpublished commits and links each into the approve flow', async () => {
	const published = 'a'.repeat(40)
	const commits = ['d'.repeat(40), 'c'.repeat(40), 'b'.repeat(40)]
	const html = await renderOwner({
		publishedCommit: published,
		pendingCommit: commits[0]!,
		unpublishedChangeCount: 7,
		unpublishedCommits: {
			truncated: false,
			commits: commits.map((commit, index) => ({
				commit,
				subject: `Change ${index}`,
				authoredAt: null,
			})),
		},
	})
	expect(html).toContain('3 commits not yet published')
	expect(html).toContain('data-testid="package-release-commit-picker"')
	for (const commit of commits) {
		expect(html).toContain(
			`href="/@kentcdodds/demo-app/approve-publish?commit=${commit}"`,
		)
	}
	expect(html.match(/package-release-commit-option/g)).toHaveLength(3)
	expect(html).toContain('href="/@kentcdodds/demo-app/approve-publish"')

	const one = await renderOwner({
		publishedCommit: published,
		pendingCommit: commits[0]!,
		unpublishedCommits: {
			truncated: true,
			commits: [{ commit: commits[0]!, subject: 'Only', authoredAt: null }],
		},
	})
	expect(one).toContain('More than 1 commits not yet published')

	const upToDate = await renderOwner({
		publishedCommit: published,
		pendingCommit: published,
		unpublishedCommits: {
			truncated: false,
			commits: [{ commit: commits[0]!, subject: 'Stale', authoredAt: null }],
		},
	})
	expect(upToDate).not.toContain('package-release-commit-picker')
	expect(upToDate).not.toContain('not yet published')
})

test('internet-visible warns and needs an extra confirm only when owner-scoped capabilities exist', async () => {
	const owned = await renderOwner({
		publishedCommit: 'a'.repeat(40),
		pendingCommit: 'a'.repeat(40),
		anonymousVisitorExposure: {
			known: true,
			items: [
				{
					kind: 'credential',
					name: 'GitHub token',
					detail: 'credential("github")',
				},
				{ kind: 'connector', name: 'mcp:home:court_get_status', detail: null },
			],
		},
	})
	const visibility = sectionHtml(owned, 'package-settings-visibility')
	expect(visibility).toContain(
		'data-testid="package-internet-visible-owner-data-warning"',
	)
	expect(visibility).toContain('Anyone with the URL could use')
	expect(visibility).toContain('GitHub token')
	expect(visibility).toContain('mcp:home:court_get_status')
	expect(visibility).toContain(
		'data-testid="package-internet-visible-owner-data-confirm"',
	)
	expect(visibility).toMatch(
		/<button[^>]*disabled=""[^>]*data-testid="package-internet-visible-on"/,
	)

	const unknown = await renderOwner({
		anonymousVisitorExposure: { known: false },
	})
	expect(unknown).toContain(
		'data-testid="package-internet-visible-owner-data-confirm"',
	)

	for (const html of [
		await renderOwner({ anonymousVisitorExposure: { known: true, items: [] } }),
		await renderOwner({}),
		await renderOwner({
			isInternetVisible: true,
			anonymousVisitorExposure: {
				known: true,
				items: [{ kind: 'credential', name: 'GitHub token', detail: null }],
			},
		}),
	]) {
		expect(html).not.toContain('package-internet-visible-owner-data-warning')
		expect(html).not.toContain('package-internet-visible-owner-data-confirm')
		expect(html).not.toMatch(
			/<button[^>]*disabled=""[^>]*data-testid="package-internet-visible-o/,
		)
	}
})
