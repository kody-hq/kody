import { createElement as jsx } from 'react'
import { renderStartPage as renderToString } from './test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import {
	ProfileContent,
	type ProfileContentProps,
} from './components/profile-content.tsx'
import {
	type PublicCommunityProfile,
	type PublicProfilePackageItem,
} from '#universal/community-public-types.ts'

const profile = {
	username: 'kody',
	displayName: 'Kody',
	bio: null,
	avatarUrl: null,
	visibility: 'public',
	joinedAt: '2026-01-01T00:00:00.000Z',
	publicPackageCount: 2,
	listingCount: 1,
} satisfies PublicCommunityProfile

const listedPackage = {
	name: '@kody/fathom-analytics',
	kodyId: 'fathom-analytics',
	description: 'Read Fathom Analytics site stats.',
	tags: ['fathom', 'analytics'],
	updatedAt: '2026-08-07T00:00:00.000Z',
	createdAt: '2026-06-01T00:00:00.000Z',
	communityListingId: 'listing-1',
	communityListingKodyId: 'fathom-analytics',
	communityPublishedAt: '2026-07-28T00:00:00.000Z',
	needsRepublish: true,
	hasPackage: true,
	hasApp: true,
	webhookCount: 2,
	jobCount: 1,
	iconUrl: '/community/listing-1/icon/abc123',
} satisfies PublicProfilePackageItem

const unpublishedPackage = {
	name: '@kody/notes',
	kodyId: 'notes',
	description: 'Private notes helper.',
	tags: [],
	updatedAt: '2026-07-01T00:00:00.000Z',
	createdAt: '2026-05-01T00:00:00.000Z',
	communityListingId: null,
	communityListingKodyId: null,
	communityPublishedAt: null,
	needsRepublish: false,
	hasPackage: true,
	hasApp: false,
	webhookCount: 0,
	jobCount: 0,
	iconUrl: '/@kody/notes/icon/pub-1',
} satisfies PublicProfilePackageItem

async function render(
	props: Partial<ProfileContentProps> &
		Pick<ProfileContentProps, 'packages' | 'isSelf'>,
) {
	return renderToString(
		jsx(ProfileContent, { profile, activity: [], query: null, ...props }),
	)
}

function expectAll(html: string, parts: Array<string>) {
	expect(parts.filter((part) => !html.includes(part))).toEqual([])
}

const testId = (id: string) => `data-testid="${id}"`
const unpublishedTitle = 'title="Not published to Community"'

test('profile packages link listings, prefer listing kody ids, and separate published dates from local edits', async () => {
	const guestHtml = await render({
		packages: [listedPackage, unpublishedPackage],
		isSelf: false,
	})
	// Listed packages get one fork control; unpublished packages do not.
	expect(guestHtml.match(/aria-label="fork"/g)).toHaveLength(1)

	expectAll(guestHtml, [
		'href="/@kody/fathom-analytics"',
		'notes',
		'href="/@kody/notes"',
		testId('profile-package-icon'),
		'/community/listing-1/icon/abc123',
		// Listed packages report the listing's published date, not the owner's
		// unpublished local edit, which is what made the activity feed look stale.
		'Published July 28, 2026',
		'Edited July 1, 2026',
		testId('profile-activity-hint'),
	])
	expect(guestHtml).not.toContain('August 7, 2026')

	// Editing `kody.id` updates the package immediately; the listing's id only
	// moves on republish, so until then the page lives at the listing's id.
	const driftedHtml = await render({
		packages: [
			{
				...listedPackage,
				kodyId: 'fathom',
				communityListingKodyId: 'fathom-analytics',
			},
		],
		isSelf: false,
	})
	expect(driftedHtml).toContain('href="/@kody/fathom-analytics"')
	expect(driftedHtml).not.toContain('href="/@kody/fathom"')

	const guestEmptyHtml = await render({ packages: [], isSelf: false })
	expect(guestEmptyHtml).toContain('No public repositories to take yet.')
	expect(guestEmptyHtml).toContain(testId('profile-packages-empty'))

	const ownHtml = await render({ packages: [listedPackage], isSelf: true })
	expect(ownHtml).toContain('@kody')
	// Owners also see that the listing pin is behind the published commit.
	expect(ownHtml).toContain('edited August 7, 2026, not republished')

	// communityPublish bumps updated_at after published_at even when the pin
	// already matches HEAD / published_commit. That skew is not republish.
	const ownPublishSkewHtml = await render({
		packages: [
			{
				...listedPackage,
				updatedAt: '2026-07-28T00:00:01.044Z',
				communityPublishedAt: '2026-07-28T00:00:00.000Z',
				needsRepublish: false,
			},
		],
		isSelf: true,
	})
	expect(ownPublishSkewHtml).toContain('Published July 28, 2026')
	expect(ownPublishSkewHtml).not.toContain('not republished')

	const ownInventoryHtml = await render({
		packages: [{ ...unpublishedPackage, hidden: true, isPrivate: true }],
		isSelf: true,
	})
	expectAll(ownInventoryHtml, [
		'href="/@kody/notes"',
		'title="Hidden"',
		'title="Private"',
		'data-icon="lock"',
		'data-icon="eye"',
	])
	expect(ownInventoryHtml).not.toContain(unpublishedTitle)

	// A private repository that already has a community listing is published;
	// the lock is the privacy signal. Do not also mark it unpublished.
	const publishedPrivateHtml = await render({
		packages: [{ ...listedPackage, isPrivate: true }],
		isSelf: true,
	})
	expectAll(publishedPrivateHtml, [
		'title="Private"',
		'data-icon="lock"',
		'title="Published to community"',
		'data-icon="share"',
	])
	expect(publishedPrivateHtml).not.toContain(unpublishedTitle)

	const ownEmptyHtml = await render({ packages: [], isSelf: true })
	expect(ownEmptyHtml).toContain('You have no repositories yet.')
	expect(ownEmptyHtml).not.toContain('No public repositories to take yet.')
})

test('profile package filters render owner-only pills, keep other filters in each href, and explain an empty filtered list', async () => {
	const ownHtml = await render({
		packages: [listedPackage, unpublishedPackage],
		query: 'fathom',
		visibility: 'private',
		listing: 'all',
		hidden: 'all',
		isSelf: true,
	})
	const own = '/@kody?q=fathom&amp;visibility=private'
	const selectedFilter = [...ownHtml.matchAll(/<a\b[^>]*>/g)]
		.map((match) => match[0])
		.find((tag) => tag.includes(`href="${own}"`))
	expect(selectedFilter).toContain('aria-current="page"')
	expectAll(ownHtml, [
		testId('profile-package-filters'),
		'<details',
		'<summary',
		testId('profile-package-filter-visibility'),
		testId('profile-package-filter-listing'),
		testId('profile-package-filter-hidden'),
		testId('profile-package-filter-app'),
		testId('profile-package-filter-package'),
		testId('profile-package-sort'),
		testId('profile-package-sort-dir'),
		'data-prevent-scroll-reset',
		// The selected pill is marked; sibling pills in the same group are not.
		`href="${own}"`,
		'href="/@kody?q=fathom&amp;visibility=public"',
		// Switching one axis keeps the query and the other active filters.
		`href="${own}&amp;listing=ahead"`,
		`href="${own}&amp;hidden=yes"`,
		`href="${own}&amp;app=yes"`,
		`href="${own}&amp;package=yes"`,
		`href="${own}&amp;sort=name"`,
		`href="${own}&amp;sort=created"`,
		`href="${own}&amp;dir=asc"`,
		// Already-loaded packages are narrowed in render, not by a second fetch.
		'No repositories matched these filters.',
	])
	expect(ownHtml).not.toContain(
		'href="/@kody?q=fathom&amp;visibility=public" aria-current="page"',
	)
	// The visibility "All" pill drops only its own param and is not current.
	const allFilter = [...ownHtml.matchAll(/<a\b[^>]*>/g)]
		.map((match) => match[0])
		.find((tag) => tag.includes('href="/@kody?q=fathom"'))
	expect(allFilter).toBeDefined()
	expect(allFilter).not.toContain('aria-current')
	expect(ownHtml).not.toContain('href="/@kody/fathom-analytics"')

	const searchHtml = await render({
		packages: [listedPackage, unpublishedPackage],
		query: 'fathom',
		isSelf: false,
	})
	expect(searchHtml).toContain('href="/@kody/fathom-analytics"')
	expect(searchHtml).not.toContain('href="/@kody/notes"')

	const searchEmptyHtml = await render({
		packages: [listedPackage, unpublishedPackage],
		query: 'zzzz-no-match',
		isSelf: false,
	})
	expect(searchEmptyHtml).toContain('No repositories matched your search.')
	expect(searchEmptyHtml).toContain(testId('profile-packages-empty'))
	expect(searchEmptyHtml).not.toContain('href="/@kody/fathom-analytics"')

	const loaderAppliedHtml = await render({
		packages: [unpublishedPackage],
		query: 'fathom',
		queryAppliedByLoader: true,
		isSelf: false,
	})
	expect(loaderAppliedHtml).toContain('href="/@kody/notes"')
	expect(loaderAppliedHtml).not.toContain(testId('profile-packages-empty'))

	// Guests see listing, package, app, and sort; visibility and hidden stay owner-only.
	const guestHtml = await render({
		packages: [listedPackage, unpublishedPackage],
		listing: 'published',
		isSelf: false,
	})
	const guestSelected = [...guestHtml.matchAll(/<a\b[^>]*>/g)]
		.map((match) => match[0])
		.find((tag) => tag.includes('href="/@kody?listing=published"'))
	expect(guestSelected).toContain('aria-current="page"')
	expectAll(guestHtml, [
		testId('profile-package-filters'),
		testId('profile-package-filter-listing'),
		testId('profile-package-filter-package'),
		testId('profile-package-filter-app'),
		testId('profile-package-sort'),
		testId('profile-package-sort-dir'),
		'href="/@kody?listing=published"',
		'href="/@kody?listing=unpublished"',
		'href="/@kody/fathom-analytics"',
	])
	for (const absent of [
		'href="/@kody/notes"',
		testId('profile-package-filter-visibility'),
		testId('profile-package-filter-hidden'),
		'visibility=private',
		'listing=ahead',
	]) {
		expect(guestHtml).not.toContain(absent)
	}

	// A guest profile with nothing to show has nothing to filter either.
	expect(await render({ packages: [], isSelf: false })).not.toContain(
		testId('profile-package-filters'),
	)

	// Owners keep the toolbar when a filter empties the list so they can back out.
	const ownFilteredEmptyHtml = await render({
		packages: [],
		visibility: 'private',
		isSelf: true,
	})
	expectAll(ownFilteredEmptyHtml, [
		testId('profile-package-filters'),
		'No repositories matched these filters.',
		'href="/@kody"',
	])
	expect(ownFilteredEmptyHtml).not.toContain('You have no repositories yet.')
})

test('profile repository rows show package, webhook, job, and app signifiers with count tooltips', async () => {
	const html = await render({
		packages: [listedPackage, unpublishedPackage],
		isSelf: true,
	})
	expectAll(html, [
		testId('profile-package-signifiers'),
		'title="Package"',
		'data-icon="box"',
		'title="2 webhooks"',
		'data-icon="cloud"',
		'title="1 job"',
		'data-icon="briefcase"',
		'title="Has an app"',
		'data-icon="globe"',
		'title="Published to community"',
		'data-icon="share"',
		unpublishedTitle,
		'data-icon="inbox"',
	])
	expect(html).not.toContain('title="0 webhooks"')
	expect(html).not.toContain('title="0 jobs"')
	expect(html).not.toContain('title="Repo"')
})

test('plain repo rows show the Repo signifier, link to the repo page, and omit Community chips', async () => {
	const plainRepo = {
		name: '@kody/stash-files',
		kodyId: 'stash-files',
		description: 'Plain Artifacts repo.',
		tags: [],
		updatedAt: '2026-08-01T00:00:00.000Z',
		createdAt: '2026-07-01T00:00:00.000Z',
		communityListingId: null,
		communityListingKodyId: null,
		communityPublishedAt: null,
		needsRepublish: false,
		hasPackage: false,
		hasApp: false,
		webhookCount: 0,
		jobCount: 0,
		iconUrl: '/@kody/stash-files/icon/idx-1',
		isPrivate: true,
	} satisfies PublicProfilePackageItem
	const html = await render({
		packages: [plainRepo],
		isSelf: true,
	})
	expectAll(html, [
		'href="/@kody/stash-files"',
		'title="Repo"',
		'data-icon="folder"',
		'/@kody/stash-files/icon/idx-1',
		'title="Private"',
	])
	expect(html).not.toContain('title="Package"')
	expect(html).not.toContain(unpublishedTitle)
	expect(html).not.toContain('title="Published to community"')
})

test('profile omits the activity section when activity is null', async () => {
	const html = await render({
		packages: [listedPackage],
		isSelf: true,
		activity: null,
	})
	expect(html).not.toContain(testId('profile-activity'))
	expect(html).not.toContain('Recent activity')
	expect(html).not.toContain('No public activity yet.')
})

test('execute-only package rows render the name without a package page link', async () => {
	const html = await render({
		packages: [{ ...unpublishedPackage, canOpenDetail: false }],
		isSelf: true,
	})
	expect(html).toContain(testId('profile-package-name-nolink'))
	expect(html).toContain('notes')
	expect(html).not.toContain('href="/@kody/notes"')
})
