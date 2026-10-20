import { buildPackageRepoActions } from '#app/package-repo-actions.ts'
import { expect, test } from 'vitest'
import { jsx } from 'react/jsx-runtime'
import { CommunityDetailContent } from '../components/community-detail-content.tsx'
import { renderStartPage } from '../test-support/render-start-page.ts'
const renderCommunityDetailContentHtml = async (
	props: Parameters<typeof CommunityDetailContent>[0],
) =>
	(await renderStartPage(jsx(CommunityDetailContent, props))).replace(
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

type RenderInput = Omit<
	Parameters<typeof renderCommunityDetailContentHtml>[0],
	'repoActions'
> & {
	loggedIn: boolean
	hasApp: boolean
	listingNeedsRepublish: boolean
	follow?: Parameters<typeof buildPackageRepoActions>[0]['follow']
}
type ViewerInstall = NonNullable<PublicCommunityListing['viewerInstall']>

/**
 * Signed-in, non-owner view of the sample listing unless overridden. The
 * action group comes from the same builder the frame uses.
 */
function render(overrides: Partial<RenderInput> = {}) {
	const {
		loggedIn,
		hasApp,
		listingNeedsRepublish,
		follow,
		...props
	}: RenderInput = {
		listing: sampleListing,
		username: 'kentcdodds',
		kodyId: 'github-triage',
		description: sampleListing.description,
		isPrivate: false,
		ownerProfilePublic: true,
		viewerIsOwner: false,
		viewerCanManage: false,
		loggedIn: true,
		hasApp: false,
		listingNeedsRepublish: false,
		...overrides,
	}
	return renderCommunityDetailContentHtml({
		...props,
		repoActions: buildPackageRepoActions({
			username: props.username,
			kodyId: props.kodyId,
			listing: props.listing,
			viewerIsOwner: props.viewerIsOwner,
			viewerCanManage: props.viewerCanManage,
			loggedIn,
			ownerPackage: { hasApp, listingNeedsRepublish },
			follow,
		}),
	})
}

const agentPrompt =
	'Call packageGet for @me/github-triage and adapt it to my needs.'

function withInstall(install: Partial<ViewerInstall>) {
	return {
		...sampleListing,
		viewerInstall: {
			status: 'installed',
			targetName: '@me/github-triage',
			agentPrompt,
			packageId: 'pkg-1',
			listingAhead: false,
			listingAheadPrompt: null,
			forkAhead: false,
			listingDiffHref: null,
			...install,
		} satisfies ViewerInstall,
	}
}

function expectMarkers(
	html: string,
	present: Array<string>,
	absent: Array<string> = [],
) {
	expect(present.filter((marker) => !html.includes(marker))).toEqual([])
	expect(absent.filter((marker) => html.includes(marker))).toEqual([])
}

const testId = (id: string) => `data-testid="${id}"`

test('community detail head covers install, installed, and listing-ahead badges', async () => {
	const installHtml = await render()
	expectMarkers(installHtml, [
		testId('package-repo-actions'),
		testId('community-detail-install'),
		'data-community-install',
		'data-package-title-status="verify"',
		'data-icon="git-fork"',
		'data-trusted="false"',
		'data-title-status-label="true">Fork<',
	])
	expect(
		installHtml.indexOf(testId('community-detail-install')),
	).toBeGreaterThan(installHtml.indexOf(testId('package-repo-actions')))

	expectMarkers(
		await render({ listing: withInstall({}) }),
		[
			'data-package-title-status="open"',
			'data-icon="arrow-up-right"',
			'href="/@me/github-triage"',
		],
		['data-copy-prompt', agentPrompt, testId('community-detail-install')],
	)

	expectMarkers(
		await render({
			listing: withInstall({
				status: 'adaptation_required',
				packageId: null,
			}),
		}),
		[
			'data-package-title-status="open"',
			testId('package-title-copy-setup'),
			'data-icon="clipboard"',
			agentPrompt,
		],
	)

	const sourceAheadHtml = await render({
		listing: { ...sampleListing, sourceAhead: true },
	})
	expect(sourceAheadHtml).toMatch(
		/<span[^>]*data-testid="community-detail-source-ahead-badge"/,
	)
	expect(sourceAheadHtml).not.toContain('approve-publish')

	const ownerAheadHref =
		'/@kentcdodds/github-triage/approve-publish?commit=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
	const ownerAheadHtml = await render({
		listing: {
			...sampleListing,
			sourceAhead: true,
			headCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
		},
		viewerIsOwner: true,
		viewerCanManage: true,
	})
	expect(ownerAheadHtml).toContain(`href="${ownerAheadHref}"`)
	expect(ownerAheadHtml).toMatch(
		/<a[^>]*data-testid="community-detail-source-ahead-badge"/,
	)
	expect(ownerAheadHtml).toContain('Publish changes')
	// Primary pill ink must stay on-primary (not page link green-on-green).
	const publishClass =
		/data-testid="community-detail-source-ahead-badge"[^>]*class="(native-test-[^"\s]+)/.exec(
			ownerAheadHtml,
		)?.[1]
	expect(publishClass).toBeTruthy()
	const publishLayer = new RegExp(`\\.${publishClass}\\s*\\{([^}]*)\\}`).exec(
		ownerAheadHtml,
	)?.[1]
	expect(publishLayer).toMatch(/color:\s*var\(--color-on-primary\)/)
	const navClass =
		/data-testid="package-repo-nav"[^>]*class="(native-test-[^"\s]+)/.exec(
			ownerAheadHtml,
		)?.[1]
	expect(navClass).toBeTruthy()
	const navLayer = new RegExp(`\\.${navClass}\\s*\\{([^}]*)\\}`).exec(
		ownerAheadHtml,
	)?.[1]
	expect(navLayer).toMatch(/gap:\s*0\.35rem/)
	const tabClass =
		/data-testid="package-repo-nav-repo"[^>]*class="(native-test-[^"\s]+)/.exec(
			ownerAheadHtml,
		)?.[1]
	expect(tabClass).toBeTruthy()
	const tabLayer = new RegExp(`\\.${tabClass}\\s*\\{([^}]*)\\}`).exec(
		ownerAheadHtml,
	)?.[1]
	expect(tabLayer).toMatch(/padding:\s*0\.55rem 0\.55rem/)

	const listingBehindHtml = await render({
		listing: {
			...sampleListing,
			sourceAhead: true,
			headCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
		},
		viewerIsOwner: false,
		viewerCanManage: true,
		listingNeedsRepublish: true,
	})
	expect(listingBehindHtml).not.toContain(
		'data-testid="community-detail-update-public-listing"',
	)
	expect(listingBehindHtml).not.toContain('Update public listing')
	expect(listingBehindHtml).toContain(
		'data-testid="community-detail-source-ahead-badge"',
	)

	expectMarkers(
		await render({
			listing: withInstall({ targetName: '@kentcdodds/github-triage' }),
			viewerIsOwner: true,
		}),
		[],
		[
			testId('package-repo-actions'),
			testId('community-detail-install'),
			'data-copy-prompt',
		],
	)

	const aheadPrompt =
		'Compare the current listing snapshot, keep local customizations, then publish with repoPublishSession and absorbed_upstream_commit.'
	const finishSetup = 'Finish setup for @me/github-triage.'
	expectMarkers(
		await render({
			listing: withInstall({
				agentPrompt: finishSetup,
				listingAhead: true,
				listingAheadPrompt: aheadPrompt,
				listingDiffHref: '/@kentcdodds/github-triage/tree/commit-new',
			}),
		}),
		[
			'data-package-title-status="outdated"',
			'data-icon="link-break"',
			'data-fork-outdated-copy',
			'data-copy-prompt',
			aheadPrompt,
			'href="/@kentcdodds/github-triage/tree/commit-new"',
		],
		[testId('community-detail-install')],
	)

	expectMarkers(
		await render({
			listing: withInstall({
				agentPrompt: finishSetup,
				forkAhead: true,
				listingDiffHref: '/@kentcdodds/github-triage/tree/commit-pin',
			}),
		}),
		[
			testId('community-detail-listing-fork-ahead-badge'),
			'Fork ahead',
			'href="/@kentcdodds/github-triage/tree/commit-pin"',
		],
		['data-copy-prompt', 'data-fork-outdated-copy'],
	)
})

test('package chrome is shared for public listings and private owner packages', async () => {
	const publicHtml = await render({ loggedIn: false })
	expect(
		publicHtml.indexOf(testId('community-listing-icon-detail')),
	).toBeLessThan(publicHtml.indexOf('<h1'))
	const titleNameAt = publicHtml.indexOf(testId('package-title-name'))
	const leafNameAt = publicHtml.indexOf('>github-triage<', titleNameAt)
	const titleActionsAt = publicHtml.indexOf(
		testId('community-detail-install'),
		titleNameAt,
	)
	expect(titleNameAt).toBeGreaterThan(-1)
	expect(leafNameAt).toBeGreaterThan(titleNameAt)
	expect(titleActionsAt).toBeGreaterThan(
		publicHtml.indexOf('</h1>', titleNameAt),
	)
	expect(titleActionsAt).toBeGreaterThan(
		publicHtml.indexOf(testId('package-repo-actions')),
	)
	expect(publicHtml).toContain(
		'href="/login?redirectTo=%2F%40kentcdodds%2Fgithub-triage"',
	)
	expectMarkers(
		publicHtml,
		[
			testId('package-repo-chrome'),
			testId('community-listing-icon-detail'),
			testId('package-repo-nav-repo'),
			testId('package-repo-nav-files'),
			'href="/@kentcdodds/github-triage/tree/main"',
			testId('community-detail-forks'),
			testId('community-detail-version'),
			'← Public packages',
		],
		[
			testId('package-repo-nav-settings'),
			'data-signifier="unpublished"',
			'data-signifier="repo"',
		],
	)
	expectMarkers(await render({ listing: sampleListing, loggedIn: false }), [
		testId('package-visibility-badge'),
		'data-signifier="package"',
		'title="Package"',
	])

	expect(
		await render({
			listing: { ...sampleListing, version: null },
			loggedIn: false,
		}),
	).not.toContain(testId('community-detail-version'))

	expectMarkers(await render({ viewerIsOwner: true, viewerCanManage: true }), [
		testId('package-repo-nav-settings'),
		testId('package-repo-nav-repo'),
		testId('package-repo-nav-files'),
		'href="/@kentcdodds/github-triage/settings"',
		'href="/@kentcdodds"',
		'← @kentcdodds',
	])
	expect(
		await render({ viewerIsOwner: true, viewerCanManage: true }),
	).not.toContain(testId('package-repo-nav-collaborators'))
	expectMarkers(
		await render({
			viewerIsOwner: true,
			viewerCanManage: true,
			viewerCanManageAccess: true,
		}),
		[
			testId('package-repo-nav-collaborators'),
			'href="/@kentcdodds/github-triage/collaborators"',
		],
	)
	expect(
		await render({
			viewerIsOwner: true,
			viewerCanManageAccess: true,
			hasPackage: false,
		}),
	).not.toContain(testId('package-repo-nav-collaborators'))

	// A teammate who can read a team package opens it but cannot manage it.
	expectMarkers(
		await render({
			listing: {
				...sampleListing,
				sourceAhead: true,
				headCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
			},
			viewerIsOwner: true,
			viewerCanManage: false,
		}),
		[testId('package-repo-nav-repo'), testId('package-repo-nav-files')],
		[
			testId('package-repo-nav-settings'),
			'href="/@kentcdodds/github-triage/settings"',
			'approve-publish',
		],
	)

	const privateHtml = await render({
		listing: null,
		isPrivate: true,
		viewerIsOwner: true,
		viewerCanManage: true,
		description: 'Local notes.',
	})
	const privateNameAt = privateHtml.indexOf(testId('package-title-name'))
	expect(privateNameAt).toBeGreaterThan(-1)
	expect(
		privateHtml.indexOf('data-signifier="private"', privateNameAt),
	).toBeGreaterThan(privateNameAt)
	expectMarkers(
		privateHtml,
		[
			testId('package-repo-chrome'),
			'data-visibility="private"',
			'data-icon="lock"',
			'title="Private"',
			testId('package-repo-nav-settings'),
			'href="/@kentcdodds/github-triage/tree/main"',
			'Local notes.',
		],
		[
			'data-signifier="unpublished"',
			testId('community-detail-forks'),
			testId('community-listing-category'),
		],
	)
	expect(privateHtml).not.toMatch(/>Private</)
	expect(privateHtml).not.toMatch(/>Not published</)

	const publicUnpublishedHtml = await render({
		listing: null,
		isPrivate: false,
		viewerIsOwner: true,
		description: 'Public but unlisted.',
	})
	expectMarkers(
		publicUnpublishedHtml,
		[
			'data-signifier="unpublished"',
			'data-icon="file"',
			'title="Not published"',
		],
		['data-signifier="private"'],
	)
	expect(publicUnpublishedHtml).not.toMatch(/>Not published</)

	// The Files tab follows the listing default branch instead of main.
	expectMarkers(
		await render({
			listing: { ...sampleListing, defaultBranch: 'develop' },
			loggedIn: false,
		}),
		['href="/@kentcdodds/github-triage/tree/develop"'],
		['href="/@kentcdodds/github-triage/tree/main"'],
	)

	// Plain repos show Repo mark and still expose the Files tab.
	expectMarkers(
		await render({
			listing: null,
			hasPackage: false,
			viewerIsOwner: true,
			description: 'Scratch notes.',
		}),
		[
			testId('package-repo-nav-files'),
			'data-signifier="repo"',
			'title="Repo"',
			'href="/@kentcdodds/github-triage/tree/main"',
			'Scratch notes.',
			testId('plain-repo-owner-hints'),
			testId('plain-repo-git-remote-hint'),
			'repoGetGitRemote',
		],
		[
			'data-signifier="package"',
			'data-signifier="unpublished"',
			testId('plain-repo-promote-prompt'),
		],
	)

	expectMarkers(
		await render({
			listing: null,
			hasPackage: false,
			viewerIsOwner: true,
			packageShaped: true,
			kodyId: 'scratch',
			description: 'Package-shaped scratch.',
		}),
		[
			testId('plain-repo-owner-hints'),
			testId('plain-repo-promote-prompt'),
			testId('plain-repo-promote-docs'),
			'repoPromoteToPackage',
			'docs/use/repos.md#promote-flow',
		],
	)

	expectMarkers(
		await render({
			listing: null,
			hasPackage: false,
			viewerIsOwner: false,
			packageShaped: true,
			description: 'Guest view.',
		}),
		['data-signifier="repo"'],
		[testId('plain-repo-owner-hints'), testId('plain-repo-git-remote-hint')],
	)
})

test('open package app link shows for the owner, and hides without an app or access', async () => {
	const privateApp = {
		listing: null,
		isPrivate: true,
		hasApp: true,
	} as const
	const openApp = testId('open-package-app')
	const appHref = 'href="/@kentcdodds/packages/github-triage/open"'
	expectMarkers(await render({ ...privateApp, viewerIsOwner: true }), [
		openApp,
		appHref,
		'data-icon="share"',
	])
	expectMarkers(
		await render({ ...privateApp, viewerIsOwner: true, hasApp: false }),
		[testId('package-repo-nav-files')],
		[openApp],
	)
	expect(await render({ hasApp: true })).not.toContain(openApp)
	expectMarkers(
		await render(privateApp),
		['data-signifier="private"', 'data-icon="lock"'],
		[openApp, 'data-signifier="unpublished"'],
	)
})

test('Follow opens the Repo tab panel, says Following, and sends signed-out visitors to sign in', async () => {
	const followHtml = await render({
		follow: { kind: 'package', viewerFollowing: false },
	})
	expectMarkers(followHtml, [
		testId('package-follow-toggle'),
		'data-package-follow="package"',
		'data-following="false"',
		'aria-controls="package-follow-panel"',
		'href="/@kentcdodds/github-triage#follow"',
		'data-icon="eye"',
		'<span>Follow</span>',
		'Get new versions and pushes from this in your workspace.',
	])
	expect(followHtml.indexOf(testId('package-follow-toggle'))).toBeLessThan(
		followHtml.indexOf(testId('community-detail-install')),
	)

	expectMarkers(
		await render({ follow: { kind: 'repo', viewerFollowing: false } }),
		['Get pushes from this repository in your workspace.'],
		['Get new versions and pushes'],
	)

	expectMarkers(
		await render({ follow: { kind: 'repo', viewerFollowing: true } }),
		['data-following="true"', 'data-icon="check"', '<span>Following</span>'],
	)

	expectMarkers(
		await render({
			loggedIn: false,
			follow: { kind: 'package', viewerFollowing: false },
		}),
		[
			testId('package-follow-toggle'),
			'href="/login?redirectTo=%2F%40kentcdodds%2Fgithub-triage"',
		],
		['data-package-follow', 'aria-controls="package-follow-panel"'],
	)

	expectMarkers(await render(), [], [testId('package-follow-toggle')])
})
