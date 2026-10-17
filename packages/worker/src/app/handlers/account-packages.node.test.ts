import type * as OrgRepo from '#worker/orgs/repo.ts'
import type * as CloudflareWorkers from 'cloudflare:workers'
import {
	ownerIdFromStored,
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as authenticatedUserModule from '#app/authenticated-user.ts'
import type * as packageRepo from '#worker/package-registry/repo.ts'
import type * as packageSource from '#worker/package-registry/source.ts'
import type * as entitySources from '#worker/repo/entity-sources.ts'
import type * as publishedSource from '#worker/repo/published-source.ts'
import type * as communityRepo from '#worker/community/repo.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'

const mockModule = vi.hoisted(() => {
	const savedPackage = {
		id: 'pkg-1',
		userId: 'stable-user-1' as OwnerId,
		name: '@test/discord-gateway',
		kodyId: 'discord-gateway',
		description: 'Dispatch Discord gateway events.',
		tags: ['discord', 'events'],
		searchText: 'discord gateway websocket',
		sourceId: 'source-1',
		hasApp: true,
		hasSkills: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		lockedAt: null,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	}
	const sourceRow = {
		id: 'source-1',
		user_id: 'stable-user-1' as OwnerId,
		entity_kind: 'package' as const,
		entity_id: 'pkg-1',
		repo_id: 'repo-1',
		published_commit: 'commit-1',
		indexed_commit: 'commit-1',
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: new Date(0).toISOString(),
		updated_at: new Date(0).toISOString(),
	}
	const publishedManifestContent = JSON.stringify({
		name: '@test/discord-gateway',
		version: '1.2.3',
		exports: {
			'./dispatch-message-created': { import: './src/index.ts' },
		},
		kody: {
			id: 'discord-gateway',
			description: 'Dispatch Discord gateway events.',
		},
	})
	return {
		savedPackage,
		sourceRow,
		publishedManifestContent,
		readAuthenticatedAppUser: vi.fn<
			typeof authenticatedUserModule.readAuthenticatedAppUser
		>(async () => ({
			sessionUserId: '42',
			userId: 42,
			username: 'test-user',
			email: 'user@example.com',
			emailVerified: true,
			emailVerificationDelivery: null,
			displayName: 'user',
			roles: ['user'],
			permissions: [],
			artifactOwnerIds: [],
			mcpUser: {
				userId: personIdFromStored('stable-user-1'),
				email: 'user@example.com',
				username: 'test-user',
				displayName: 'user',
			},
			request: sessionRequestContext('stable-user-1'),
		})),
		searchSavedPackagesByUserId: vi.fn<
			typeof packageRepo.searchSavedPackagesByUserId
		>(async () => ({
			items: [savedPackage],
			total: 1,
		})),
		getSavedPackageById: vi.fn<typeof packageRepo.getSavedPackageById>(
			async () => savedPackage,
		),
		getSavedPackageByIdInAnyOrg: vi.fn<
			typeof packageRepo.getSavedPackageByIdInAnyOrg
		>(async (_db, packageId) =>
			packageId === savedPackage.id ? savedPackage : null,
		),
		getSavedPackageWithCommunityProvenanceById: vi.fn<
			typeof packageRepo.getSavedPackageWithCommunityProvenanceById
		>(async () => ({
			...savedPackage,
			sourceListingId: null,
			listingCurrent: null,
			listingKodyId: null,
			listingName: null,
			originCommit: null,
			listingPinnedCommit: null,
			listingPublishedAt: null,
			listingAhead: null,
			forkListingRelation: null,
		})),
		listSavedPackageCommunityProvenanceByIds: vi.fn<
			typeof packageRepo.listSavedPackageCommunityProvenanceByIds
		>(async () => []),
		getEntitySourceById: vi.fn<typeof entitySources.getEntitySourceById>(
			async () => null,
		),
		getAppBaseUrl: () => 'https://example.com',
		loadPackageSourceRowForUser: vi.fn<
			typeof packageSource.loadPackageSourceRowForUser
		>(async () => sourceRow),
		loadPublishedEntityManifest: vi.fn<
			typeof publishedSource.loadPublishedEntityManifest
		>(async () => ({
			source: sourceRow,
			content: publishedManifestContent,
			manifest: {
				name: '@test/discord-gateway',
				exports: {
					'./dispatch-message-created': { import: './src/index.ts' },
				},
				kody: {
					id: 'discord-gateway',
					description: 'Dispatch Discord gateway events.',
				},
			},
		})),
		getCommunityListingByOwnerAndPackage: vi.fn<
			typeof communityRepo.getCommunityListingByOwnerAndPackage
		>(async () => null),
		requireAuthenticatedPageUser: vi.fn(),
	}
})

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (
		...args: Parameters<typeof authenticatedUserModule.readAuthenticatedAppUser>
	) => mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/auth-session.ts', () => ({
	readAuthSessionResult: async () => ({ session: null, setCookie: null }),
	setAuthSessionSecret: vi.fn(),
}))

vi.mock('#app/auth-redirect.ts', () => ({
	redirectToLogin: () => new Response(null, { status: 302 }),
	redirectToLoginWhenUnauthenticated: () => new Response(null, { status: 302 }),
}))

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mockModule.requireAuthenticatedPageUser(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingByOwnerAndPackage: (
		...args: Parameters<
			typeof communityRepo.getCommunityListingByOwnerAndPackage
		>
	) => mockModule.getCommunityListingByOwnerAndPackage(...args),
}))

vi.mock('@tanstack/react-start', async () => ({
	createServerFn: (
		await import('#worker/test-support/start-server-function.ts')
	).createTestServerFn,
	createServerOnlyFn: <T>(fn: T) => fn,
}))
vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof CloudflareWorkers>()),
	env: { APP_DB: {}, COOKIE_SECRET: 'test' },
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => new Request('https://example.com/_serverFn/alias'),
	setResponseHeader: vi.fn(),
}))
vi.mock('#app/env.ts', () => ({ getEnv: (env: unknown) => env }))

vi.mock('#worker/app-base-url.ts', () => ({
	getAppBaseUrl: () => mockModule.getAppBaseUrl(),
}))

vi.mock('#worker/community/fork-listing-relation.ts', () => ({
	applySavedPackageForkListingAncestry: async ({
		records,
	}: {
		records: Array<unknown>
	}) => records,
}))

vi.mock('#app/package-viewer-access.ts', () => ({
	viewerCanReadSavedPackage: vi.fn(async () => true),
	viewerCanManageSavedPackage: vi.fn(async () => true),
}))

vi.mock('#worker/orgs/repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof OrgRepo>()
	return {
		...actual,
		loadOrgBindingForOrg: vi.fn(async () => ({
			org: { id: ownerIdFromStored('stable-user-1'), slug: 'test-user' },
			role: 'owner' as const,
		})),
	}
})

vi.mock('#worker/package-registry/repo.ts', () => ({
	searchSavedPackagesByUserId: (
		...args: Parameters<typeof packageRepo.searchSavedPackagesByUserId>
	) => mockModule.searchSavedPackagesByUserId(...args),
	getSavedPackageById: (
		...args: Parameters<typeof packageRepo.getSavedPackageById>
	) => mockModule.getSavedPackageById(...args),
	getSavedPackageByIdInAnyOrg: (
		...args: Parameters<typeof packageRepo.getSavedPackageByIdInAnyOrg>
	) => mockModule.getSavedPackageByIdInAnyOrg(...args),
	getSavedPackageWithCommunityProvenanceById: (
		...args: Parameters<
			typeof packageRepo.getSavedPackageWithCommunityProvenanceById
		>
	) => mockModule.getSavedPackageWithCommunityProvenanceById(...args),
	listSavedPackageCommunityProvenanceByIds: (
		...args: Parameters<
			typeof packageRepo.listSavedPackageCommunityProvenanceByIds
		>
	) => mockModule.listSavedPackageCommunityProvenanceByIds(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceRowForUser: (
		...args: Parameters<typeof packageSource.loadPackageSourceRowForUser>
	) => mockModule.loadPackageSourceRowForUser(...args),
}))

vi.mock('#worker/repo/published-source.ts', () => ({
	loadPublishedEntityManifest: (
		...args: Parameters<typeof publishedSource.loadPublishedEntityManifest>
	) => mockModule.loadPublishedEntityManifest(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (
		...args: Parameters<typeof entitySources.getEntitySourceById>
	) => mockModule.getEntitySourceById(...args),
}))

const { loadAccountPackagesData } = await import('../account-packages-data.ts')
const { loadAccountPackageAlias } =
	await import('../../../start/server/package-alias.ts')

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		COOKIE_SECRET: 'secret',
	} as Env
}

function createPackagesClient() {
	const env = createEnv()
	return {
		env,
		get: async (search = '') => {
			const request = new Request(
				`https://example.com/account/packages${search}`,
			)
			const user = await mockModule.readAuthenticatedAppUser(request, env)
			if (!user) throw new Error('Sign in required.')
			return loadAccountPackagesData({ env, request, user })
		},
	}
}

test('packages API lists with filters, ignores invalid values, and rejects unknown actions', async () => {
	const { env, get } = createPackagesClient()
	const searchCall = (input: Record<string, unknown>) =>
		expect(mockModule.searchSavedPackagesByUserId).toHaveBeenLastCalledWith(
			env.APP_DB,
			{ userId: 'stable-user-1' as OwnerId, ...input },
		)

	const defaults = await get()
	searchCall({
		query: '',
		hasApp: null,
		sort: 'updated',
		limit: 20,
		offset: 0,
	})
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()
	expect(defaults).toMatchObject({
		ok: true,
		email: 'user@example.com',
		username: 'test-user',
		invocationUrlOrigin: 'https://example.com',
		packages: [
			expect.objectContaining({
				id: 'pkg-1',
				kodyId: 'discord-gateway',
				hasApp: true,
			}),
		],
		selectedPackage: null,
		page: 1,
		pageSize: 20,
		total: 1,
		query: '',
		appFilter: 'all',
		sort: 'updated',
	})

	const filtered = await get(
		'?q=discord&app=with&sort=name&page=3&pageSize=10&selected=pkg-1',
	)
	searchCall({
		query: 'discord',
		hasApp: true,
		sort: 'name',
		limit: 10,
		offset: 20,
	})
	expect(
		mockModule.getSavedPackageWithCommunityProvenanceById,
	).toHaveBeenCalledWith(env.APP_DB, {
		userId: 'stable-user-1' as OwnerId,
		packageId: 'pkg-1',
	})
	const filteredPayload = filtered
	expect(filteredPayload).toMatchObject({
		ok: true,
		page: 3,
		pageSize: 10,
		query: 'discord',
		appFilter: 'with',
		sort: 'name',
		selectedPackage: {
			id: 'pkg-1',
			searchText: 'discord gateway websocket',
			exports: ['./dispatch-message-created'],
			publishedVersion: '1.2.3',
		},
	})
	expect(mockModule.loadPackageSourceRowForUser).toHaveBeenCalledWith({
		env,
		userId: 'stable-user-1' as OwnerId,
		sourceId: 'source-1',
	})
	expect(mockModule.loadPublishedEntityManifest).toHaveBeenCalledWith({
		env,
		userId: 'stable-user-1' as OwnerId,
		sourceId: 'source-1',
		source: mockModule.sourceRow,
	})

	mockModule.loadPublishedEntityManifest.mockRejectedValueOnce(
		new Error('Saved package source bindings are not available.'),
	)
	expect(await get('?selected=pkg-1')).toMatchObject({
		ok: true,
		selectedPackage: {
			id: 'pkg-1',
			exports: null,
			publishedVersion: null,
		},
	})

	mockModule.getSavedPackageWithCommunityProvenanceById.mockResolvedValue(
		null as never,
	)
	const invalid = await get('?app=bogus&sort=bogus&selected=missing-package')
	expect(mockModule.searchSavedPackagesByUserId).toHaveBeenLastCalledWith(
		env.APP_DB,
		expect.objectContaining({ hasApp: null, sort: 'updated' }),
	)
	expect(invalid).toMatchObject({
		ok: true,
		selectedPackage: null,
		appFilter: 'all',
		sort: 'updated',
	})

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null as never)
	await expect(get()).rejects.toThrow('Sign in required.')
})

test('account package detail redirects the owner to the canonical package URL', async () => {
	mockModule.requireAuthenticatedPageUser.mockResolvedValue({
		username: 'test-user',
		email: 'user@example.com',
		mcpUser: {
			userId: personIdFromStored('stable-user-1'),
			email: 'user@example.com',
			username: 'test-user',
			displayName: 'user',
		},
	})
	await expect(
		loadAccountPackageAlias({
			data: { packageId: 'pkg-1', search: '?q=discord' },
		}),
	).rejects.toMatchObject({
		options: {
			href: '/@test-user/discord-gateway?q=discord',
			statusCode: 302,
		},
	})
	mockModule.getSavedPackageById.mockResolvedValueOnce(null)
	mockModule.getSavedPackageByIdInAnyOrg.mockResolvedValueOnce(null)
	await expect(
		loadAccountPackageAlias({ data: { packageId: 'missing', search: '' } }),
	).rejects.toMatchObject({ isNotFound: true })
})

test('native package alias redirects accessible team packages to their owning organization and requires manage access for approval', async () => {
	mockModule.requireAuthenticatedPageUser.mockResolvedValue({
		username: 'test-user',
		mcpUser: { userId: personIdFromStored('stable-user-1') },
	})
	const { loadOrgBindingForOrg } = await import('#worker/orgs/repo.ts')
	const { viewerCanManageSavedPackage, viewerCanReadSavedPackage } =
		await import('#app/package-viewer-access.ts')
	const binding = await loadOrgBindingForOrg(
		{} as D1Database,
		personIdFromStored('stable-user-1'),
		ownerIdFromStored('stable-user-1'),
	)
	if (!binding) throw new Error('Missing fixture binding')
	vi.mocked(loadOrgBindingForOrg).mockResolvedValueOnce({
		...binding,
		org: { ...binding.org, slug: 'shared-team' },
	})
	await expect(
		loadAccountPackageAlias({
			data: { packageId: 'pkg-1', search: '?q=discord' },
		}),
	).rejects.toMatchObject({
		options: {
			href: '/@shared-team/discord-gateway?q=discord',
			statusCode: 302,
		},
	})
	vi.mocked(viewerCanManageSavedPackage).mockResolvedValueOnce(false)
	await expect(
		loadAccountPackageAlias({
			data: { packageId: 'pkg-1', approval: 'publish', search: '' },
		}),
	).rejects.toMatchObject({ isNotFound: true })
	vi.mocked(viewerCanReadSavedPackage).mockResolvedValueOnce(false)
	await expect(
		loadAccountPackageAlias({ data: { packageId: 'pkg-1', search: '' } }),
	).rejects.toMatchObject({ isNotFound: true })
})

test('packages API loads the selected package detail while list provenance is still loading', async () => {
	let releaseProvenance!: () => void
	const provenanceGate = new Promise<void>((resolve) => {
		releaseProvenance = resolve
	})
	mockModule.listSavedPackageCommunityProvenanceByIds.mockImplementation(
		async () => {
			await provenanceGate
			return []
		},
	)

	const responding = createPackagesClient().get('?selected=pkg-1')
	await vi.waitFor(() => {
		expect(mockModule.loadPublishedEntityManifest).toHaveBeenCalled()
	})
	releaseProvenance()
	const response = await responding
	expect(response).toMatchObject({
		selectedPackage: expect.objectContaining({
			id: 'pkg-1',
			publishedVersion: '1.2.3',
		}),
	})
})
