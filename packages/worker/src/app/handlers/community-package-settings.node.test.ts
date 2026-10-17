import { expect, test, vi } from 'vitest'
import { loadPackage } from '../../../start/server/public-data.ts'
const state = vi.hoisted(() => ({ payload: {} as Record<string, unknown> }))
vi.mock('@tanstack/react-start', async () => ({
	createServerFn: (
		await import('#worker/test-support/start-server-function.ts')
	).createTestServerFn,
	createServerOnlyFn: <T>(fn: T) => fn,
}))
vi.mock('cloudflare:workers', async (importOriginal) => ({
	...(await importOriginal<typeof import('cloudflare:workers')>()),
	env: { COOKIE_SECRET: 'test' },
}))
vi.mock('@tanstack/react-start/server', () => ({
	getRequest: () => new Request('https://example.com/_serverFn/package'),
	setResponseHeader: vi.fn(),
	setResponseStatus: vi.fn(),
}))
vi.mock('#app/env.ts', () => ({ getEnv: (env: unknown) => env }))
vi.mock('#app/auth-session.ts', () => ({ setAuthSessionSecret: vi.fn() }))
vi.mock('#app/session-info.ts', () => ({
	loadSessionInfo: async () => ({ session: null, setCookie: null }),
}))
vi.mock('../../../start/server/document-head.ts', () => ({
	loadDocumentHead: () => ({ title: 'Package settings' }),
}))
vi.mock('#app/community-package-payload.ts', () => ({
	loadCommunityPackagePayload: async () => ({
		kind: 'page',
		data: state.payload,
	}),
	loadCommunityDetailPayload: vi.fn(),
}))

const settings = () =>
	loadPackage({
		data: { username: 'kentcdodds', kodyId: 'packages', page: 'settings' },
	})
test('native package settings require manage permission even when a readable package is present', async () => {
	state.payload = {
		ok: true,
		username: 'kentcdodds',
		kodyId: 'packages',
		ownerPackage: { id: 'pkg-1' },
		viewerIsOwner: false,
		viewerCanManage: false,
	}
	await expect(settings()).rejects.toMatchObject({ isNotFound: true })
	state.payload.viewerIsOwner = true
	await expect(settings()).rejects.toMatchObject({ isNotFound: true })
	state.payload.viewerCanManage = true
	const result = await settings()
	expect(result).toMatchObject({
		kind: 'page',
		data: { ownerPackage: { id: 'pkg-1' }, viewerCanManage: true },
		header: { username: 'kentcdodds', kodyId: 'packages' },
	})
})
test('native settings preserve the listing branch, identifier and private owner visibility', async () => {
	state.payload = {
		ok: true,
		username: 'kentcdodds',
		kodyId: 'packages',
		ownerPackage: { id: 'pkg-1', isPrivate: true },
		viewerIsOwner: true,
		viewerCanManage: true,
		isPrivate: true,
		ownerProfilePublic: false,
		listing: { id: 'listing-1', kodyId: 'packages', defaultBranch: 'develop' },
	}
	expect(await settings()).toMatchObject({
		kind: 'page',
		header: {
			listing: { id: 'listing-1', defaultBranch: 'develop' },
			ownerProfilePublic: false,
			isPrivate: true,
		},
	})
})
