import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as AuthenticatedUser from '#app/authenticated-user.ts'
import type * as CommunityPackageRoute from '#app/community-package-route.ts'
import type * as PackageFilesData from '#app/package-files-data.ts'
import type * as PackagePage from '#app/package-page.ts'
import type * as PageAuth from '#app/page-auth.ts'
import type * as PackageRegistryRepo from '#worker/package-registry/repo.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser:
		vi.fn<
			(
				...args: Parameters<typeof AuthenticatedUser.readAuthenticatedAppUser>
			) => Promise<unknown>
		>(),
	requireAuthenticatedPageUser:
		vi.fn<
			(
				...args: Parameters<typeof PageAuth.requireAuthenticatedPageUser>
			) => Promise<unknown>
		>(),
	loadListingFilesData:
		vi.fn<
			(
				...args: Parameters<typeof PackageFilesData.loadListingFilesData>
			) => Promise<unknown>
		>(),
	loadAccountPackageFilesData:
		vi.fn<
			(
				...args: Parameters<typeof PackageFilesData.loadAccountPackageFilesData>
			) => Promise<unknown>
		>(),
	loadAccessiblePackageFilesData:
		vi.fn<
			(
				...args: Parameters<
					typeof PackageFilesData.loadAccessiblePackageFilesData
				>
			) => Promise<unknown>
		>(),
	loadPackagePage:
		vi.fn<
			(
				...args: Parameters<typeof PackagePage.loadPackagePage>
			) => Promise<unknown>
		>(),
	getSavedPackageById:
		vi.fn<
			(
				...args: Parameters<typeof PackageRegistryRepo.getSavedPackageById>
			) => Promise<unknown>
		>(),
	resolveCommunityFilesRoute:
		vi.fn<
			(
				...args: Parameters<
					typeof CommunityPackageRoute.resolveCommunityFilesRoute
				>
			) => Promise<unknown>
		>(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (
		...args: Parameters<typeof AuthenticatedUser.readAuthenticatedAppUser>
	) => mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (
		...args: Parameters<typeof PageAuth.requireAuthenticatedPageUser>
	) => mockModule.requireAuthenticatedPageUser(...args),
}))

vi.mock('#app/package-page.ts', () => ({
	loadPackagePage: (...args: Parameters<typeof PackagePage.loadPackagePage>) =>
		mockModule.loadPackagePage(...args),
}))

vi.mock('#app/community-package-route.ts', () => ({
	resolveCommunityFilesRoute: (
		...args: Parameters<typeof CommunityPackageRoute.resolveCommunityFilesRoute>
	) => mockModule.resolveCommunityFilesRoute(...args),
	resolveCanonicalFilesPath: async () => null,
	treeHrefFromPackageHome: (
		packageHref: string,
		input: { ref?: string; relativePath?: string },
	) => {
		const ref = input.ref?.trim() || 'main'
		const relativePath = input.relativePath?.trim()
		return relativePath
			? `${packageHref}/tree/${ref}/${relativePath}`
			: `${packageHref}/tree/${ref}`
	},
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageByIdInAnyOrg: async () => ({
		id: 'pkg-1',
		userId: ownerIdFromStored('stable-user-1'),
		kodyId: 'demo',
	}),
	getSavedPackageById: (
		...args: Parameters<typeof PackageRegistryRepo.getSavedPackageById>
	) => mockModule.getSavedPackageById(...args),
}))

vi.mock('#app/package-viewer-access.ts', () => ({
	viewerCanReadSavedPackage: async () => true,
}))
vi.mock('#worker/orgs/repo.ts', () => ({
	loadOrgBindingForOrg: async () => ({ org: { slug: 'owner' } }),
}))

vi.mock('#app/package-files-data.ts', () => ({
	loadListingFilesData: (
		...args: Parameters<typeof PackageFilesData.loadListingFilesData>
	) => mockModule.loadListingFilesData(...args),
	loadAccountPackageFilesData: (
		...args: Parameters<typeof PackageFilesData.loadAccountPackageFilesData>
	) => mockModule.loadAccountPackageFilesData(...args),
	loadAccessiblePackageFilesData: (
		...args: Parameters<typeof PackageFilesData.loadAccessiblePackageFilesData>
	) => mockModule.loadAccessiblePackageFilesData(...args),
	readPackageFilesSelectedPath: (requestUrl: string) => {
		const url = new URL(requestUrl, 'http://localhost')
		const raw = url.searchParams.get('path')
		if (raw == null) return ''
		if (raw.includes('..')) return null
		return raw
	},
}))

const native = vi.hoisted(() => ({
	env: {} as Env,
	request: new Request('https://example.com/login'),
	setResponseHeader: vi.fn(),
}))
vi.mock('@tanstack/react-start', () => ({
	createServerOnlyFn: <T>(fn: T) => fn,
	createServerFn: () => {
		let validate = (data: unknown) => data
		const builder = {
			validator: (fn: { parse: (data: unknown) => unknown }) => {
				validate = fn.parse
				return builder
			},
			handler:
				(fn: (input: { data: unknown }) => unknown) =>
				(input: { data: unknown }) =>
					fn({ data: validate(input.data) }),
		}
		return builder
	},
}))
vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	get env() {
		return native.env
	},
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => native.request,
	setResponseHeader: native.setResponseHeader,
}))
vi.mock('#app/env.ts', () => ({ getEnv: () => native.env }))

const { loadPackageFiles } =
	await import('../../../start/server/package-files.ts')

test('canonical file reads resolve data and reject missing or invalid trees', async () => {
	native.env = {
		COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
	} as Env
	mockModule.resolveCommunityFilesRoute.mockResolvedValue({
		kind: 'package',
		username: 'owner',
		kodyId: 'demo',
		selectedPath: 'src/index.ts',
		ref: 'main',
	})
	mockModule.loadAccessiblePackageFilesData.mockResolvedValue({
		ok: true,
		content: 'export const answer = 42',
	})
	const result = await loadPackageFiles({
		data: {
			resource: {
				kind: 'package-tree',
				username: 'owner',
				kodyId: 'demo',
				ref: 'main',
				relativePath: 'src/index.ts',
			},
			location: '/@owner/demo/tree/main/src/index.ts',
		},
	})
	expect(result.data).toMatchObject({
		ok: true,
		content: 'export const answer = 42',
	})
	mockModule.resolveCommunityFilesRoute.mockResolvedValue({
		kind: 'invalid-path',
	})
	await expect(
		loadPackageFiles({
			data: {
				resource: {
					kind: 'package-tree',
					username: 'owner',
					kodyId: 'demo',
					ref: 'main',
					relativePath: 'secret',
				},
				location: '/@owner/demo/tree/main/secret',
			},
		}),
	).rejects.toBeDefined()
	mockModule.resolveCommunityFilesRoute.mockResolvedValue({
		kind: 'package',
		username: 'owner',
		kodyId: 'demo',
		selectedPath: 'missing',
		ref: 'main',
	})
	mockModule.loadAccessiblePackageFilesData.mockResolvedValue(null)
	await expect(
		loadPackageFiles({
			data: {
				resource: {
					kind: 'package-tree',
					username: 'owner',
					kodyId: 'demo',
					ref: 'main',
					relativePath: 'missing',
				},
				location: '/@owner/demo/tree/main/missing',
			},
		}),
	).rejects.toBeDefined()
})

test('unlisted leftover tree redirects stay private; listed leftovers stay public', async () => {
	native.env = {
		COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
	} as Env
	const cases = [
		{
			kodyId: 'friction-log',
			shared: false,
			status: 302,
			cacheControl: 'private, no-store',
		},
		{
			kodyId: 'sentry',
			shared: true,
			status: 301,
			cacheControl: 'public, max-age=3600',
		},
	]
	for (const { kodyId, shared, status, cacheControl } of cases) {
		mockModule.resolveCommunityFilesRoute.mockResolvedValue({
			kind: 'redirect',
			to: `/@owner/${kodyId}/tree/main`,
			shared,
		})
		native.request = new Request(`https://example.com/@owner/${kodyId}/files`)
		native.setResponseHeader.mockClear()
		await expect(
			loadPackageFiles({
				data: {
					resource: {
						kind: 'package-files',
						username: 'owner',
						kodyId,
						relativePath: '',
					},
					location: `/@owner/${kodyId}/files`,
				},
			}),
		).rejects.toMatchObject({
			status,
			options: { href: `https://example.com/@owner/${kodyId}/tree/main` },
		})
		expect(native.setResponseHeader).toHaveBeenCalledWith(
			'Cache-Control',
			cacheControl,
		)
	}
})

test('canonical listed tree server loader preserves URL package path and repository actions', async () => {
	native.env = {
		COOKIE_SECRET: 'test-cookie-secret-0123456789abcdef0123456789',
	} as Env
	native.request = new Request('https://example.com/@owner/demo/tree/main')
	mockModule.resolveCommunityFilesRoute.mockResolvedValue({
		kind: 'listing',
		listingId: 'listing-1',
		selectedPath: '',
		ref: 'main',
		packagePath: { username: 'owner', kodyId: 'demo' },
	})
	const withActions = {
		ok: true,
		kind: 'tree',
		paths: [],
		children: [],
		repoActions: null,
	}
	mockModule.loadListingFilesData.mockResolvedValue(withActions)

	const result = await loadPackageFiles({
		data: {
			resource: {
				kind: 'package-tree',
				username: 'owner',
				kodyId: 'demo',
				ref: 'main',
				relativePath: '',
			},
			location: '/@owner/demo/tree/main',
		},
	})
	expect(mockModule.loadListingFilesData).toHaveBeenLastCalledWith(
		expect.objectContaining({
			listingId: 'listing-1',
			ref: 'main',
			packagePath: { username: 'owner', kodyId: 'demo' },
		}),
	)
	expect(result.data).toEqual(withActions)
})
