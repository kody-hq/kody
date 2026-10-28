import { expect, test, vi } from 'vitest'
import {
	buildPackageRepoActions,
	resolvePackageAppLinks,
} from '#app/package-repo-actions.ts'
import { type PublicCommunityListing } from '#universal/community-public-types.ts'

const publicLocation = vi.hoisted(() => ({
	hostedUrl: 'https://app.example.com/' as string | null,
}))

vi.mock('#worker/package-app-public-url.ts', () => ({
	resolvePublicPackageAppLocation: async () =>
		publicLocation.hostedUrl
			? { hostedUrl: publicLocation.hostedUrl, appBasePath: '' }
			: null,
}))

vi.mock('#app/package-app-internet-visible.ts', () => ({
	resolveInternetVisibleApprovedCommit: async () => 'abc123',
}))

vi.mock('#app/package-app-owner.ts', () => ({
	resolvePackageAppOrgOwnerByHandle: async () => ({ userId: 'org-owner' }),
}))

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackageForPackageAppSlug: async () => ({
		savedPackage: { id: 'pkg-demo', hasApp: true },
	}),
}))

const listing: PublicCommunityListing = {
	id: 'listing-1',
	kodyId: 'demo-app',
	name: '@pkg-owner/demo-app',
	description: 'Example package app.',
	iconUrl: '/community/listing-1/icon/abc1234567890',
	tags: ['demo'],
	category: 'integrations',
	readmeContent: null,
	license: 'MIT',
	version: '1.0.4',
	pinnedCommit: 'abc1234567890',
	publishedAt: '2026-07-13T00:00:00.000Z',
	ownerUsername: 'pkg-owner',
	trusted: false,
	featured: false,
	averageStars: null,
	ratingCount: 0,
	averageAdaptationEffort: null,
	forkCount: 0,
}

const base: Parameters<typeof buildPackageRepoActions>[0] = {
	username: 'pkg-owner',
	kodyId: 'demo-app',
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
			loginHref: '/login?redirectTo=%2F%40pkg-owner%2Fdemo-app',
			viewerInstall: null,
		},
		publishHref: null,
		packageAppHref: null,
		packageAppOriginHref: null,
		follow: null,
	})
	expect(buildPackageRepoActions({ ...base, listing: null }).fork).toBeNull()
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
		publishHref: '/@pkg-owner/demo-app/approve-publish',
		packageAppHref: expect.stringContaining('demo-app'),
		packageAppOriginHref: null,
		follow: null,
	})
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

test('open app uses the /open handoff path for runners', async () => {
	const env = {
		PACKAGE_APP_BASE_URL: 'https://packages.isolated.test',
		APP_BASE_URL: 'https://kody.test',
	} as unknown as Env
	const shared = {
		env,
		username: 'pkg-owner',
		kodyId: 'demo-app',
		hasPackage: true,
		hasApp: true,
		ownerUserId: 'org-owner',
		requestUrl: 'https://kody.test/@pkg-owner/demo-app',
	}
	// Runners always get the self-describing handoff path; no second host button.
	await expect(
		resolvePackageAppLinks({ ...shared, viewerMayRun: true }),
	).resolves.toEqual({
		packageAppHref: '/@pkg-owner/packages/demo-app/open',
		packageAppOriginHref: null,
	})
})

test('open app for public readers prefers a verified custom domain URL', async () => {
	publicLocation.hostedUrl = 'https://app.example.com/'
	const env = {
		PACKAGE_APP_BASE_URL: 'https://kody.run',
		APP_BASE_URL: 'https://kody.test',
	} as unknown as Env
	await expect(
		resolvePackageAppLinks({
			env,
			username: 'pkg-owner',
			kodyId: 'demo-app',
			hasPackage: true,
			hasApp: true,
			ownerUserId: 'org-owner',
			viewerMayRun: false,
			requestUrl: 'https://kody.test/@pkg-owner/demo-app',
		}),
	).resolves.toEqual({
		packageAppHref: 'https://app.example.com/',
		packageAppOriginHref: null,
	})
})

test('open app for public readers falls back to the kody.run hosted URL', async () => {
	publicLocation.hostedUrl = 'https://pkg-owner.kody.run/demo-app'
	const env = {
		PACKAGE_APP_BASE_URL: 'https://kody.run',
		APP_BASE_URL: 'https://kody.test',
	} as unknown as Env
	await expect(
		resolvePackageAppLinks({
			env,
			username: 'pkg-owner',
			kodyId: 'demo-app',
			hasPackage: true,
			hasApp: true,
			ownerUserId: 'org-owner',
			viewerMayRun: false,
			requestUrl: 'https://kody.test/@pkg-owner/demo-app',
		}),
	).resolves.toEqual({
		packageAppHref: 'https://pkg-owner.kody.run/demo-app',
		packageAppOriginHref: null,
	})
})
