import { jsx } from 'remix/component/jsx-runtime'
import { renderToString } from 'remix/component/server'
import { expect, test } from 'vitest'
import { AppLoaderDataProvider } from '#client/loader-data-context.tsx'
import { RouterLocationProvider } from '#client/router-location.tsx'
import { AccountPackageApprovePublishRoute } from '#client/routes/account-package-approve-publish.tsx'
import { type AccountPackageApprovePublishLoaderData } from '#universal/loader-data.ts'

const approvePublishHref =
	'/@kodykoala/gmail-drafts/approve-publish?commit=34f338c19f91c698c3a28edd2992e0ab87dcb4e0'

const loaderData: AccountPackageApprovePublishLoaderData = {
	ok: true,
	email: 'owner@example.com',
	package: {
		id: '1c43570a-b9ab-46c9-86ec-6c9f02926944',
		name: '@kodykoala/gmail-drafts',
		kodyId: 'gmail-drafts',
		sourceId: 'source-1',
		lockedAt: '2026-08-31T18:00:00.000Z',
	},
	publishedCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	pendingCommit: '34f338c19f91c698c3a28edd2992e0ab87dcb4e0',
	alreadyPublished: false,
	pendingIsDefaultHead: true,
	filesHref: '/@kodykoala/gmail-drafts/tree/main',
	packageHref: '/@kodykoala/gmail-drafts',
	listing: null,
	listingWillLagAfterPromote: false,
	secretMountCompatNotice: null,
	diff: {
		files: [
			{
				path: 'README.md',
				status: 'modified',
				patch:
					'--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-# Drafts\n+# Gmail drafts\n',
			},
		],
		omittedCount: 0,
	},
}

test('approve-publish SSR renders the promote card without a browser location', async () => {
	// Workers SSR has no `location` global. The previous setup-phase read of
	// `location.pathname` threw and streamed a blank document for the
	// documented locked-package approval_url.
	expect(typeof globalThis.location).toBe('undefined')

	const html = await renderToString(
		jsx(RouterLocationProvider, {
			url: approvePublishHref,
			children: jsx(AppLoaderDataProvider, {
				loaderData: { accountPackageApprovePublish: loaderData },
				children: jsx(AccountPackageApprovePublishRoute, {}),
			}),
		}),
	)

	expect(html).toContain('Approve package publish')
	expect(html).toContain('data-testid="package-approve-publish-card"')
	expect(html).toContain('@kodykoala/gmail-drafts')
	// Commit ids live in a collapsed Details disclosure; the slug is gone.
	const detailsIndex = html.indexOf(
		'data-testid="package-approve-publish-details"',
	)
	expect(detailsIndex).toBeGreaterThan(-1)
	const details = html.slice(detailsIndex)
	expect(details.slice(0, details.indexOf('>'))).not.toContain(' open')
	expect(details).toContain('<summary>Details</summary>')
	expect(details).toContain('34f338c19f91c698c3a28edd2992e0ab87dcb4e0')
	expect(details).toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
	expect(html.slice(0, detailsIndex)).not.toContain(
		'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	)
	expect(html).not.toContain('Kody id')
	expect(html).toContain('Promote this commit')
	expect(html).toContain('Browse published files')
	expect(html).toContain('data-testid="package-publish-diff"')
	expect(html).toContain('README.md')
	expect(html).toContain('# Gmail drafts')
	expect(html).not.toContain(
		'data-testid="approve-publish-update-public-listing"',
	)
})

test('approve-publish SSR notes listing sync when the catalog pin still lags', async () => {
	const html = await renderToString(
		jsx(RouterLocationProvider, {
			url: approvePublishHref,
			children: jsx(AppLoaderDataProvider, {
				loaderData: {
					accountPackageApprovePublish: {
						...loaderData,
						listing: {
							pinnedVersion: '1.4.0',
							promotedVersion: '1.5.0',
							behind: true,
							updateHint: 'Background sync is catching up.',
							updateUrl:
								'/@kodykoala/gmail-drafts/settings#update-public-listing',
						},
					},
				},
				children: jsx(AccountPackageApprovePublishRoute, {}),
			}),
		}),
	)

	expect(html).toContain('data-testid="approve-publish-listing-syncing"')
	expect(html).toContain('catching up to this published version')
	expect(html).not.toContain('Update public listing')
})

test('approve-publish SSR does not warn that promote leaves the listing behind', async () => {
	const html = await renderToString(
		jsx(RouterLocationProvider, {
			url: approvePublishHref,
			children: jsx(AppLoaderDataProvider, {
				loaderData: {
					accountPackageApprovePublish: {
						...loaderData,
						listing: null,
						listingWillLagAfterPromote: false,
					},
				},
				children: jsx(AccountPackageApprovePublishRoute, {}),
			}),
		}),
	)

	expect(html).not.toContain('data-testid="approve-publish-listing-will-lag"')
	expect(html).not.toContain('data-testid="approve-publish-listing-syncing"')
})

test('unlocked approve-publish SSR offers Publish HEAD', async () => {
	const html = await renderToString(
		jsx(RouterLocationProvider, {
			url: approvePublishHref,
			children: jsx(AppLoaderDataProvider, {
				loaderData: {
					accountPackageApprovePublish: {
						...loaderData,
						package: { ...loaderData.package, lockedAt: null },
					},
				},
				children: jsx(AccountPackageApprovePublishRoute, {}),
			}),
		}),
	)

	expect(html).toContain('Publish HEAD')
	expect(html).toContain('data-testid="approve-package-publish"')
	expect(html).not.toContain('Promote this commit')
})

test('approve-publish with nothing pending uses a plain up-to-date title', async () => {
	const html = await renderToString(
		jsx(RouterLocationProvider, {
			url: '/@kodykoala/gmail-drafts/approve-publish',
			children: jsx(AppLoaderDataProvider, {
				loaderData: {
					accountPackageApprovePublish: {
						...loaderData,
						pendingCommit: loaderData.publishedCommit,
						alreadyPublished: true,
						pendingIsDefaultHead: true,
						diff: { files: [], omittedCount: 0 },
					},
				},
				children: jsx(AccountPackageApprovePublishRoute, {}),
			}),
		}),
	)

	expect(html).toContain(
		'Nothing to publish: the public version is up to date at aaaaaaa',
	)
	expect(html).toContain('No unpublished commit is waiting')
	expect(html).not.toContain('Public version')
	expect(html).not.toContain('Current published commit')
	expect(html).not.toContain('Commit to promote')
	expect(html).not.toContain('HEAD to publish')
	expect(html).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
	expect(html).toContain('Back to package')
	expect(html).not.toContain('data-testid="approve-package-publish"')
})

test('approve-publish for an already-published commit pin does not claim HEAD is up to date', async () => {
	const html = await renderToString(
		jsx(RouterLocationProvider, {
			url: '/@kodykoala/gmail-drafts/approve-publish?commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			children: jsx(AppLoaderDataProvider, {
				loaderData: {
					accountPackageApprovePublish: {
						...loaderData,
						pendingCommit: loaderData.publishedCommit,
						alreadyPublished: true,
						pendingIsDefaultHead: false,
						diff: { files: [], omittedCount: 0 },
					},
				},
				children: jsx(AccountPackageApprovePublishRoute, {}),
			}),
		}),
	)

	expect(html).toContain('This commit is already published at aaaaaaa')
	expect(html).toContain('Open Approve without a commit pin')
	expect(html).not.toContain('the public version is up to date')
	expect(html).not.toContain('No unpublished commit is waiting')
})

test('approve-publish SSR shows the secret mount compat notice', async () => {
	const notice =
		'This publish removes secret mount wakeToken. Stale static dependents still bundling that mount: @kentcdodds/dependent. Removing the mount or deleting the secret will break those dependents.'
	const html = await renderToString(
		jsx(RouterLocationProvider, {
			url: approvePublishHref,
			children: jsx(AppLoaderDataProvider, {
				loaderData: {
					accountPackageApprovePublish: {
						...loaderData,
						secretMountCompatNotice: notice,
					},
				},
				children: jsx(AccountPackageApprovePublishRoute, {}),
			}),
		}),
	)
	expect(html).toContain('data-testid="secret-mount-compat-notice"')
	expect(html).toContain('@kentcdodds/dependent')
	expect(html).toContain('will break those dependents')
})
