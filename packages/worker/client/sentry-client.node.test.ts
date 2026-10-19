import { afterEach, expect, test, vi } from 'vitest'

const capture = vi.hoisted(() => vi.fn())
vi.mock('./sentry-init.ts', () => ({
	initBrowserSentry: vi.fn(),
	captureBrowserException: capture,
}))

afterEach(() => {
	vi.unstubAllGlobals()
	vi.resetModules()
	capture.mockClear()
})

test('keeps component stacks with their errors before and after Sentry loads', async () => {
	vi.stubGlobal('window', new EventTarget())
	vi.stubGlobal('requestIdleCallback', vi.fn())
	const { initSentryClient, captureClientException } =
		await import('./sentry-client.ts')
	const doc = {
		querySelector: () => ({
			getAttribute: () =>
				JSON.stringify({
					dsn: 'https://key@o1.ingest.sentry.io/2',
					environment: 'production',
					tunnel: '/sentry-tunnel',
				}),
		}),
	} as unknown as Document
	expect(initSentryClient(doc)).toBe(true)
	const early = new Error('early hydration failure')
	const earlyContext = {
		componentStack: '\n    at meta\n    at head',
		documentMeta: [
			{
				name: 'viewport',
				count: 1,
				index: 0,
				differingAttributes: 'content',
			},
		],
	}
	captureClientException(early, earlyContext)
	await vi.waitFor(() =>
		expect(capture).toHaveBeenCalledWith(early, earlyContext),
	)
	const later = new Error('later render failure')
	const laterContext = { componentStack: '\n    at PackagePage' }
	captureClientException(later, laterContext)
	expect(capture).toHaveBeenLastCalledWith(later, laterContext)
	captureClientException(new Error('no React context'))
	expect(capture).toHaveBeenLastCalledWith(expect.any(Error), undefined)
})

test('skips Sentry when a stale route chunk reload fires, then reports the next miss', async () => {
	const store = new Map<string, string>()
	const reload = vi.fn()
	const { resetStaleRouteChunkReloadTriggered, setStaleRouteChunkReloadArmed } =
		await import('./reload-on-stale-route-chunk.ts')
	resetStaleRouteChunkReloadTriggered()
	setStaleRouteChunkReloadArmed(true)
	vi.stubGlobal('sessionStorage', {
		getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
		setItem: (key: string, value: string) => {
			store.set(key, value)
		},
		removeItem: (key: string) => {
			store.delete(key)
		},
	})
	const windowTarget = new EventTarget()
	Object.assign(windowTarget, { location: { reload } })
	vi.stubGlobal('window', windowTarget)
	vi.stubGlobal('requestIdleCallback', vi.fn())
	const { initSentryClient, captureClientException } =
		await import('./sentry-client.ts')
	const doc = {
		querySelector: () => ({
			getAttribute: () =>
				JSON.stringify({
					dsn: 'https://key@o1.ingest.sentry.io/2',
					environment: 'production',
					tunnel: '/sentry-tunnel',
				}),
		}),
	} as unknown as Document
	expect(initSentryClient(doc)).toBe(true)

	const stale = new TypeError(
		'Failed to fetch dynamically imported module: https://kody.codes/assets/login-CGZThp6w.js',
	)
	captureClientException(stale)
	await Promise.resolve()
	expect(reload).toHaveBeenCalledTimes(1)
	expect(capture).not.toHaveBeenCalled()

	const followOn = new TypeError(
		"undefined is not an object (evaluating 'e[i??`default`]')",
	)
	captureClientException(followOn)
	await Promise.resolve()
	expect(capture).not.toHaveBeenCalled()

	const stillMissing = new TypeError(
		'error loading dynamically imported module: https://kody.codes/assets/pricing-CgSDztSN.js',
	)
	captureClientException(stillMissing)
	await vi.waitFor(() =>
		expect(capture).toHaveBeenCalledWith(stillMissing, undefined),
	)
	expect(reload).toHaveBeenCalledTimes(1)

	const highlight = new TypeError(
		'Failed to fetch dynamically imported module: https://kody.codes/assets/syntax-highlight-core-VCFYP6MU.js',
	)
	captureClientException(highlight)
	await Promise.resolve()
	expect(capture).not.toHaveBeenCalledWith(highlight, undefined)
	expect(capture).toHaveBeenCalledTimes(1)

	const network = new TypeError('Failed to fetch')
	captureClientException(network)
	await vi.waitFor(() =>
		expect(capture).toHaveBeenCalledWith(network, undefined),
	)
})

test('reports the undefined-module TypeError when no stale-chunk reload fired', async () => {
	const { resetStaleRouteChunkReloadTriggered, setStaleRouteChunkReloadArmed } =
		await import('./reload-on-stale-route-chunk.ts')
	resetStaleRouteChunkReloadTriggered()
	setStaleRouteChunkReloadArmed(false)
	vi.stubGlobal('window', new EventTarget())
	vi.stubGlobal('requestIdleCallback', vi.fn())
	const { initSentryClient, captureClientException } =
		await import('./sentry-client.ts')
	const doc = {
		querySelector: () => ({
			getAttribute: () =>
				JSON.stringify({
					dsn: 'https://key@o1.ingest.sentry.io/2',
					environment: 'production',
					tunnel: '/sentry-tunnel',
				}),
		}),
	} as unknown as Document
	expect(initSentryClient(doc)).toBe(true)

	const followOn = new TypeError(
		"undefined is not an object (evaluating 'e[i??`default`]')",
	)
	captureClientException(followOn)
	await vi.waitFor(() =>
		expect(capture).toHaveBeenCalledWith(followOn, undefined),
	)
})
