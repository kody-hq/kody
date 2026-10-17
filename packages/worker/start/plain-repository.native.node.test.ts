import { createElement } from 'react'
import { expect, test, vi } from 'vitest'
import { type AccountPackageDetail } from '#universal/loader-data.ts'
import { loadCommunityPackagePayload } from '#app/community-package-payload.ts'
import { CommunityDetailContent } from './components/community-detail-content.tsx'
import { renderStartPage } from './test-support/render-start-page.ts'

const state = vi.hoisted(() => ({ viewerIsOwner: false }))
const ownerPackage: AccountPackageDetail = {
	id: 'repo-notes',
	name: '@owner/notes',
	kodyId: 'notes',
	description: 'Notes',
	tags: [],
	hasApp: false,
	isInternetVisible: false,
	sourceId: 'internal-source-id',
	lockedAt: null,
	createdAt: '2026-01-01',
	updatedAt: '2026-01-01',
	hidden: false,
	isPrivate: false,
	hasCommunityListing: false,
	listingNeedsRepublish: false,
	listingAhead: null,
	forkAhead: null,
	searchText: null,
	exports: null,
	publishedCommit: null,
	pendingCommit: null,
	pendingCommitKnown: false,
	publishedVersion: null,
	unpublishedChangeCount: null,
	ownerIsPersonal: true,
	communityFork: null,
}
vi.mock('#app/package-page.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#app/package-page.ts')>()),
	loadPackagePage: async () => ({
		kind: 'page',
		username: 'owner',
		kodyId: 'notes',
		listing: null,
		ownerPackage,
		hasPackage: false,
		viewerIsOwner: state.viewerIsOwner,
		viewerCanManage: false,
		viewerCanPublish: false,
		viewerCanDelete: false,
		viewerCanAdoptCommunityFork: false,
		loggedIn: state.viewerIsOwner,
		ownerProfilePublic: true,
		ownerUserId: 'owner',
		invocationUrlOrigin: 'https://example.com',
	}),
}))
vi.mock('#app/package-files-data.ts', () => ({
	loadOwnerPackageReadme: async () => ({
		content: '# Notes',
		commit: 'head-commit',
	}),
	loadPackagePageHasAgentsDocs: async () => false,
	resolvePackagePageReadmeImageBaseHref: () => null,
}))
vi.mock('#app/highlight-code.ts', () => ({
	highlightMarkdownFences: async () => [],
}))

test('plain repository native payload strips guest source IDs and preserves authorized owner data', async () => {
	for (const viewerIsOwner of [false, true]) {
		state.viewerIsOwner = viewerIsOwner
		const result = await loadCommunityPackagePayload({
			env: {} as Parameters<typeof loadCommunityPackagePayload>[0]['env'],
			request: new Request('https://example.com/@owner/notes'),
			username: 'owner',
			kodyId: 'notes',
		})
		expect(result.kind).toBe('page')
		if (result.kind !== 'page') throw new Error('Expected repository page')
		expect(result.data.hasPackage).toBe(false)
		expect(result.data.ownerPackage?.sourceId).toBe(
			viewerIsOwner ? 'internal-source-id' : '',
		)
		expect(result.data.readmeContent).toBe('# Notes')
	}
})

test('plain repository chrome has a Repo mark and shows Files and omits unsupported Settings actions', async () => {
	const html = await renderStartPage(
		createElement(CommunityDetailContent, {
			listing: null,
			username: 'owner',
			kodyId: 'notes',
			description: 'Notes',
			isPrivate: true,
			ownerProfilePublic: true,
			viewerIsOwner: true,
			viewerCanManage: false,
			repoActions: null,
			hasPackage: false,
		}),
		'/@owner/notes',
	)
	expect(html).toContain('data-signifier="repo"')
	expect(html).toContain('data-signifier="private"')
	expect(html).not.toContain('data-signifier="package"')
	expect(html).not.toContain('data-signifier="unpublished"')
	expect(html).toContain('data-testid="package-repo-nav-files"')
	expect(html).not.toContain('data-testid="package-repo-nav-settings"')
})

test('plain repository promotion guidance is limited to members with package-shaped sources', async () => {
	for (const [viewerIsOwner, packageShaped] of [
		[true, true],
		[true, false],
		[false, true],
	] as const) {
		const html = await renderStartPage(
			createElement(CommunityDetailContent, {
				listing: null,
				username: 'owner',
				kodyId: 'notes',
				description: 'Notes',
				isPrivate: false,
				ownerProfilePublic: true,
				viewerIsOwner,
				viewerCanManage: false,
				repoActions: null,
				hasPackage: false,
				packageShaped,
			}),
			'/@owner/notes',
		)
		expect(html.includes('data-testid="plain-repo-git-remote-hint"')).toBe(
			viewerIsOwner,
		)
		expect(html.includes('data-testid="plain-repo-promote-prompt"')).toBe(
			viewerIsOwner && packageShaped,
		)
	}
})
