import { beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	payload: {} as Record<string, unknown>,
	communityRead: vi.fn(async () => ({ packages: [] })),
	profileRead: vi.fn(async () => null),
	packageRead: vi.fn(),
	kind: 'page',
	canonical: null as string | null,
	moved: { kind: 'redirect', to: '/@owner/new', shared: true },
	headers: new Headers(),
	status: 200,
	request: new Request('https://kody.test/_server/test', {
		headers: { Cookie: 'kody_session=test' },
	}),
}))

// Exercise the real validator and handler without a Start HTTP transport.
vi.mock('@tanstack/react-start', () => ({
	createServerOnlyFn: <T>(fn: T) => fn,
	createServerFn: () => {
		let validate = (data: unknown) => data
		const builder = {
			validator(
				next: ((data: unknown) => unknown) | { parse(data: unknown): unknown },
			) {
				validate =
					typeof next === 'function' ? next : (data) => next.parse(data)
				return builder
			},
			handler(run: (input: { data: unknown }) => Promise<unknown>) {
				return (input: { data: unknown }) => run({ data: validate(input.data) })
			},
		}
		return builder
	},
}))
vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	env: { COOKIE_SECRET: 'test' },
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => mocks.request,
	setResponseHeader: (name: string, value: string) =>
		mocks.headers.set(name, value),
	setResponseStatus: (status: number) => {
		mocks.status = status
	},
}))
vi.mock('../../src/app/env.ts', () => ({ getEnv: (env: unknown) => env }))
vi.mock('../../src/app/auth-session.ts', () => ({
	setAuthSessionSecret: () => {},
}))
vi.mock('../../src/app/community-package-payload.ts', () => ({
	loadCommunityPackagePayload: async (input: unknown) => {
		mocks.packageRead(input)
		return mocks.kind === 'redirect'
			? mocks.moved
			: mocks.kind === 'no_access'
				? { kind: 'no_access', ...mocks.payload }
				: { kind: mocks.kind, data: mocks.payload }
	},
	loadCommunityDetailPayload: async () => ({
		kind: 'page',
		data: mocks.payload,
	}),
}))
vi.mock('../../src/app/profile-data.ts', () => ({
	loadProfileData: mocks.profileRead,
}))
vi.mock('../../src/app/community-data.ts', () => ({
	loadCommunityIndexData: mocks.communityRead,
	loadCommunityDetailData: async () => ({
		listing: { ownerUsername: 'owner', kodyId: 'package' },
	}),
}))
vi.mock('../../src/app/community-package-route.ts', () => ({
	resolveCanonicalListingPath: async () => mocks.canonical,
}))
vi.mock('./document-head.ts', () => ({
	loadDocumentHead: () => ({ title: 'Package' }),
}))
vi.mock('../../src/app/session-info.ts', () => ({
	loadSessionInfo: async () => ({ session: null, setCookie: null }),
}))
vi.mock('../../universal/identity-icon-urls.ts', () => ({
	resolvePackageListIconUrl: () => null,
}))
vi.mock('../../src/package-registry/package-publish-lock.ts', () => ({
	buildPackagePublishApprovalPath: () => '/approval',
}))
const { loadPackage, loadCommunity, loadProfile } =
	await import('./public-data.ts')

beforeEach(() => {
	vi.clearAllMocks()
	mocks.headers = new Headers()
	mocks.status = 200
	mocks.kind = 'page'
	mocks.canonical = null
	mocks.moved = { kind: 'redirect', to: '/@owner/new', shared: true }
})

test('accepted shares cannot enter owner settings even when they include package metadata', async () => {
	mocks.payload = {
		ok: true,
		viewerIsOwner: false,
		ownerPackage: { id: 'owned-by-someone-else' },
	}
	await expect(
		loadPackage({
			data: { username: 'owner', kodyId: 'package', page: 'settings' },
		}),
	).rejects.toMatchObject({ isNotFound: true })
})
test('unauthorized packages retain HTTP 401 instead of a successful document', async () => {
	mocks.kind = 'unauthorized'
	await expect(
		loadPackage({ data: { username: 'owner', kodyId: 'private' } }),
	).resolves.toEqual({ kind: 'unauthorized' })
	expect(mocks.status).toBe(401)
})
test.each([true, false])(
	'moved packages preserve queries and public/private redirect policy, public=%s',
	async (shared) => {
		mocks.moved.shared = shared
		mocks.kind = 'redirect'
		await expect(
			loadPackage({
				data: {
					username: 'owner',
					kodyId: 'old',
					page: 'settings',
					search: '?commit=abc&view=diff',
				},
			}),
		).rejects.toMatchObject({
			options: {
				href: '/@owner/new/settings?commit=abc&view=diff',
				statusCode: shared ? 301 : 302,
			},
		})
		expect(mocks.headers.get('Cache-Control')).toBe(
			shared ? 'public, max-age=3600' : 'private, no-store',
		)
	},
)

test('listing UUID URLs preserve query on canonical redirect and render when canonical resolution is unavailable', async () => {
	mocks.canonical = '/@owner/package'
	await expect(
		loadPackage({
			data: {
				username: '',
				kodyId: '',
				listingId: 'listing-1',
				search: '?source=share',
			},
		}),
	).rejects.toMatchObject({
		options: { href: '/@owner/package?source=share', statusCode: 301 },
	})
	expect(mocks.headers.get('Cache-Control')).toBe('public, max-age=3600')
	expect(mocks.headers.get('Vary')).toBeNull()
	mocks.canonical = null
	mocks.payload = {
		ok: true,
		username: 'owner',
		kodyId: 'package',
		listing: { id: 'listing-1' },
	}
	await expect(
		loadPackage({ data: { username: '', kodyId: '', listingId: 'listing-1' } }),
	).resolves.toMatchObject({
		kind: 'page',
		data: { listing: { id: 'listing-1' } },
	})
})

test.each([true, false])(
	'private packages expose unpublished changes only to managers, manager=%s',
	async (viewerCanManage) => {
		mocks.payload = {
			ok: true,
			username: 'owner',
			kodyId: 'private',
			listing: null,
			isPrivate: true,
			viewerIsOwner: viewerCanManage,
			viewerCanManage,
			loggedIn: true,
			repoActions: { publishHref: viewerCanManage ? '/approval' : null },
			ownerPackage: {
				id: 'owned-package',
				hasApp: false,
				pendingCommitKnown: true,
				pendingCommit: 'new-head',
				publishedCommit: 'published-head',
			},
		}
		const result = await loadPackage({
			data: { username: 'owner', kodyId: 'private' },
		})
		expect(result).toMatchObject({
			kind: 'page',
			header: {
				repoActions: { publishHref: viewerCanManage ? '/approval' : null },
			},
		})
	},
)

test.each([undefined, 'settings'] as const)(
	'private package denial is a private403 for %s',
	async (page) => {
		mocks.kind = 'no_access'
		mocks.payload = {
			username: 'owner',
			kodyId: 'private',
			packageName: '@owner/private',
			viewerUsername: 'visitor',
		}
		const result = await loadPackage({
			data: { username: 'owner', kodyId: 'private', ...(page ? { page } : {}) },
		})
		expect(result).toMatchObject({
			kind: 'no_access',
			username: 'owner',
			kodyId: 'private',
			viewerUsername: 'visitor',
		})
		expect(mocks.status).toBe(403)
		expect(mocks.headers.get('Cache-Control')).toBe('private, no-store')
		expect(mocks.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
	},
)

test('community filters are explicit and retain the original authenticated request', async () => {
	const data = {
		query: 'tools',
		sort: 'popular',
		category: 'development',
		limit: 20,
	}
	await loadCommunity({ data })
	expect(mocks.communityRead).toHaveBeenCalledWith(
		expect.anything(),
		mocks.request,
		data,
	)
})
test('profile filters and identity are independent of the RPC URL', async () => {
	await expect(
		loadProfile({ data: { username: 'owner', query: 'private', limit: 10 } }),
	).rejects.toMatchObject({ isNotFound: true })
	expect(mocks.profileRead).toHaveBeenCalledWith(
		expect.anything(),
		mocks.request,
		'owner',
		undefined,
		{ query: 'private', limit: 10 },
	)
})
test('package domain authorization sees the original request', async () => {
	mocks.kind = 'unauthorized'
	await loadPackage({ data: { username: 'owner', kodyId: 'private' } })
	expect(mocks.packageRead).toHaveBeenCalledWith(
		expect.objectContaining({
			request: mocks.request,
			username: 'owner',
			kodyId: 'private',
		}),
	)
})

// The domain payload has already applied target discovery and authorization.
// Reconstructing actions from its display fields loses the follow target.
test.each(['repo', 'package'] as const)(
	'preserves domain actions for a followable %s',
	async (kind) => {
		const repoActions = {
			fork: null,
			publishHref: '/@owner/package/approve-publish?commit=new-head',
			packageAppHref: '/@owner/package/app',
			follow: {
				kind,
				loggedIn: true,
				loginHref: '/login',
				repoHref: '/@owner/package',
				following: true,
			},
		}
		mocks.payload = {
			ok: true,
			username: 'owner',
			kodyId: 'package',
			listing: null,
			ownerPackage: null,
			repoActions,
		}
		const result = await loadPackage({
			data: { username: 'owner', kodyId: 'package' },
		})
		expect(result).toMatchObject({ kind: 'page', header: { repoActions } })
	},
)
