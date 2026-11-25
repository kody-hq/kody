import { resetIsolateState } from '@kody-internal/shared/isolate-state-test-support.ts'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
} from '@tanstack/react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
	armNavigationLoads,
	setNavigationLoadArmed,
} from '#client/navigation-load.ts'
import {
	deploySkewReloadFlag,
	isDeploySkewRecoveryError,
} from '#client/reload-on-deploy-skew.ts'
import { fetchWithDeploySkewCheck } from './deploy-skew-fetch.ts'
import { refreshActiveQueries } from './refresh-active-queries.ts'
import { refreshOnActivation } from './refresh-on-activation.ts'

const bootSha = 'a'.repeat(40)
const deployedSha = 'b'.repeat(40)

let serverBuild = bootSha
let store = new Map<string, string>()
let location = { href: 'https://kody.test/', reload: vi.fn() }

beforeEach(() => {
	serverBuild = bootSha
	store = new Map()
	location = { href: 'https://kody.test/', reload: vi.fn() }
	vi.stubGlobal('__KODY_APP_COMMIT_SHA__', bootSha)
	vi.stubGlobal(
		'fetch',
		vi.fn(
			async () =>
				new Response('payload', { headers: { 'X-Kody-Build': serverBuild } }),
		),
	)
	vi.stubGlobal('sessionStorage', {
		getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
		setItem: (key: string, value: string) => {
			store.set(key, value)
		},
		removeItem: (key: string) => {
			store.delete(key)
		},
	})
	vi.stubGlobal('window', Object.assign(new EventTarget(), { location }))
	resetIsolateState()
})

afterEach(() => {
	setNavigationLoadArmed(false)
	vi.unstubAllGlobals()
	resetIsolateState()
})

function readServer(name: string, method = 'GET') {
	return fetchWithDeploySkewCheck(`/_serverFn/${name}`, { method })
}

function settle() {
	return new Promise((resolve) => setTimeout(resolve, 100))
}

test('same-build responses pass through', async () => {
	await expect(readServer('page')).resolves.toBeInstanceOf(Response)
	expect(location.reload).not.toHaveBeenCalled()
})

test('returning to a tab after a deploy keeps the page, its data, and its input', async () => {
	const client = new QueryClient()
	const observer = new QueryObserver(client, {
		queryKey: ['page'],
		queryFn: async () => {
			await readServer('page')
			return serverBuild
		},
		staleTime: 0,
		meta: { actorKey: 'user:1' },
	})
	const stopObserving = observer.subscribe(() => {})
	const document = Object.assign(new EventTarget(), {
		visibilityState: 'visible',
	})
	const draft = { value: 'unsaved draft' }
	const onError = vi.fn()
	const verifySession = vi.fn(() => readServer('verify'))
	const stop = refreshOnActivation({
		window,
		document,
		refresh: () => refreshActiveQueries(client, 'user:1', verifySession),
		onError,
	})
	try {
		await vi.waitFor(() =>
			expect(observer.getCurrentResult().data).toBe(bootSha),
		)
		serverBuild = deployedSha
		document.dispatchEvent(new Event('visibilitychange'))
		window.dispatchEvent(new Event('focus'))
		await settle()
		expect(verifySession).toHaveBeenCalledTimes(1)
		expect(isDeploySkewRecoveryError(onError.mock.lastCall?.[0])).toBe(true)
		expect(location.reload).not.toHaveBeenCalled()
		expect(store.has(deploySkewReloadFlag)).toBe(false)
		expect(observer.getCurrentResult().data).toBe(bootSha)
		expect(draft.value).toBe('unsaved draft')

		// A stale page query refetch also keeps the rendered data.
		verifySession.mockImplementation(async () => new Response())
		window.dispatchEvent(new Event('focus'))
		await settle()
		expect(location.reload).not.toHaveBeenCalled()
		expect(observer.getCurrentResult().data).toBe(bootSha)
		expect(isDeploySkewRecoveryError(observer.getCurrentResult().error)).toBe(
			true,
		)
	} finally {
		stop()
		stopObserving()
		client.clear()
	}
})

test('a write in a stale tab returns its response instead of reporting failure', async () => {
	serverBuild = deployedSha
	await expect(readServer('save', 'POST')).resolves.toBeInstanceOf(Response)
	await expect(readServer('page')).rejects.toSatisfy(isDeploySkewRecoveryError)
	expect(location.reload).not.toHaveBeenCalled()
})

test('the next navigation after a deploy loads its destination as a fresh document', async () => {
	const root = createRootRoute()
	const index = createRoute({
		getParentRoute: () => root,
		path: '/',
		loader: () => readServer('index'),
	})
	const docs = createRoute({
		getParentRoute: () => root,
		path: '/docs',
		loader: () => readServer('docs'),
	})
	const router = createRouter({
		routeTree: root.addChildren([index, docs]),
		history: createMemoryHistory({ initialEntries: ['/'] }),
		isServer: false,
		origin: 'https://kody.test',
	})
	await router.load()
	const stopArming = armNavigationLoads(router)
	// RouterProvider's Transitioner loads after each history push.
	const stopHistory = router.history.subscribe(({ action }) => {
		location.href = `https://kody.test${router.history.location.pathname}`
		void router.load({ action })
	})
	try {
		serverBuild = deployedSha
		// Same-href reloads (mutations calling router.invalidate) stay in place.
		await router.invalidate()
		expect(location.reload).not.toHaveBeenCalled()

		await router.navigate({ href: '/docs' })
		expect(location.reload).toHaveBeenCalledTimes(1)
		expect(store.get(deploySkewReloadFlag)).toBe(
			`${deployedSha}\nhttps://kody.test/docs`,
		)
	} finally {
		stopHistory()
		stopArming()
	}
})
