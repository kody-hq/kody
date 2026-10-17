import type * as NodeWorkerAdapter from '../src/test-support/cloudflare-workers-stub.ts'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { loadPackage } from '#start/server/public-data'
import { CommunityDetailRoute } from './pages/community-detail.tsx'
import { renderStartPage } from './test-support/render-start-page.ts'
import { createElement } from 'react'
import { invalidateCommunityPublicCache } from '#app/data-cache.ts'
import { type CommunityListingWithAggregates } from '#worker/community/types.ts'

const mockModule = vi.hoisted(() => ({
	getCommunityListingWithAggregates: vi.fn(),
	readAuthenticatedAppUser: vi.fn(),
	getUserSocialRowByUsername: vi.fn(),
	listCommunityForksByListingIdsAndUser: vi.fn(),
	getCommunityListingById: vi.fn(),
	getEntitySourceById: vi.fn(),
	resolveArtifactSourceHead: vi.fn(),
	listSavedPackagesBySlugs: vi.fn(),
	listSavedPackagesByIds: vi.fn(),
	resolveSavedPackageRef: vi.fn(),
	getMcpUserPackageScope: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	getCommunityListingWithAggregates: (...args: Array<unknown>) =>
		mockModule.getCommunityListingWithAggregates(...args),
	listCommunityListingsWithAggregates: vi.fn(),
	searchCommunityListings: vi.fn(),
	reportCommunityListing: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/community/profile-repo.ts', () => ({
	getUserSocialRowByUsername: (...args: Array<unknown>) =>
		mockModule.getUserSocialRowByUsername(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: (...args: Array<unknown>) =>
		mockModule.getCommunityListingById(...args),
	listCommunityForksByListingIdsAndUser: (...args: Array<unknown>) =>
		mockModule.listCommunityForksByListingIdsAndUser(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/repo/artifact-head-cache.ts', () => ({
	resolveCachedArtifactSourceHead: (...args: Array<unknown>) =>
		mockModule.resolveArtifactSourceHead(...args),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesBySlugs: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesBySlugs(...args),
	listSavedPackagesByIds: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesByIds(...args),
	resolveSavedPackageRef: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackageRef(...args),
}))

vi.mock('#worker/package-registry/user-scope.ts', () => ({
	getMcpUserPackageScope: (...args: Array<unknown>) =>
		mockModule.getMcpUserPackageScope(...args),
}))

vi.mock('@tanstack/react-start', async (importOriginal) => ({
	...(await importOriginal<typeof import('@tanstack/react-start')>()),
	createServerFn: (
		await import('#worker/test-support/start-server-function.ts')
	).createTestServerFn,
	createServerOnlyFn: <T>(fn: T) => fn,
}))
vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof NodeWorkerAdapter>()),
	env: { COOKIE_SECRET: 'test' },
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => new Request('https://example.com/_serverFn/package'),
	setResponseHeader: vi.fn(),
	setResponseStatus: vi.fn(),
}))
vi.mock('#app/env.ts', () => ({
	getEnv: (env: unknown) => env ?? { COOKIE_SECRET: 'test' },
}))
vi.mock('#app/auth-session.ts', () => ({ setAuthSessionSecret: vi.fn() }))
vi.mock('#app/session-info.ts', () => ({
	loadSessionInfo: async () => ({ session: null, setCookie: null }),
}))
vi.mock('#app/community-package-route.ts', () => ({
	resolveCanonicalListingPath: vi.fn(async () => null),
}))

const sampleListing = {
	id: 'listing-1',
	ownerUserId: ownerIdFromStored('owner-mcp-id'),
	packageId: 'pkg-1',
	sourceId: 'src-1',
	kodyId: 'github-triage',
	name: '@kentcdodds/github-triage',
	description: 'Triage GitHub issues.',
	tags: ['github'],
	category: 'integrations',
	searchText: null,
	readmeContent: '# README',
	license: 'MIT',
	pinnedCommit: 'abc1234567890',
	iconCommit: 'abc1234567890',
	status: 'active',
	trustedCommit: null,
	trustedAt: null,
	trusted: false,
	featuredAt: null,
	featured: false,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	publishedAt: '2026-01-01T00:00:00.000Z',
	averageStars: 4.5,
	ratingCount: 2,
	averageAdaptationEffort: 3,
	forkCount: 1,
} satisfies CommunityListingWithAggregates

const owner = {
	mcpUser: {
		userId: ownerIdFromStored('owner-mcp-id'),
		username: 'kentcdodds',
	},
	roles: [],
}
const aheadCommit = 'ffffffffffffffffffffffffffffffffffffffff'

async function renderDetail({
	viewer = null as null | { mcpUser: { userId: string; username: string } },
	source = null as null | Record<string, string>,
	headCommit = sampleListing.pinnedCommit,
	branch = 'main',
	profileVisibility = 'public',
	savedPackagesByKodyId = [] as Array<Record<string, string>>,
	forks = [] as Array<Record<string, string>>,
} = {}) {
	// Every render addresses `listing-1` with its own source fixture; the
	// in-isolate listing cache must not carry one answer into the next.
	invalidateCommunityPublicCache()
	mockModule.getCommunityListingWithAggregates.mockResolvedValue(sampleListing)
	mockModule.getCommunityListingById.mockResolvedValue(sampleListing)
	mockModule.getEntitySourceById.mockResolvedValue(source)
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch,
		commit: headCommit,
	})
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		viewer && {
			roles: [],
			...viewer,
			request: sessionRequestContext(viewer.mcpUser.userId),
		},
	)
	mockModule.listCommunityForksByListingIdsAndUser.mockResolvedValue(forks)
	mockModule.listSavedPackagesBySlugs.mockResolvedValue(savedPackagesByKodyId)
	mockModule.listSavedPackagesByIds.mockResolvedValue([])
	mockModule.getMcpUserPackageScope.mockResolvedValue(
		viewer?.mcpUser.username ?? 'viewer',
	)
	mockModule.getUserSocialRowByUsername.mockResolvedValue({
		profile_visibility: profileVisibility,
		stable_user_id: 'owner-mcp-id',
	})
	const result = await loadPackage({
		data: { username: '', kodyId: '', listingId: 'listing-1' },
	})
	if (result.kind !== 'page') throw new Error('Expected package page')
	return {
		html: (
			await renderStartPage(
				createElement(CommunityDetailRoute, {
					data: result.data,
					header: result.header,
				}),
				'/community/listing-1',
			)
		).replace(/<!-- -->/g, ''),
	}
}

function missing(html: string, markers: Array<string>) {
	return markers.filter((marker) => !html.includes(marker))
}

test('native community detail preserves owner privacy and exact fork provenance', async () => {
	const { html } = await renderDetail()
	expect(
		missing(html, [
			'data-testid="community-detail-frame"',
			'data-testid="community-listing-icon-detail"',
			'/community/listing-1/icon/abc1234567890',
			'data-testid="package-repo-chrome"',
			'href="/@kentcdodds"',
			'>@kentcdodds</a>',
			'data-testid="community-detail-forks"',
			'data-testid="package-repo-nav-files"',
			'href="/@kentcdodds/github-triage/tree/main"',
		]),
	).toEqual([])
	expect(html).not.toContain('data-testid="community-detail-owner-private"')
	expect(html).not.toContain('<html')

	const privateOwner = await renderDetail({ profileVisibility: 'private' })
	expect(privateOwner.html).toContain('@kentcdodds')
	expect(privateOwner.html).toContain(
		'data-testid="community-detail-owner-private"',
	)
	expect(privateOwner.html).not.toContain('href="/@kentcdodds"')

	const sameLeafOnly = await renderDetail({
		viewer: {
			mcpUser: {
				userId: ownerIdFromStored('viewer-mcp-id'),
				username: 'burhan',
			},
		},
		savedPackagesByKodyId: [
			{
				id: 'pkg-github',
				kodyId: 'github-triage',
				name: '@burhan/github-triage',
				sourceId: 'src-github',
			},
		],
	})
	expect(sameLeafOnly.html).not.toContain('data-package-title-status="open"')
	expect(sameLeafOnly.html).not.toContain('href="/@burhan/github-triage"')

	const signedIn = await renderDetail({
		viewer: {
			mcpUser: {
				userId: ownerIdFromStored('viewer-mcp-id'),
				username: 'burhan',
			},
		},
		savedPackagesByKodyId: [
			{
				id: 'pkg-github',
				kodyId: 'github-triage',
				name: '@burhan/github-triage',
				sourceId: 'src-github',
			},
		],
		forks: [
			{
				listingId: 'listing-1',
				targetKodyId: 'github-triage',
				forkedPackageId: 'pkg-github',
				forkedSourceId: 'src-github',
				createdAt: '2026-08-01T00:00:00.000Z',
				originCommit: 'abc1234567890',
			},
		],
	})
	expect(
		missing(signedIn.html, [
			'data-testid="package-repo-chrome"',
			'data-package-title-status="open"',
			'data-icon="arrow-up-right"',
			'href="/@burhan/github-triage"',
		]),
	).toEqual([])
	expect(
		signedIn.html.indexOf('data-package-title-status="open"'),
	).toBeGreaterThan(signedIn.html.indexOf('data-testid="package-repo-actions"'))
})

test('community detail Files tab uses the looked-up default branch', async () => {
	const { html } = await renderDetail({
		source: { repo_id: 'repo-1' },
		branch: 'release',
	})
	expect(html).toContain('href="/@kentcdodds/github-triage/tree/release"')
	expect(html).not.toContain('href="/@kentcdodds/github-triage/tree/HEAD"')
	expect(html).not.toContain('href="/@kentcdodds/github-triage/tree/main"')
})

test('source-ahead badge links the owner to approve-publish, is inert for visitors, and stays off at the runtime pin', async () => {
	const pinnedSource = {
		repo_id: 'repo-1',
		published_commit: sampleListing.pinnedCommit,
	}
	const ownerAhead = await renderDetail({
		viewer: owner,
		source: pinnedSource,
		headCommit: aheadCommit,
	})
	expect(ownerAhead.html).toContain(
		`href="/@kentcdodds/github-triage/approve-publish?commit=${aheadCommit}"`,
	)
	expect(ownerAhead.html).toMatch(
		/<a[^>]*data-testid="community-detail-source-ahead-badge"/,
	)

	const visitorAhead = await renderDetail({
		source: pinnedSource,
		headCommit: aheadCommit,
	})
	expect(visitorAhead.html).toMatch(
		/<span[^>]*data-testid="community-detail-source-ahead-badge"/,
	)
	expect(visitorAhead.html).not.toContain('approve-publish')

	// HEAD matches the runtime pin but not the catalog snapshot.
	const runtimePin = 'cccccccccccccccccccccccccccccccccccccccc'
	expect(sampleListing.pinnedCommit).not.toBe(runtimePin)
	const atRuntimePin = await renderDetail({
		viewer: owner,
		source: { repo_id: 'repo-1', published_commit: runtimePin },
		headCommit: runtimePin,
	})
	expect(atRuntimePin.html).not.toContain(
		'data-testid="community-detail-source-ahead-badge"',
	)
	expect(atRuntimePin.html).not.toContain('approve-publish')
})
