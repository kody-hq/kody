import { expect, test } from 'vitest'
import { jsx } from 'react/jsx-runtime'
import { CommunityListingsContent } from '../components/community-listings-content.tsx'
import { renderStartPage } from '../test-support/render-start-page.ts'
const renderCommunityListingsContentHtml = async (
	props: Parameters<typeof CommunityListingsContent>[0],
) =>
	(await renderStartPage(jsx(CommunityListingsContent, props))).replace(
		/<!-- -->/g,
		'',
	)
import { type PublicCommunityListing } from '#universal/community-public-types.ts'

const sampleListing = {
	id: 'listing-1',
	kodyId: 'github-triage',
	name: '@kentcdodds/github-triage',
	description: 'Triage GitHub issues.',
	iconUrl: '/community/listing-1/icon/abc1234567890',
	tags: ['github'],
	category: 'integrations',
	readmeContent: '# README',
	license: 'MIT',
	version: '1.0.4',
	pinnedCommit: 'abc1234567890',
	publishedAt: '2026-07-13T00:00:00.000Z',
	ownerUsername: 'kentcdodds',
	trusted: false,
	featured: false,
	averageStars: 4.5,
	ratingCount: 2,
	averageAdaptationEffort: 3,
	forkCount: 1,
} satisfies PublicCommunityListing

type RenderInput = Parameters<typeof renderCommunityListingsContentHtml>[0]
type ViewerInstall = NonNullable<PublicCommunityListing['viewerInstall']>

/** Renders and reports which `present` markers are missing and which `absent` ones leaked. */
async function markerGaps(
	input: Partial<RenderInput>,
	present: Array<string>,
	absent: Array<string> = [],
) {
	const html = await renderCommunityListingsContentHtml({
		listings: [],
		query: null,
		...input,
	})
	return {
		missing: present.filter((marker) => !html.includes(marker)),
		unexpected: absent.filter((marker) => html.includes(marker)),
	}
}

const noGaps = { missing: [], unexpected: [] }

const testId = (id: string) => `data-testid="${id}"`

function withInstall(install: Partial<ViewerInstall> = {}) {
	return {
		...sampleListing,
		viewerInstall: {
			status: 'installed',
			targetName: '@me/github-triage',
			agentPrompt: 'Finish setup for @me/github-triage.',
			packageId: 'pkg-1',
			listingAhead: false,
			listingAheadPrompt: null,
			forkAhead: false,
			listingDiffHref: null,
			...install,
		} satisfies ViewerInstall,
	}
}

test('community listings render sort controls, categories, empty states, and fork-outdated', async () => {
	expect(
		await markerGaps({ query: 'obsidian', sort: 'newest' }, [
			testId('community-create-prompt'),
			'search({ entity: [&quot;guide:package_authoring&quot;, &quot;guide:package_lifecycle&quot;] })',
			'obsidian',
			'href="/docs/package-authoring"',
			'href="/community?sort=newest"',
			testId('community-listings-sort'),
			'aria-current="page"',
		]),
	).toEqual(noGaps)

	expect(
		await markerGaps(
			{},
			['href="/onboarding"'],
			[
				testId('community-create-prompt'),
				testId('community-listings-categories'),
				testId('community-listings-sort'),
			],
		),
	).toEqual(noGaps)

	expect(
		await markerGaps(
			{ listings: [sampleListing], sort: 'newest' },
			[
				testId('community-listing-published-listing-1'),
				testId('community-listing-version-listing-1'),
				'href="/community?sort=newest"',
				'href="/community"',
				'min-height:44px',
				testId('community-listings-categories'),
				'href="/community?sort=newest&amp;category=integrations"',
			],
			['category=utilities', 'category=other'],
		),
	).toEqual(noGaps)

	const integrationsGroup = (total: number) => ({
		listings: [sampleListing],
		groups: [
			{ category: 'integrations' as const, listings: [sampleListing], total },
		],
		sort: 'best' as const,
	})
	expect(
		await markerGaps(
			integrationsGroup(4),
			[
				testId('community-listings-overview'),
				'href="/community?category=integrations"',
			],
			['category=apps'],
		),
	).toEqual(noGaps)
	expect(
		await markerGaps(
			integrationsGroup(1),
			[testId('community-listings-overview')],
			['>See all '],
		),
	).toEqual(noGaps)

	expect(
		await markerGaps(
			{ category: 'apps' },
			[
				'href="/community"',
				testId('community-listings-categories'),
				'href="/community?category=apps"',
			],
			['category=utilities'],
		),
	).toEqual(noGaps)

	expect(
		await markerGaps(
			{
				listings: [sampleListing],
				category: 'integrations',
				categoryCounts: {
					integrations: 1200,
					examples: 40,
					productivity: 0,
					apps: 0,
					utilities: 0,
					other: 0,
				},
			},
			['category=integrations', 'category=examples'],
			['category=utilities', 'category=other'],
		),
	).toEqual(noGaps)

	expect(
		await markerGaps(
			{ listings: [withInstall()] },
			[testId('community-listing-viewer-install-listing-1')],
			[
				'data-copy-prompt',
				testId('community-listing-ahead-listing-1'),
				testId('community-detail-install'),
			],
		),
	).toEqual(noGaps)

	const aheadPrompt =
		'Compare the current listing snapshot, keep local customizations, then publish with repoPublishSession and absorbed_upstream_commit.'
	expect(
		await markerGaps(
			{
				listings: [
					withInstall({
						listingAhead: true,
						listingAheadPrompt: aheadPrompt,
						listingDiffHref: '/@kentcdodds/github-triage/tree/commit-new',
					}),
				],
			},
			[
				testId('community-listing-ahead-listing-1'),
				'data-fork-outdated-copy',
				aheadPrompt,
				'href="/@kentcdodds/github-triage/tree/commit-new"',
			],
			[testId('community-listing-viewer-install-listing-1')],
		),
	).toEqual(noGaps)

	expect(
		await markerGaps(
			{
				listings: [
					withInstall({
						forkAhead: true,
						listingDiffHref: '/@kentcdodds/github-triage/tree/commit-pin',
					}),
				],
			},
			[
				testId('community-listing-fork-ahead-listing-1'),
				'Fork ahead',
				'href="/@kentcdodds/github-triage/tree/commit-pin"',
			],
			['data-copy-prompt', 'data-fork-outdated-copy'],
		),
	).toEqual(noGaps)
})
