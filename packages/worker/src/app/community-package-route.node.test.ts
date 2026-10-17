import { type PackageFilesResource } from './community-package-route.ts'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	resolveCommunityPackageUrl: vi.fn<() => Promise<unknown>>(),
	getCommunityListingById: vi.fn<() => Promise<unknown>>(),
	getEntitySourceById: vi.fn<() => Promise<unknown>>(),
	resolveArtifactSourceHead: vi.fn<() => Promise<unknown>>(),
	loadPackagePage: vi.fn<() => Promise<unknown>>(),
}))

vi.mock('#worker/community/package-url.ts', () => ({
	getCommunityPackageHref: (input: { username: string; kodyId: string }) =>
		`/@${input.username}/${input.kodyId}`,
	resolveCommunityPackageUrl: mockModule.resolveCommunityPackageUrl,
}))
vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingById: mockModule.getCommunityListingById,
}))
vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: mockModule.getEntitySourceById,
}))
vi.mock('#worker/repo/artifact-head-cache.ts', () => ({
	resolveCachedArtifactSourceHead: mockModule.resolveArtifactSourceHead,
}))
vi.mock('#app/package-page.ts', () => ({
	loadPackagePage: mockModule.loadPackagePage,
}))

const { resolveCommunityFilesRoute } =
	await import('./community-package-route.ts')

const env = { APP_DB: {} as D1Database } as Env

function resolveRoute(
	resource: Extract<PackageFilesResource, { username: string }>,
	withRequest = false,
) {
	const pathname = `/@${resource.username}/${resource.kodyId}/${resource.kind === 'package-tree' ? `tree/${resource.ref}` : 'files'}${resource.relativePath ? `/${resource.relativePath}` : ''}`
	const url = `https://example.com${pathname}`
	return resolveCommunityFilesRoute({
		env,
		resource,
		pathname,
		queryRef: '',
		...(withRequest ? { request: new Request(url) } : {}),
	})
}

const redirect = (to: string, shared: boolean) => ({
	kind: 'redirect',
	to,
	shared,
})

function ownerPackagePage(overrides: Record<string, unknown> = {}) {
	return {
		kind: 'page',
		username: 'kentcdodds',
		kodyId: 'friction-log',
		listing: null,
		ownerPackage: { sourceId: 'src-1', isPrivate: true },
		viewerIsOwner: true,
		loggedIn: true,
		invocationUrlOrigin: 'https://example.com',
		...overrides,
	}
}

test('leftover /files and /tree/HEAD 301 to the looked-up default branch', async () => {
	mockModule.resolveCommunityPackageUrl.mockResolvedValue({
		kind: 'listing',
		listingId: 'listing-1',
		username: 'kentcdodds',
		kodyId: 'devin',
	})
	mockModule.getCommunityListingById.mockResolvedValue({
		id: 'listing-1',
		sourceId: 'src-1',
	})
	mockModule.getEntitySourceById.mockResolvedValue({ repo_id: 'repo-1' })
	mockModule.resolveArtifactSourceHead.mockResolvedValue({
		branch: 'release',
		commit: 'abc',
	})

	for (const [resource, to] of [
		[
			{
				kind: 'package-files',
				username: 'kentcdodds',
				kodyId: 'devin',
				relativePath: 'src/index.ts',
			},
			'/@kentcdodds/devin/tree/release/src/index.ts',
		],
		[
			{
				kind: 'package-tree',
				username: 'kentcdodds',
				kodyId: 'devin',
				ref: 'HEAD',
				relativePath: '',
			},
			'/@kentcdodds/devin/tree/release',
		],
		[
			{
				kind: 'package-tree',
				username: 'kentcdodds',
				kodyId: 'devin',
				ref: 'head',
				relativePath: 'src/index.ts',
			},
			'/@kentcdodds/devin/tree/release/src/index.ts',
		],
	] as const) {
		expect(await resolveRoute(resource)).toEqual(redirect(to, true))
	}

	mockModule.resolveArtifactSourceHead.mockClear()
	for (const ref of ['release', 'main']) {
		expect(
			await resolveRoute({
				kind: 'package-tree',
				username: 'kentcdodds',
				kodyId: 'devin',
				ref,
				relativePath: '',
			}),
		).toEqual({
			kind: 'listing',
			listingId: 'listing-1',
			selectedPath: '',
			ref,
			packagePath: { username: 'kentcdodds', kodyId: 'devin' },
		})
	}
	expect(mockModule.resolveArtifactSourceHead).not.toHaveBeenCalled()

	mockModule.resolveArtifactSourceHead.mockRejectedValue(new Error('no git'))
	expect(
		await resolveRoute({
			kind: 'package-files',
			username: 'kentcdodds',
			kodyId: 'devin',
			relativePath: '',
		}),
	).toEqual(redirect('/@kentcdodds/devin/tree/main', true))
})

test('unlisted owner tree uses the package page; strangers are unauthorized', async () => {
	mockModule.resolveCommunityPackageUrl.mockResolvedValue(null)
	mockModule.loadPackagePage.mockResolvedValue(ownerPackagePage())
	expect(
		await resolveRoute(
			{
				kind: 'package-tree',
				username: 'kentcdodds',
				kodyId: 'friction-log',
				ref: 'main',
				relativePath: '',
			},
			true,
		),
	).toEqual({
		kind: 'package',
		username: 'kentcdodds',
		kodyId: 'friction-log',
		selectedPath: '',
		ref: 'main',
	})

	mockModule.loadPackagePage.mockResolvedValue({ kind: 'unauthorized' })
	expect(
		await resolveRoute(
			{
				kind: 'package-tree',
				username: 'kentcdodds',
				kodyId: 'friction-log',
				ref: 'main',
				relativePath: '',
			},
			true,
		),
	).toEqual({ kind: 'unauthorized' })
})

test('unlisted leftover /files and rename hops stay owner-private', async () => {
	mockModule.resolveCommunityPackageUrl.mockResolvedValue(null)
	mockModule.getEntitySourceById.mockResolvedValue(null)
	mockModule.loadPackagePage.mockResolvedValue(ownerPackagePage())
	expect(
		await resolveRoute(
			{
				kind: 'package-files',
				username: 'kentcdodds',
				kodyId: 'friction-log',
				relativePath: '',
			},
			true,
		),
	).toEqual(redirect('/@kentcdodds/friction-log/tree/main', false))

	mockModule.loadPackagePage.mockResolvedValue(
		redirect('/@kentcdodds/friction-log', false),
	)
	expect(
		await resolveRoute(
			{
				kind: 'package-tree',
				username: 'kentcdodds',
				kodyId: 'old-log',
				ref: 'main',
				relativePath: '',
			},
			true,
		),
	).toEqual(redirect('/@kentcdodds/friction-log/tree/main', false))

	mockModule.loadPackagePage.mockResolvedValue(
		ownerPackagePage({
			kodyId: 'friction-log-two',
			listing: { listing: { id: 'listing-1', kodyId: 'friction-log' } },
			ownerPackage: { sourceId: 'src-1', isPrivate: false },
		}),
	)
	expect(
		await resolveRoute(
			{
				kind: 'package-files',
				username: 'kentcdodds',
				kodyId: 'friction-log-two',
				relativePath: '',
			},
			true,
		),
	).toEqual(redirect('/@kentcdodds/friction-log-two/tree/main', false))
})

test('signed-in denial retains request-access data for the native files page', async () => {
	mockModule.resolveCommunityPackageUrl.mockResolvedValue(null)
	const denial = {
		kind: 'no_access',
		username: 'owner',
		kodyId: 'private',
		packageName: '@owner/private',
		viewerUsername: 'visitor',
	}
	mockModule.loadPackagePage.mockResolvedValue(denial)
	expect(
		await resolveRoute(
			{
				kind: 'package-tree',
				username: 'owner',
				kodyId: 'private',
				ref: 'main',
				relativePath: '',
			},
			true,
		),
	).toEqual(denial)
})

test('canonical package redirect keeps tree ref and file while other redirect kinds stay untouched', async () => {
	const { treeHrefFromPackageHome } =
		await import('./community-package-route.ts')
	expect(
		treeHrefFromPackageHome('/@alice/tool/?ignored=1', {
			ref: 'release',
			relativePath: 'src/main.ts',
		}),
	).toBe('/@alice/tool/tree/release/src/main.ts')
	expect(treeHrefFromPackageHome('/@%61lice/tool', { ref: 'main' })).toBe(
		'/@alice/tool/tree/main',
	)
	for (const href of [
		'/community/listing',
		'/@alice/tool/settings',
		'/login?redirectTo=%2Faccount',
		'/@alice/%E0%A4%A',
	]) {
		expect(treeHrefFromPackageHome(href, { ref: 'main' })).toBe(href)
	}
})
