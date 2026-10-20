import { expect, test } from 'vitest'
import {
	buildPackageRepoActions,
	buildSourceAheadPublishHref,
	resolvePackageAppLinks,
} from '#app/package-repo-actions.ts'
import {
	type PublicCommunityListing,
	type ViewerListingInstall,
} from '#universal/community-public-types.ts'

const listing: PublicCommunityListing = {
	id: 'listing-1',
	kodyId: 'github-triage',
	name: '@kentcdodds/github-triage',
	description: 'Triage GitHub issues.',
	iconUrl: '/community/listing-1/icon/abc1234567890',
	tags: ['github'],
	category: 'integrations',
	readmeContent: null,
	license: 'MIT',
	version: '1.0.4',
	pinnedCommit: 'abc1234567890',
	publishedAt: '2026-07-13T00:00:00.000Z',
	ownerUsername: 'kentcdodds',
	trusted: false,
	featured: false,
	averageStars: null,
	ratingCount: 0,
	averageAdaptationEffort: null,
	forkCount: 0,
}

const base: Parameters<typeof buildPackageRepoActions>[0] = {
	username: 'kentcdodds',
	kodyId: 'github-triage',
	listing,
	viewerIsOwner: false,
	viewerCanManage: false,
	loggedIn: false,
	ownerPackage: null,
}

test('visitors get only a fork action whose login link returns to the Repo tab', () => {
	expect(buildPackageRepoActions(base)).toEqual({
		fork: {
			listingId: 'listing-1',
			trusted: false,
			loggedIn: false,
			loginHref: '/login?redirectTo=%2F%40kentcdodds%2Fgithub-triage',
			viewerInstall: null,
		},
		publishHref: null,
		packageAppHref: null,
		packageAppOriginHref: null,
		follow: null,
	})
	expect(buildPackageRepoActions({ ...base, listing: null }).fork).toBeNull()
})

test('the page-level viewer install wins over the listing row copy', () => {
	const pageInstall: ViewerListingInstall = {
		status: 'installed',
		targetName: 'github-triage',
		agentPrompt: '',
		packageId: 'pkg-page',
		listingAhead: false,
		listingAheadPrompt: null,
		forkAhead: false,
		listingDiffHref: null,
	}
	const actions = buildPackageRepoActions({
		...base,
		loggedIn: true,
		listing: {
			...listing,
			viewerInstall: { ...pageInstall, packageId: 'pkg-row' },
		},
		viewerInstall: pageInstall,
	})
	expect(actions.fork?.viewerInstall?.packageId).toBe('pkg-page')
})

test('owners get publish and open app actions but never fork', () => {
	const actions = buildPackageRepoActions({
		...base,
		listing: { ...listing, sourceAhead: true, headCommit: null },
		viewerIsOwner: true,
		viewerCanManage: true,
		loggedIn: true,
		ownerPackage: { hasApp: true, listingNeedsRepublish: true },
	})
	expect(actions).toEqual({
		fork: null,
		publishHref: '/@kentcdodds/github-triage/approve-publish',
		packageAppHref: expect.stringContaining('github-triage'),
		packageAppOriginHref: null,
		follow: null,
	})
})

test('owners get Publish changes when HEAD is ahead even without a listing', () => {
	const actions = buildPackageRepoActions({
		...base,
		listing: null,
		viewerIsOwner: true,
		viewerCanManage: true,
		loggedIn: true,
		ownerPackage: {
			hasApp: false,
			sourceAhead: true,
			headCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
		},
	})
	expect(actions).toEqual({
		fork: null,
		publishHref:
			'/@kentcdodds/github-triage/approve-publish?commit=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
		packageAppHref: null,
		packageAppOriginHref: null,
		follow: null,
	})
})

test('followable targets get a follow action that opens the Repo tab panel', () => {
	expect(
		buildPackageRepoActions({
			...base,
			loggedIn: true,
			follow: { kind: 'repo', viewerFollowing: true },
		}).follow,
	).toEqual({
		kind: 'repo',
		loggedIn: true,
		loginHref: '/login?redirectTo=%2F%40kentcdodds%2Fgithub-triage',
		repoHref: '/@kentcdodds/github-triage',
		following: true,
	})
	expect(
		buildPackageRepoActions({
			...base,
			follow: { kind: 'repo', viewerFollowing: true },
		}).follow?.following,
	).toBe(false)
})

test('owner actions stay hidden without a fresh owner projection', () => {
	const actions = buildPackageRepoActions({
		...base,
		viewerIsOwner: true,
		viewerCanManage: true,
		loggedIn: true,
	})
	expect(actions.packageAppHref).toBeNull()
	expect(actions.publishHref).toBeNull()
})

test('buildSourceAheadPublishHref names the HEAD commit when present', () => {
	const input = { username: 'kentcdodds', kodyId: 'github-triage' }
	expect(
		buildSourceAheadPublishHref({
			...input,
			headCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
		}),
	).toBe(
		'/@kentcdodds/github-triage/approve-publish?commit=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
	)
	expect(buildSourceAheadPublishHref({ ...input, headCommit: null })).toBe(
		'/@kentcdodds/github-triage/approve-publish',
	)
})

test('open app uses the /open handoff path for runners', async () => {
	const env = {
		PACKAGE_APP_BASE_URL: 'https://packages.isolated.test',
	} as unknown as Env
	const shared = {
		env,
		username: 'kentcdodds',
		kodyId: 'github-triage',
		hasPackage: true,
		hasApp: true,
		requestUrl: 'https://kody.test/@kentcdodds/github-triage',
	}
	// Runners always get the self-describing handoff path; no second host button.
	await expect(
		resolvePackageAppLinks({ ...shared, viewerMayRun: true }),
	).resolves.toEqual({
		packageAppHref: '/@kentcdodds/packages/github-triage/open',
		packageAppOriginHref: null,
	})
	// Readers do not get a public Open app that would 403 on the hosted origin.
	await expect(
		resolvePackageAppLinks({ ...shared, viewerMayRun: false }),
	).resolves.toEqual({
		packageAppHref: null,
		packageAppOriginHref: null,
	})
})

test('inline deploy keeps the bare mount for runners (no /open in the address bar)', async () => {
	const env = {} as unknown as Env
	await expect(
		resolvePackageAppLinks({
			env,
			username: 'kentcdodds',
			kodyId: 'github-triage',
			hasPackage: true,
			hasApp: true,
			viewerMayRun: true,
			requestUrl: 'https://kody.test/@kentcdodds/github-triage',
		}),
	).resolves.toEqual({
		packageAppHref: '/@kentcdodds/packages/github-triage',
		packageAppOriginHref: null,
	})
})
