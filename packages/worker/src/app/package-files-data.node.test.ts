import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as authenticatedUser from '#app/authenticated-user.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import type * as highlightCode from '#app/highlight-code.ts'
import type * as packagePage from '#app/package-page.ts'
import { type PackagePageAccess } from '#app/package-page.ts'
import type * as profileRepo from '#worker/community/profile-repo.ts'
import { type UserSocialRow } from '#worker/community/profile-repo.ts'
import type * as communityRepo from '#worker/community/repo.ts'
import type * as communitySnapshot from '#worker/community/snapshot.ts'
import {
	type CommunityListingRecord,
	type CommunitySnapshot,
	type ProfileVisibility,
} from '#worker/community/types.ts'
import type * as publishedRuntimeArtifacts from '#worker/package-runtime/published-runtime-artifacts.ts'
import { type PublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import type * as packageRegistryRepo from '#worker/package-registry/repo.ts'
import type * as packageSource from '#worker/package-registry/source.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import type * as artifactFile from '#worker/repo/artifact-file.ts'
import type * as artifactHeadCache from '#worker/repo/artifact-head-cache.ts'
import type * as artifactSourceSnapshot from '#worker/repo/artifact-source-snapshot.ts'
import type * as entitySources from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { type AccountPackageDetail } from '#universal/loader-data.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { maxPackageFilePreviewBytes } from '#universal/package-file-media.ts'

const mockModule = vi.hoisted(() => ({
	getCommunityListingById:
		vi.fn<typeof communityRepo.getCommunityListingById>(),
	getEntitySourceById: vi.fn<typeof entitySources.getEntitySourceById>(),
	getEntitySourceByEntity:
		vi.fn<typeof entitySources.getEntitySourceByEntity>(),
	resolveArtifactSourceHead:
		vi.fn<typeof artifactHeadCache.resolveCachedArtifactSourceHead>(),
	readPublishedSourceSnapshot:
		vi.fn<typeof publishedRuntimeArtifacts.readPublishedSourceSnapshot>(),
	readArtifactSourceSnapshot:
		vi.fn<typeof artifactSourceSnapshot.readArtifactSourceSnapshot>(),
	readCommunitySnapshot:
		vi.fn<typeof communitySnapshot.readCommunitySnapshot>(),
	readAuthenticatedAppUser:
		vi.fn<typeof authenticatedUser.readAuthenticatedAppUser>(),
	loadPackagePage: vi.fn<typeof packagePage.loadPackagePage>(),
	loadPackageSourceBySourceId:
		vi.fn<typeof packageSource.loadPackageSourceBySourceId>(),
	highlightMarkdownFences: vi.fn<typeof highlightCode.highlightMarkdownFences>(
		async () => [],
	),
	highlightSnippets: vi.fn<typeof highlightCode.highlightSnippets>(
		async () => [],
	),
	readArtifactFileAtCommit:
		vi.fn<typeof artifactFile.readArtifactFileAtCommit>(),
	readArtifactTreeAtCommit:
		vi.fn<typeof artifactFile.readArtifactTreeAtCommit>(),
	getUserSocialRowByUsername:
		vi.fn<typeof profileRepo.getUserSocialRowByUsername>(),
	getSavedPackageById: vi.fn<typeof packageRegistryRepo.getSavedPackageById>(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (
		...args: Parameters<typeof packageRegistryRepo.getSavedPackageById>
	) => mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: (
		...args: Parameters<typeof communityRepo.getCommunityListingById>
	) => mockModule.getCommunityListingById(...args),
}))

vi.mock('#worker/community/profile-repo.ts', () => ({
	getUserSocialRowByUsername: (
		...args: Parameters<typeof profileRepo.getUserSocialRowByUsername>
	) => mockModule.getUserSocialRowByUsername(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (
		...args: Parameters<typeof entitySources.getEntitySourceById>
	) => mockModule.getEntitySourceById(...args),
	getEntitySourceByEntity: (
		...args: Parameters<typeof entitySources.getEntitySourceByEntity>
	) => mockModule.getEntitySourceByEntity(...args),
}))

vi.mock('#worker/repo/artifact-head-cache.ts', () => ({
	resolveCachedArtifactSourceHead: (
		...args: Parameters<
			typeof artifactHeadCache.resolveCachedArtifactSourceHead
		>
	) => mockModule.resolveArtifactSourceHead(...args),
}))

vi.mock('#worker/repo/artifact-source-snapshot.ts', () => ({
	readArtifactSourceSnapshot: (
		...args: Parameters<
			typeof artifactSourceSnapshot.readArtifactSourceSnapshot
		>
	) => mockModule.readArtifactSourceSnapshot(...args),
}))

vi.mock('#worker/package-runtime/published-runtime-artifacts.ts', () => ({
	readPublishedSourceSnapshot: (
		...args: Parameters<
			typeof publishedRuntimeArtifacts.readPublishedSourceSnapshot
		>
	) => mockModule.readPublishedSourceSnapshot(...args),
}))

vi.mock('#worker/community/snapshot.ts', () => ({
	readCommunitySnapshot: (
		...args: Parameters<typeof communitySnapshot.readCommunitySnapshot>
	) => mockModule.readCommunitySnapshot(...args),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (
		...args: Parameters<typeof authenticatedUser.readAuthenticatedAppUser>
	) => mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/package-page.ts', () => ({
	loadPackagePage: (...args: Parameters<typeof packagePage.loadPackagePage>) =>
		mockModule.loadPackagePage(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (
		...args: Parameters<typeof packageSource.loadPackageSourceBySourceId>
	) => mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('#app/highlight-code.ts', () => ({
	highlightMarkdownFences: (
		...args: Parameters<typeof highlightCode.highlightMarkdownFences>
	) => mockModule.highlightMarkdownFences(...args),
	highlightSnippets: (
		...args: Parameters<typeof highlightCode.highlightSnippets>
	) => mockModule.highlightSnippets(...args),
}))

vi.mock('#worker/repo/artifact-file.ts', () => ({
	readArtifactFileAtCommit: (
		...args: Parameters<typeof artifactFile.readArtifactFileAtCommit>
	) => mockModule.readArtifactFileAtCommit(...args),
	readArtifactTreeAtCommit: (
		...args: Parameters<typeof artifactFile.readArtifactTreeAtCommit>
	) => mockModule.readArtifactTreeAtCommit(...args),
}))

const {
	loadAccessiblePackageFileRaw,
	loadAccessiblePackageFilesData,
	loadCommunityPackageFileRaw,
	loadCommunityPackageFilesData,
	loadListingFilesData,
	loadOwnerPackageReadme,
	loadPackagePageHasAgentsDocs,
	loadPlainRepoFilesData,
	resolvePackagePageReadmeImageBaseHref,
} = await import('./package-files-data.ts')

const env = { APP_DB: {}, BUNDLE_ARTIFACTS_KV: {} } as Env
const listing: CommunityListingRecord = {
	id: 'listing-1',
	ownerUserId: ownerIdFromStored('owner-1'),
	packageId: 'pkg-1',
	sourceId: 'src-1',
	kodyId: 'sentry',
	name: '@kentcdodds/sentry',
	description: 'Sentry package',
	tags: [],
	category: 'other',
	searchText: null,
	readmeContent: null,
	license: 'MIT',
	pinnedCommit: 'abc123',
	iconCommit: 'abc123',
	status: 'active',
	trustedCommit: null,
	trustedAt: null,
	trusted: false,
	featuredAt: null,
	featured: false,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	publishedAt: '2026-01-01T00:00:00.000Z',
}

function ownerSocialRow(profileVisibility: ProfileVisibility): UserSocialRow {
	return {
		id: 1,
		username: 'kentcdodds',
		email: 'owner@example.com',
		stable_user_id: 'owner-1',
		personal_org_id: null,
		display_name: null,
		bio: null,
		avatar_key: null,
		profile_visibility: profileVisibility,
		created_at: '2026-01-01T00:00:00.000Z',
	}
}

const entitySource: EntitySourceRow = {
	id: 'src-1',
	user_id: ownerIdFromStored('owner-1'),
	entity_kind: 'package',
	entity_id: 'pkg-1',
	repo_id: 'repo-1',
	published_commit: 'abc123',
	indexed_commit: null,
	manifest_path: 'package.json',
	source_root: '/',
	last_external_check_at: null,
	external_check_until: null,
	created_at: '2026-01-01T00:00:00.000Z',
	updated_at: '2026-01-01T00:00:00.000Z',
}

function publishedSnapshot(
	files: Record<string, string>,
): PublishedSourceSnapshot {
	return {
		version: 1,
		sourceId: 'src-1',
		repoId: 'repo-1',
		entityKind: 'package',
		entityId: 'pkg-1',
		publishedCommit: 'abc123',
		manifestPath: 'package.json',
		sourceRoot: '/',
		files,
		createdAt: '2026-01-01T00:00:00.000Z',
	}
}

function communitySnapshotWithFiles(
	files: Record<string, string>,
): CommunitySnapshot {
	return {
		version: 1,
		listingId: 'listing-1',
		pinnedCommit: 'abc123',
		files,
		createdAt: '2026-01-01T00:00:00.000Z',
	}
}

function viewer(userId: string): AuthenticatedAppUser {
	return {
		sessionUserId: '42',
		userId: 42,
		username: 'viewer',
		email: 'viewer@example.com',
		emailVerified: true,
		emailVerificationDelivery: null,
		displayName: 'viewer',
		roles: [],
		permissions: [],
		artifactOwnerIds: [],
		mcpUser: {
			userId: personIdFromStored(userId),
			email: 'viewer@example.com',
			username: 'viewer',
			displayName: 'viewer',
		},
		request: sessionRequestContext(userId),
	}
}

const pngBytes = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1,
])
const png = String.fromCharCode(...pngBytes)

function publishListing({
	files = { 'README.md': '# Sentry\n' } as Record<string, string> | null,
	headCommit = 'abc123',
	viewerUserId = null as string | null,
	profileVisibility = 'public' as ProfileVisibility,
} = {}) {
	mockModule.getCommunityListingById.mockResolvedValue(listing)
	mockModule.getUserSocialRowByUsername.mockResolvedValue(
		ownerSocialRow(profileVisibility),
	)
	mockModule.getEntitySourceById.mockResolvedValue(entitySource)
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: headCommit,
	})
	mockModule.readPublishedSourceSnapshot.mockResolvedValue(
		files && publishedSnapshot(files),
	)
	mockModule.readArtifactSourceSnapshot.mockResolvedValue(null)
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		viewerUserId ? viewer(viewerUserId) : null,
	)
}

const plainRepoEntitySource: EntitySourceRow = {
	id: 'src-plain-1',
	user_id: ownerIdFromStored('owner-1'),
	entity_kind: 'repo',
	entity_id: 'user-repo-1',
	repo_id: 'artifacts-repo-1',
	published_commit: null,
	indexed_commit: 'idxabc1',
	manifest_path: '',
	source_root: '/',
	last_external_check_at: null,
	external_check_until: null,
	created_at: '2026-01-01T00:00:00.000Z',
	updated_at: '2026-01-01T00:00:00.000Z',
}

function plainRepoOwnerPackage(
	overrides: Partial<AccountPackageDetail> = {},
): AccountPackageDetail {
	return {
		id: 'user-repo-1',
		name: '@kentcdodds/notes',
		kodyId: 'notes',
		description: 'Plain notes repo',
		tags: [],
		hasApp: false,
		sourceId: 'src-plain-1',
		lockedAt: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		hasCommunityListing: false,
		listingNeedsRepublish: false,
		listingAhead: null,
		forkAhead: null,
		searchText: null,
		exports: null,
		publishedCommit: 'idxabc1',
		pendingCommit: 'idxabc1',
		pendingCommitKnown: true,
		publishedVersion: null,
		unpublishedChangeCount: null,
		ownerIsPersonal: true,
		communityFork: null,
		...overrides,
	}
}

function plainRepoPage(
	overrides: Partial<Extract<PackagePageAccess, { kind: 'page' }>> = {},
): Extract<PackagePageAccess, { kind: 'page' }> {
	return {
		kind: 'page',
		username: 'kentcdodds',
		kodyId: 'notes',
		listing: null,
		ownerPackage: plainRepoOwnerPackage(),
		hasPackage: false,
		viewerIsOwner: false,
		viewerCanManage: false,
		viewerCanManageAccess: false,
		viewerCanPublish: false,
		viewerCanDelete: false,
		viewerCanAdoptCommunityFork: false,
		loggedIn: false,
		invocationUrlOrigin: 'https://example.com',
		ownerUserId: ownerIdFromStored('owner-1'),
		ownerProfilePublic: true,
		followTarget: null,
		...overrides,
	}
}

function publishPlainRepo({
	files = {
		'README.md': '# Notes\n',
		'docs/guide.md': 'Guide\n',
	} as Record<string, string>,
	headCommit = 'headlive1',
	viewerIsOwner = false,
	isPrivate = false,
} = {}) {
	mockModule.loadPackagePage.mockResolvedValue(
		plainRepoPage({
			viewerIsOwner,
			loggedIn: viewerIsOwner,
			ownerPackage: plainRepoOwnerPackage({ isPrivate }),
		}),
	)
	mockModule.getEntitySourceById.mockResolvedValue(plainRepoEntitySource)
	mockModule.getEntitySourceByEntity.mockResolvedValue(plainRepoEntitySource)
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: headCommit,
	})
	mockModule.readPublishedSourceSnapshot.mockResolvedValue(null)
	mockModule.readArtifactSourceSnapshot.mockResolvedValue({
		published_commit: headCommit,
		files,
	})
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		viewerIsOwner ? viewer('owner-1') : null,
	)
}

function loadTree(selectedPath = '', ref = 'main') {
	return loadCommunityPackageFilesData({
		env,
		request: new Request(
			`https://example.com/@kentcdodds/sentry/tree/${ref}/${selectedPath}`,
		),
		listingId: 'listing-1',
		selectedPath,
		ref,
	})
}

function loadRaw(selectedPath: string, ref = 'main') {
	return loadCommunityPackageFileRaw({
		env,
		request: new Request(
			`https://example.com/@kentcdodds/sentry/raw/${ref}/${selectedPath}`,
		),
		listingId: 'listing-1',
		selectedPath,
		ref,
	})
}

test('listed package tree chrome marks the owner, links only a public owner profile, and serves README images only at the pin', async () => {
	publishListing({ viewerUserId: 'owner-1' })
	expect(await loadTree()).toMatchObject({
		ok: true,
		username: 'kentcdodds',
		kodyId: 'sentry',
		viewerIsOwner: true,
		isPrivate: false,
		backHref: '/@kentcdodds/sentry',
		filesBasePath: '/@kentcdodds/sentry/tree/main',
		imageBaseHref: '/@kentcdodds/sentry/assets',
		iconUrl: '/community/listing-1/icon/abc123',
		description: 'Sentry package',
		ownerProfilePublic: true,
	})

	publishListing({ profileVisibility: 'private' })
	expect(await loadTree()).toMatchObject({
		ok: true,
		viewerIsOwner: false,
		username: 'kentcdodds',
		kodyId: 'sentry',
		description: 'Sentry package',
		ownerProfilePublic: false,
	})

	publishListing({
		headCommit: 'deadbeef',
		files: { 'README.md': '![poster](./docs/poster.png)\n' },
	})
	expect(await loadTree()).toMatchObject({ ok: true, imageBaseHref: null })
})

test('listing files use the package page payload when it resolves and fall back to the public tree', async () => {
	const input = {
		env,
		request: new Request('https://example.com/community/listing-1/files'),
		listingId: 'listing-1',
		selectedPath: '',
		ref: 'main',
	}
	publishListing()
	mockModule.loadPackagePage.mockResolvedValue({ kind: 'not_found' })
	const fallback = await loadListingFilesData(input)
	expect(mockModule.loadPackagePage).toHaveBeenLastCalledWith(
		expect.objectContaining({ username: 'kentcdodds', kodyId: 'sentry' }),
	)
	expect(fallback).toMatchObject({ ok: true, kodyId: 'sentry' })
	expect(fallback?.repoActions).toBeUndefined()

	publishPlainRepo()
	mockModule.getCommunityListingById.mockResolvedValue(listing)
	const viaPage = await loadListingFilesData(input)
	expect(viaPage).toMatchObject({
		ok: true,
		kodyId: 'notes',
		repoActions: {
			fork: null,
			publishHref: null,
			packageAppHref: null,
		},
	})
})

test('package page reports AGENTS.md only when a non-empty root file exists', async () => {
	const cases: Array<{ files: Record<string, string>; expected: boolean }> = [
		{ files: { 'README.md': '# Sentry\n' }, expected: false },
		{
			files: {
				'README.md': '# Sentry\n',
				'AGENTS.md': '# Agents\n\nImport the root export.\n',
			},
			expected: true,
		},
		{ files: { 'docs/AGENTS.md': 'Nested only.\n' }, expected: false },
	]
	for (const { files, expected } of cases) {
		mockModule.readCommunitySnapshot.mockResolvedValue(
			communitySnapshotWithFiles(files),
		)
		const hasAgentsDocs = await loadPackagePageHasAgentsDocs({
			env,
			request: new Request('https://example.com/@kentcdodds/sentry'),
			listingId: 'listing-1',
			viewerIsOwner: false,
		})
		expect({ files, hasAgentsDocs }).toEqual({
			files,
			hasAgentsDocs: expected,
		})
	}
})

test('package page README images opt in for listing README and only matching owner commits', () => {
	const cases = [
		{
			usedListingReadme: true,
			publishedCommit: 'published-ahead',
			expected: '/@kentcdodds/sentry/assets',
		},
		{
			usedListingReadme: false,
			publishedCommit: 'published-ahead',
			expected: null,
		},
		{
			usedListingReadme: false,
			publishedCommit: 'abc123',
			expected: '/@kentcdodds/sentry/assets',
		},
		{
			usedListingReadme: false,
			publishedCommit: 'idxabc1',
			readmeCommit: 'headlive1',
			expected: null,
		},
		{
			usedListingReadme: false,
			publishedCommit: 'abc123',
			readmeCommit: 'abc123',
			expected: '/@kentcdodds/sentry/assets',
		},
	]
	for (const { expected, ...input } of cases) {
		const href = resolvePackagePageReadmeImageBaseHref({
			listingId: 'listing-1',
			ownerUsername: 'kentcdodds',
			kodyId: 'sentry',
			pinnedCommit: 'abc123',
			...input,
		})
		expect({ ...input, href }).toEqual({ ...input, href: expected })
	}
	expect(
		resolvePackagePageReadmeImageBaseHref({
			ownerUsername: 'kentcdodds',
			kodyId: 'notes',
			usedListingReadme: false,
			readmeCommit: 'headlive1',
		}),
	).toBeNull()
})

test('opens a png as a media preview and an unknown binary without a code dump', async () => {
	publishListing({
		files: {
			'README.md': '# Sentry\n',
			'logo.png': png,
			'app.wasm': 'wasm\0module',
		},
	})
	mockModule.readArtifactFileAtCommit.mockResolvedValue(pngBytes)

	expect(await loadTree('logo.png')).toMatchObject({
		ok: true,
		content: null,
		contentKind: 'image',
		mediaHref: '/@kentcdodds/sentry/raw/main/logo.png',
		contentByteLength: pngBytes.byteLength,
	})
	expect(mockModule.highlightSnippets).not.toHaveBeenCalled()
	expect(await loadTree('app.wasm')).toMatchObject({
		content: null,
		contentKind: 'binary',
		mediaHref: null,
	})
	expect(await loadRaw('logo.png')).toEqual({
		kind: 'ok',
		bytes: pngBytes,
		contentType: 'image/png',
		disposition: 'inline',
		filename: 'logo.png',
		isPrivate: false,
	})

	mockModule.readArtifactFileAtCommit.mockResolvedValue(
		new TextEncoder().encode('<!DOCTYPE html><script>alert(1)</script>'),
	)
	expect(await loadRaw('logo.png')).toMatchObject({
		kind: 'ok',
		contentType: 'application/octet-stream',
		disposition: 'attachment',
	})
})

test('community raw 404s a hex that only has the listing pin snapshot', async () => {
	const missingHex = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
	publishListing({ files: null })
	mockModule.readCommunitySnapshot.mockResolvedValue(
		communitySnapshotWithFiles({ 'logo.png': png }),
	)
	mockModule.readArtifactFileAtCommit.mockResolvedValue(null)

	expect(await loadTree('logo.png', missingHex)).toBeNull()
	expect(await loadRaw('logo.png', missingHex)).toEqual({ kind: 'not-found' })
	const pinRaw = await loadRaw('logo.png', 'abc123')
	expect(pinRaw).toMatchObject({
		kind: 'ok',
		contentType: 'image/png',
		disposition: 'inline',
		filename: 'logo.png',
		isPrivate: false,
	})
	expect(pinRaw.kind === 'ok' && [...pinRaw.bytes]).toEqual([...pngBytes])
})

test('plain repo tree loads live HEAD via entity_sources.repo_id for guests', async () => {
	publishPlainRepo()
	const data = await loadAccessiblePackageFilesData({
		env,
		request: new Request('https://example.com/@kentcdodds/notes/tree/main'),
		username: 'kentcdodds',
		kodyId: 'notes',
		selectedPath: '',
		ref: 'main',
	})
	expect(data).toMatchObject({
		ok: true,
		title: '@kentcdodds/notes',
		username: 'kentcdodds',
		kodyId: 'notes',
		hasPackage: false,
		viewerIsOwner: false,
		isPrivate: false,
		isListed: false,
		filesBasePath: '/@kentcdodds/notes/tree/main',
		backHref: '/@kentcdodds/notes',
		description: 'Plain notes repo',
		// Indexed commit is what the identity-icon route can serve.
		iconUrl: '/@kentcdodds/notes/icon/idxabc1',
		imageBaseHref: null,
	})
	expect(data?.paths).toEqual(
		expect.arrayContaining(['README.md', 'docs/guide.md']),
	)
	expect(mockModule.getEntitySourceById).toHaveBeenCalledWith(
		env.APP_DB,
		'src-plain-1',
	)
	expect(mockModule.resolveArtifactSourceHead).toHaveBeenCalledWith(
		env,
		'artifacts-repo-1',
		expect.anything(),
	)
	expect(mockModule.readArtifactSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({
			repoId: 'artifacts-repo-1',
			commit: 'headlive1',
		}),
	)
})

test('plain repo files resolve via getEntitySourceByEntity when sourceId is empty', async () => {
	publishPlainRepo()
	mockModule.getEntitySourceById.mockResolvedValue(null)
	const data = await loadPlainRepoFilesData({
		env,
		request: new Request('https://example.com/@kentcdodds/notes/tree/main'),
		ownerUserId: 'owner-1',
		username: 'kentcdodds',
		kodyId: 'notes',
		repoId: 'user-repo-1',
		sourceId: '',
		isPrivate: false,
		description: 'Plain notes repo',
		selectedPath: 'README.md',
		ref: 'main',
	})
	expect(data).toMatchObject({
		ok: true,
		hasPackage: false,
		selectedPath: 'README.md',
		contentKind: 'markdown',
	})
	expect(mockModule.getEntitySourceByEntity).toHaveBeenCalledWith(env.APP_DB, {
		userId: ownerIdFromStored('owner-1'),
		entityKind: 'repo',
		entityId: 'user-repo-1',
	})
})

test('plain repo files fall back to Artifacts HEAD tree when publish snapshots are empty', async () => {
	publishPlainRepo()
	mockModule.readPublishedSourceSnapshot.mockResolvedValue(null)
	mockModule.readArtifactSourceSnapshot.mockResolvedValue(null)
	mockModule.readArtifactTreeAtCommit.mockResolvedValue({
		'README.md': '# From HEAD\n',
		'package.json': '{"name":"notes"}\n',
	})
	const data = await loadPlainRepoFilesData({
		env,
		request: new Request('https://example.com/@kentcdodds/notes/tree/main'),
		ownerUserId: 'owner-1',
		username: 'kentcdodds',
		kodyId: 'notes',
		repoId: 'user-repo-1',
		sourceId: 'src-plain-1',
		isPrivate: false,
		description: 'Plain notes repo',
		selectedPath: '',
		ref: 'main',
	})
	expect(data).toMatchObject({
		ok: true,
		hasPackage: false,
		iconUrl: '/@kentcdodds/notes/icon/idxabc1',
		imageBaseHref: null,
	})
	expect(data?.paths).toEqual(
		expect.arrayContaining(['README.md', 'package.json']),
	)
	expect(mockModule.readArtifactTreeAtCommit).toHaveBeenCalledWith(
		expect.objectContaining({
			repoId: 'artifacts-repo-1',
			commit: 'headlive1',
		}),
	)
})

test('loadOwnerPackageReadme falls back to Artifacts HEAD for plain repos without a publish snapshot', async () => {
	publishPlainRepo()
	mockModule.loadPackageSourceBySourceId.mockRejectedValue(
		new Error('Saved package source has no published snapshot.'),
	)
	mockModule.readPublishedSourceSnapshot.mockResolvedValue(null)
	mockModule.readArtifactSourceSnapshot.mockResolvedValue(null)
	mockModule.readArtifactTreeAtCommit.mockResolvedValue({
		'README.md': '# Live README from HEAD\n',
		'notes.txt': 'side file\n',
	})
	const readme = await loadOwnerPackageReadme({
		env,
		request: new Request('https://example.com/@kentcdodds/notes'),
		userId: ownerIdFromStored('owner-1'),
		sourceId: 'src-plain-1',
	})
	expect(readme).toEqual({
		content: '# Live README from HEAD',
		commit: 'headlive1',
	})
	expect(mockModule.readArtifactTreeAtCommit).toHaveBeenCalledWith(
		expect.objectContaining({
			repoId: 'artifacts-repo-1',
			commit: 'headlive1',
		}),
	)
})

test('loadOwnerPackageReadme prefers the published snapshot when present', async () => {
	mockModule.getEntitySourceById.mockResolvedValue(entitySource)
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: entitySource,
		manifest: { name: 'sentry', version: '1.0.0' },
		files: { 'README.md': '# Published README\n' },
		snapshotCreatedAt: '2026-01-01T00:00:00.000Z',
	} as never)
	const readme = await loadOwnerPackageReadme({
		env,
		request: new Request('https://example.com/@kentcdodds/sentry'),
		userId: ownerIdFromStored('owner-1'),
		sourceId: 'src-1',
	})
	expect(readme).toEqual({
		content: '# Published README',
		commit: 'abc123',
	})
	expect(mockModule.readArtifactTreeAtCommit).not.toHaveBeenCalled()
})

test('loadOwnerPackageReadme does not fall through to HEAD when published snapshot has no README', async () => {
	mockModule.getEntitySourceById.mockResolvedValue(entitySource)
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: entitySource,
		manifest: { name: 'sentry', version: '1.0.0' },
		files: { 'package.json': '{"name":"sentry"}\n' },
		snapshotCreatedAt: '2026-01-01T00:00:00.000Z',
	} as never)
	mockModule.readArtifactTreeAtCommit.mockResolvedValue({
		'README.md': '# Secret HEAD README\n',
	})
	const readme = await loadOwnerPackageReadme({
		env,
		request: new Request('https://example.com/@kentcdodds/sentry'),
		userId: ownerIdFromStored('owner-1'),
		sourceId: 'src-1',
	})
	expect(readme).toEqual({ content: null, commit: null })
	expect(mockModule.readArtifactTreeAtCommit).not.toHaveBeenCalled()
})

test('loadOwnerPackageReadme does not fall through to HEAD when published snapshot load fails', async () => {
	mockModule.getEntitySourceById.mockResolvedValue(entitySource)
	mockModule.loadPackageSourceBySourceId.mockRejectedValue(
		new Error('R2 timeout'),
	)
	mockModule.readArtifactTreeAtCommit.mockResolvedValue({
		'README.md': '# Secret HEAD README\n',
	})
	const readme = await loadOwnerPackageReadme({
		env,
		request: new Request('https://example.com/@kentcdodds/sentry'),
		userId: ownerIdFromStored('owner-1'),
		sourceId: 'src-1',
	})
	expect(readme).toEqual({ content: null, commit: null })
	expect(mockModule.readArtifactTreeAtCommit).not.toHaveBeenCalled()
})

test('plain repo raw serves media for guests who passed loadPackagePage', async () => {
	publishPlainRepo({
		files: { 'logo.png': png, 'README.md': '# Notes\n' },
	})
	mockModule.readArtifactFileAtCommit.mockResolvedValue(pngBytes)
	const result = await loadAccessiblePackageFileRaw({
		env,
		request: new Request(
			'https://example.com/@kentcdodds/notes/raw/main/logo.png',
		),
		username: 'kentcdodds',
		kodyId: 'notes',
		selectedPath: 'logo.png',
		ref: 'main',
	})
	expect(result).toEqual({
		kind: 'ok',
		bytes: pngBytes,
		contentType: 'image/png',
		disposition: 'inline',
		filename: 'logo.png',
		isPrivate: false,
	})
})

test('plain repo private raw marks isPrivate when the page is private', async () => {
	publishPlainRepo({
		files: { 'logo.png': png },
		viewerIsOwner: true,
		isPrivate: true,
	})
	mockModule.readArtifactFileAtCommit.mockResolvedValue(pngBytes)
	const result = await loadAccessiblePackageFileRaw({
		env,
		request: new Request(
			'https://example.com/@kentcdodds/notes/raw/main/logo.png',
		),
		username: 'kentcdodds',
		kodyId: 'notes',
		selectedPath: 'logo.png',
		ref: 'main',
	})
	expect(result).toMatchObject({ kind: 'ok', isPrivate: true })
})

test('accessible files return null when loadPackagePage denies the viewer', async () => {
	mockModule.loadPackagePage.mockResolvedValue({ kind: 'not_found' })
	expect(
		await loadAccessiblePackageFilesData({
			env,
			request: new Request('https://example.com/@kentcdodds/notes/tree/main'),
			username: 'kentcdodds',
			kodyId: 'notes',
			selectedPath: '',
		}),
	).toBeNull()
	expect(
		await loadAccessiblePackageFileRaw({
			env,
			request: new Request(
				'https://example.com/@kentcdodds/notes/raw/main/README.md',
			),
			username: 'kentcdodds',
			kodyId: 'notes',
			selectedPath: 'README.md',
		}),
	).toEqual({ kind: 'not-found' })

	mockModule.loadPackagePage.mockResolvedValue({ kind: 'unauthorized' })
	expect(
		await loadAccessiblePackageFileRaw({
			env,
			request: new Request(
				'https://example.com/@kentcdodds/notes/raw/main/README.md',
			),
			username: 'kentcdodds',
			kodyId: 'notes',
			selectedPath: 'README.md',
		}),
	).toEqual({ kind: 'not-found' })
})

const skillGetSource = "export const skillGet = 'skill'\n"

const privateSkillsPackage: SavedPackageRecord = {
	id: 'pkg-skills',
	userId: ownerIdFromStored('owner-1'),
	name: '@kentcdodds/skills',
	kodyId: 'skills',
	description: 'Private skills',
	tags: [],
	searchText: null,
	sourceId: 'src-1',
	hasApp: false,
	hasSkills: true,
	hidden: false,
	isPrivate: true,
	isInternetVisible: false,
	lockedAt: null,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
}

/** `loadPackagePage` only resolves an unlisted package for readers. */
function publishPrivateSkillsPackage({ viewerIsOwner = true } = {}) {
	mockModule.loadPackagePage.mockResolvedValue(
		plainRepoPage({
			kodyId: 'skills',
			hasPackage: true,
			viewerIsOwner,
			viewerCanManage: viewerIsOwner,
			loggedIn: viewerIsOwner,
			ownerPackage: plainRepoOwnerPackage({
				id: 'pkg-skills',
				name: '@kentcdodds/skills',
				kodyId: 'skills',
				sourceId: 'src-1',
				isPrivate: true,
			}),
		}),
	)
	mockModule.getSavedPackageById.mockResolvedValue(privateSkillsPackage)
	mockModule.getEntitySourceById.mockResolvedValue(entitySource)
	mockModule.getUserSocialRowByUsername.mockResolvedValue(
		ownerSocialRow('public'),
	)
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'main',
		commit: 'abc123',
	})
	mockModule.readPublishedSourceSnapshot.mockResolvedValue(
		publishedSnapshot({
			'README.md': '# Skills\n',
			'src/skill-get.ts': skillGetSource,
		}),
	)
	mockModule.readArtifactFileAtCommit.mockResolvedValue(null)
	mockModule.readAuthenticatedAppUser.mockResolvedValue(
		viewerIsOwner ? viewer('owner-1') : null,
	)
}

function loadSkillGetRaw(
	extra: Partial<Parameters<typeof loadAccessiblePackageFileRaw>[0]> = {},
) {
	return loadAccessiblePackageFileRaw({
		env,
		request: new Request(
			'https://kody.codes/@kentcdodds/skills/raw/main/src/skill-get.ts',
		),
		username: 'kentcdodds',
		kodyId: 'skills',
		selectedPath: 'src/skill-get.ts',
		ref: 'main',
		...extra,
	})
}

test('owner reads their private unlisted package source as text at /raw/main/', async () => {
	publishPrivateSkillsPackage()
	const result = await loadSkillGetRaw()
	expect(result).toMatchObject({
		kind: 'ok',
		contentType: 'text/plain; charset=utf-8',
		disposition: 'inline',
		filename: 'skill-get.ts',
		isPrivate: true,
	})
	expect(result.kind === 'ok' && new TextDecoder().decode(result.bytes)).toBe(
		skillGetSource,
	)
	expect(mockModule.readPublishedSourceSnapshot).toHaveBeenCalledWith(
		expect.objectContaining({ publishedCommit: 'abc123' }),
	)
})

test('private package raw 404s for viewers without access and missing files', async () => {
	publishPrivateSkillsPackage({ viewerIsOwner: false })
	expect(await loadSkillGetRaw()).toEqual({ kind: 'not-found' })
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()

	publishPrivateSkillsPackage()
	expect(await loadSkillGetRaw({ selectedPath: 'src/missing.ts' })).toEqual({
		kind: 'not-found',
	})
})

test('raw forwards a bearer-authenticated viewer to the package page gate', async () => {
	publishPrivateSkillsPackage()
	const tokenViewer = viewer('owner-1').mcpUser
	await loadSkillGetRaw({ viewer: tokenViewer })
	expect(mockModule.loadPackagePage).toHaveBeenCalledWith(
		expect.objectContaining({ viewer: tokenViewer }),
	)
	await loadSkillGetRaw({ viewer: null })
	expect(mockModule.loadPackagePage).toHaveBeenLastCalledWith(
		expect.objectContaining({ viewer: null }),
	)
})

test('file views carry a raw href and directory views do not', async () => {
	publishPrivateSkillsPackage()
	const file = await loadAccessiblePackageFilesData({
		env,
		request: new Request(
			'https://kody.codes/@kentcdodds/skills/tree/main/src/skill-get.ts',
		),
		username: 'kentcdodds',
		kodyId: 'skills',
		selectedPath: 'src/skill-get.ts',
		ref: 'main',
	})
	expect(file).toMatchObject({
		kind: 'file',
		rawHref: '/@kentcdodds/skills/raw/main/src/skill-get.ts',
		mediaHref: null,
	})
	const directory = await loadAccessiblePackageFilesData({
		env,
		request: new Request('https://kody.codes/@kentcdodds/skills/tree/main'),
		username: 'kentcdodds',
		kodyId: 'skills',
		selectedPath: '',
		ref: 'main',
	})
	expect(directory).toMatchObject({ kind: 'directory', rawHref: null })

	publishListing()
	expect(await loadTree('README.md')).toMatchObject({
		rawHref: '/@kentcdodds/sentry/raw/main/README.md',
	})
})

test('an org-bound token reads another org like a signed-out visitor', async () => {
	publishPrivateSkillsPackage()
	const tokenViewer = viewer('owner-1').mcpUser
	const ownOrg = await loadSkillGetRaw({
		viewer: tokenViewer,
		viewerOrgId: ownerIdFromStored('owner-1'),
	})
	expect(ownOrg).toMatchObject({ kind: 'ok', isPrivate: true })
	expect(mockModule.loadPackagePage).toHaveBeenCalledTimes(1)

	mockModule.loadPackagePage.mockClear()
	mockModule.loadPackagePage
		.mockResolvedValueOnce(
			plainRepoPage({
				kodyId: 'skills',
				hasPackage: true,
				viewerIsOwner: true,
				ownerPackage: plainRepoOwnerPackage({ isPrivate: true }),
			}),
		)
		.mockResolvedValueOnce({ kind: 'not_found' })
	expect(
		await loadSkillGetRaw({ viewer: tokenViewer, viewerOrgId: 'team-a' }),
	).toEqual({ kind: 'not-found' })
	expect(mockModule.loadPackagePage).toHaveBeenLastCalledWith(
		expect.objectContaining({ viewer: null }),
	)
})

test('files above the raw size cap get no Raw link', async () => {
	publishPrivateSkillsPackage()
	mockModule.readPublishedSourceSnapshot.mockResolvedValue(
		publishedSnapshot({
			'data/large.csv': 'a'.repeat(maxPackageFilePreviewBytes + 1),
		}),
	)
	expect(
		await loadAccessiblePackageFilesData({
			env,
			request: new Request(
				'https://kody.codes/@kentcdodds/skills/tree/main/data/large.csv',
			),
			username: 'kentcdodds',
			kodyId: 'skills',
			selectedPath: 'data/large.csv',
			ref: 'main',
		}),
	).toMatchObject({ kind: 'file', rawHref: null })
})
