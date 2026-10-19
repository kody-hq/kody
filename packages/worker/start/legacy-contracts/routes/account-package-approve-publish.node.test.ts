import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { AccountPackageApprovePublishRoute } from '../../pages/account-package-approve-publish.tsx'
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
	allowedPackagesPublishNotice: null,
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
		jsx(AccountPackageApprovePublishRoute, {
			payload: loaderData,
			username: 'kodykoala',
			kodyId: 'gmail-drafts',
		}),
		approvePublishHref,
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

test('approve-publish notes listing sync when the catalog pin still lags', async () => {
	const html = await renderToString(
		jsx(AccountPackageApprovePublishRoute, {
			payload: {
				...loaderData,
				listing: {
					pinnedVersion: '1.4.0',
					promotedVersion: '1.5.0',
					behind: true,
					updateHint: 'Background sync is catching up.',
					updateUrl: '/@kodykoala/gmail-drafts/settings#update-public-listing',
				},
			},
			username: 'kodykoala',
			kodyId: 'gmail-drafts',
		}),
		approvePublishHref,
	)
	expect(html).toContain('data-testid="approve-publish-listing-syncing"')
	expect(html).toContain('catching up to this published version')
	expect(html).not.toContain('Update public listing')
})
test('approve-publish does not warn that promote leaves the listing behind', async () => {
	const html = await renderToString(
		jsx(AccountPackageApprovePublishRoute, {
			payload: {
				...loaderData,
				listing: null,
				listingWillLagAfterPromote: false,
			},
			username: 'kodykoala',
			kodyId: 'gmail-drafts',
		}),
		approvePublishHref,
	)
	expect(html).not.toContain('data-testid="approve-publish-listing-will-lag"')
	expect(html).not.toContain('data-testid="approve-publish-listing-syncing"')
})

test('unlocked approve-publish SSR offers Publish HEAD', async () => {
	const html = await renderToString(
		jsx(AccountPackageApprovePublishRoute, {
			payload: {
				...loaderData,
				package: { ...loaderData.package, lockedAt: null },
			},
			username: 'kodykoala',
			kodyId: 'gmail-drafts',
		}),
		approvePublishHref,
	)

	expect(html).toContain('Publish HEAD')
	expect(html).toContain('data-testid="approve-package-publish"')
	expect(html).not.toContain('Promote this commit')
})

test('approve-publish with nothing pending uses a plain up-to-date title', async () => {
	const html = await renderToString(
		jsx(AccountPackageApprovePublishRoute, {
			payload: {
				...loaderData,
				pendingCommit: loaderData.publishedCommit,
				alreadyPublished: true,
				pendingIsDefaultHead: true,
				diff: { files: [], omittedCount: 0 },
			},
			username: 'kodykoala',
			kodyId: 'gmail-drafts',
		}),
		'/@kodykoala/gmail-drafts/approve-publish',
	)

	expect(html).toContain(
		'Nothing to publish: the public version is up to date at aaaaaaa',
	)
	expect(html).toContain('No unpublished commit is waiting')
	expect(html).toContain('data-testid="approve-publish-empty-state"')
	expect(html).toContain('You are all caught up.')
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
		jsx(AccountPackageApprovePublishRoute, {
			payload: {
				...loaderData,
				pendingCommit: loaderData.publishedCommit,
				alreadyPublished: true,
				pendingIsDefaultHead: false,
				diff: { files: [], omittedCount: 0 },
			},
			username: 'kodykoala',
			kodyId: 'gmail-drafts',
		}),
		'/@kodykoala/gmail-drafts/approve-publish?commit=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	)

	expect(html).toContain('This commit is already published at aaaaaaa')
	expect(html).toContain('Open Approve without a commit pin')
	expect(html).not.toContain('the public version is up to date')
	expect(html).not.toContain('No unpublished commit is waiting')
})

test.each([
	'This publish keeps secret mount wakeToken. Stale static dependents: @kentcdodds/dependent.',
	'This publish removes secret mount wakeToken. Stale static dependents: @kentcdodds/dependent. Removing the mount will break those dependents.',
])(
	'approve-publish SSR shows the authoritative secret mount warning: %s',
	async (notice) => {
		const html = await renderToString(
			jsx(AccountPackageApprovePublishRoute, {
				payload: { ...loaderData, secretMountCompatNotice: notice },
				username: 'kodykoala',
				kodyId: 'gmail-drafts',
			}),
			approvePublishHref,
		)
		expect(html).toContain('data-testid="secret-mount-compat-notice"')
		expect(html).toContain(notice)
	},
)

test('approve-publish SSR shows the allowed-packages publish warning', async () => {
	const notice =
		'Credential "RESEND_API_KEY" is allowed only for @kodykoala/notes, not @kodykoala/gmail-drafts. Starting Wednesday, Oct 21, 2026, Kody enforces allowed-package lists everywhere.'
	const html = await renderToString(
		jsx(AccountPackageApprovePublishRoute, {
			payload: { ...loaderData, allowedPackagesPublishNotice: notice },
			username: 'kodykoala',
			kodyId: 'gmail-drafts',
		}),
		approvePublishHref,
	)
	expect(html).toContain('data-testid="allowed-packages-publish-notice"')
	expect(html).toContain('RESEND_API_KEY')
	expect(html).toContain('@kodykoala/notes')
	expect(html).toContain('Wednesday, Oct 21, 2026')
})
