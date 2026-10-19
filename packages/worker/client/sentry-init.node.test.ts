import { type ErrorEvent, type EventHint } from '@sentry/browser'
import { afterEach, expect, test, vi } from 'vitest'

const init = vi.hoisted(() => vi.fn())
vi.mock('@sentry/browser', () => ({
	init,
	replayIntegration: () => ({}),
	captureException: vi.fn(),
}))

const originalWindow = globalThis.window
const originalSessionStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	'sessionStorage',
)

function restoreGlobals() {
	globalThis.window = originalWindow
	if (originalSessionStorage) {
		Object.defineProperty(globalThis, 'sessionStorage', originalSessionStorage)
	} else {
		Reflect.deleteProperty(globalThis, 'sessionStorage')
	}
}

afterEach(() => {
	restoreGlobals()
	vi.resetModules()
	init.mockClear()
})

function installSessionStorage(store: Map<string, string>) {
	Object.defineProperty(globalThis, 'sessionStorage', {
		configurable: true,
		value: {
			getItem(key: string) {
				return store.has(key) ? store.get(key)! : null
			},
			setItem(key: string, value: string) {
				store.set(key, value)
			},
			removeItem(key: string) {
				store.delete(key)
			},
		},
	})
}

test('beforeSend drops a stale route chunk only when the one-shot reload fires', async () => {
	const store = new Map<string, string>()
	const reload = vi.fn()
	installSessionStorage(store)
	globalThis.window = {
		location: { reload },
	} as unknown as Window & typeof globalThis
	const { initBrowserSentry } = await import('./sentry-init.ts')
	const { resetStaleRouteChunkReloadTriggered, setStaleRouteChunkReloadArmed } =
		await import('./reload-on-stale-route-chunk.ts')
	resetStaleRouteChunkReloadTriggered()
	setStaleRouteChunkReloadArmed(true)
	initBrowserSentry({
		dsn: 'https://key@o1.ingest.sentry.io/2',
		environment: 'production',
		tunnel: '/sentry-tunnel',
	})
	const beforeSend = init.mock.calls[0]?.[0]?.beforeSend as (
		event: ErrorEvent,
		hint: EventHint,
	) => ErrorEvent | null
	const message =
		'Failed to fetch dynamically imported module: https://kody.codes/assets/login-CGZThp6w.js'
	const event = {
		exception: { values: [{ type: 'TypeError', value: message }] },
	} as ErrorEvent
	const hint = { originalException: new TypeError(message) } as EventHint

	expect(beforeSend(event, hint)).toBeNull()
	expect(reload).toHaveBeenCalledTimes(1)

	const followOnMessage =
		"undefined is not an object (evaluating 'e[i??`default`]')"
	const followOnEvent = {
		exception: { values: [{ type: 'TypeError', value: followOnMessage }] },
	} as ErrorEvent
	expect(
		beforeSend(followOnEvent, {
			originalException: new TypeError(followOnMessage),
		} as EventHint),
	).toBeNull()

	expect(beforeSend(event, hint)).toBe(event)
	expect(reload).toHaveBeenCalledTimes(1)

	const fetchEvent = {
		exception: { values: [{ type: 'TypeError', value: 'Failed to fetch' }] },
	} as ErrorEvent
	expect(
		beforeSend(fetchEvent, {
			originalException: new TypeError('Failed to fetch'),
		} as EventHint),
	).toBe(fetchEvent)
})

test('beforeSend keeps the undefined-module TypeError when no reload fired', async () => {
	const { initBrowserSentry } = await import('./sentry-init.ts')
	const { resetStaleRouteChunkReloadTriggered, setStaleRouteChunkReloadArmed } =
		await import('./reload-on-stale-route-chunk.ts')
	resetStaleRouteChunkReloadTriggered()
	setStaleRouteChunkReloadArmed(false)
	initBrowserSentry({
		dsn: 'https://key@o1.ingest.sentry.io/2',
		environment: 'production',
		tunnel: '/sentry-tunnel',
	})
	const beforeSend = init.mock.calls[0]?.[0]?.beforeSend as (
		event: ErrorEvent,
		hint: EventHint,
	) => ErrorEvent | null
	const followOnMessage =
		"undefined is not an object (evaluating 'e[i??`default`]')"
	const followOnEvent = {
		exception: { values: [{ type: 'TypeError', value: followOnMessage }] },
	} as ErrorEvent
	expect(
		beforeSend(followOnEvent, {
			originalException: new TypeError(followOnMessage),
		} as EventHint),
	).toBe(followOnEvent)
})
