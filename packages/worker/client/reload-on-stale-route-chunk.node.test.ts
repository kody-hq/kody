import { afterEach, expect, test, vi } from 'vitest'
import {
	clearStaleRouteChunkReloadFlag,
	isStaleRouteChunkLoadError,
	onVitePreloadError,
	reloadOnStaleRouteChunk,
	setStaleRouteChunkReloadArmed,
	staleRouteChunkReloadArmMs,
	staleRouteChunkReloadFlag,
} from './reload-on-stale-route-chunk.ts'

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
	setStaleRouteChunkReloadArmed(false)
	restoreGlobals()
	vi.restoreAllMocks()
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

function installWindow(reload: () => void) {
	globalThis.window = {
		location: { reload },
	} as unknown as Window & typeof globalThis
}

const chromium =
	'Failed to fetch dynamically imported module: https://kody.codes/assets/login-CGZThp6w.js'
const firefox =
	'error loading dynamically imported module: https://kody.codes/assets/pricing-CgSDztSN.js'
const webkit = 'Importing a module script failed.'

test('isStaleRouteChunkLoadError matches Chromium, Firefox, and WebKit dynamic import failures', () => {
	expect(isStaleRouteChunkLoadError(new TypeError(chromium))).toBe(true)
	expect(isStaleRouteChunkLoadError(new TypeError(firefox))).toBe(true)
	expect(isStaleRouteChunkLoadError(new TypeError(webkit))).toBe(true)
	expect(isStaleRouteChunkLoadError(`TypeError: ${chromium}`)).toBe(true)
	expect(isStaleRouteChunkLoadError(`TypeError: ${firefox}`)).toBe(true)
	expect(isStaleRouteChunkLoadError(`TypeError: ${webkit}`)).toBe(true)
	expect(
		isStaleRouteChunkLoadError(
			new TypeError(
				'Failed to fetch dynamically imported module: https://kody.codes/assets/syntax-highlight-core-VCFYP6MU.js',
			),
		),
	).toBe(true)
})

test('isStaleRouteChunkLoadError ignores near-miss fetch and TypeError messages', () => {
	const nearMisses = [
		new TypeError('Failed to fetch'),
		new TypeError('Failed to fetch (kody.codes)'),
		new TypeError('Load failed'),
		new TypeError('NetworkError when attempting to fetch resource.'),
		new TypeError('Failed to fetch dynamically imported module'),
		new TypeError('Failed to fetch dynamically imported module:'),
		new TypeError('error loading dynamically imported module'),
		new TypeError(
			'Error loading dynamically imported module: https://kody.codes/assets/login-CGZThp6w.js',
		),
		new TypeError('Importing a module script failed'),
		new TypeError(
			'Importing a module script failed: https://kody.codes/assets/login-CGZThp6w.js',
		),
		new Error(
			`Unable to preload CSS for https://kody.codes/assets/login-CGZThp6w.css`,
		),
		new TypeError('x'),
		'TypeError',
		'Failed to fetch',
	]
	for (const error of nearMisses) {
		expect(isStaleRouteChunkLoadError(error)).toBe(false)
	}
})

test('reloadOnStaleRouteChunk ignores chunk misses outside a route load', () => {
	const store = new Map<string, string>()
	const reload = vi.fn()
	installSessionStorage(store)
	installWindow(reload)
	setStaleRouteChunkReloadArmed(false)

	expect(reloadOnStaleRouteChunk(new TypeError(chromium))).toBe(false)
	expect(reload).not.toHaveBeenCalled()
	expect(store.has(staleRouteChunkReloadFlag)).toBe(false)
})

test('reloadOnStaleRouteChunk disarms itself after the route-load window', () => {
	const store = new Map<string, string>()
	const reload = vi.fn()
	installSessionStorage(store)
	installWindow(reload)
	vi.useFakeTimers()
	try {
		setStaleRouteChunkReloadArmed(true)
		vi.advanceTimersByTime(staleRouteChunkReloadArmMs + 1)

		expect(reloadOnStaleRouteChunk(new TypeError(chromium))).toBe(false)
		expect(reload).not.toHaveBeenCalled()
		expect(store.has(staleRouteChunkReloadFlag)).toBe(false)
	} finally {
		vi.useRealTimers()
	}
})

test('reloadOnStaleRouteChunk never reloads for the optional syntax-highlight chunk', () => {
	const store = new Map<string, string>()
	const reload = vi.fn()
	installSessionStorage(store)
	installWindow(reload)
	setStaleRouteChunkReloadArmed(true)

	const error = new TypeError(
		'Failed to fetch dynamically imported module: https://kody.codes/assets/syntax-highlight-core-AbC123.js',
	)
	expect(isStaleRouteChunkLoadError(error)).toBe(true)
	expect(reloadOnStaleRouteChunk(error)).toBe(false)
	expect(reload).not.toHaveBeenCalled()
	expect(store.has(staleRouteChunkReloadFlag)).toBe(false)
})

test('reloadOnStaleRouteChunk reloads once for a stale route chunk', () => {
	const store = new Map<string, string>()
	const reload = vi.fn()
	installSessionStorage(store)
	installWindow(reload)
	setStaleRouteChunkReloadArmed(true)

	expect(reloadOnStaleRouteChunk(new TypeError(chromium))).toBe(true)
	expect(reload).toHaveBeenCalledTimes(1)
	expect(store.get(staleRouteChunkReloadFlag)).toBe('1')

	expect(reloadOnStaleRouteChunk(new TypeError(firefox))).toBe(false)
	expect(reloadOnStaleRouteChunk(webkit)).toBe(false)
	expect(reload).toHaveBeenCalledTimes(1)
})

test('clearStaleRouteChunkReloadFlag allows a later deploy to recover again', () => {
	const store = new Map<string, string>()
	const reload = vi.fn()
	installSessionStorage(store)
	installWindow(reload)
	setStaleRouteChunkReloadArmed(true)

	expect(reloadOnStaleRouteChunk(new TypeError(chromium))).toBe(true)
	clearStaleRouteChunkReloadFlag()
	expect(store.has(staleRouteChunkReloadFlag)).toBe(false)

	expect(reloadOnStaleRouteChunk(new TypeError(webkit))).toBe(true)
	expect(reload).toHaveBeenCalledTimes(2)
	expect(store.get(staleRouteChunkReloadFlag)).toBe('1')
})

test('clearStaleRouteChunkReloadFlag does not throw when sessionStorage is unavailable', () => {
	Object.defineProperty(globalThis, 'sessionStorage', {
		configurable: true,
		get() {
			throw new DOMException('The operation is insecure.', 'SecurityError')
		},
	})

	expect(() => clearStaleRouteChunkReloadFlag()).not.toThrow()
})

test('reloadOnStaleRouteChunk does not throw or reload when sessionStorage is unavailable', () => {
	const reload = vi.fn()
	installWindow(reload)
	setStaleRouteChunkReloadArmed(true)
	Object.defineProperty(globalThis, 'sessionStorage', {
		configurable: true,
		get() {
			throw new DOMException('The operation is insecure.', 'SecurityError')
		},
	})

	expect(() => reloadOnStaleRouteChunk(new TypeError(chromium))).not.toThrow()
	expect(reload).not.toHaveBeenCalled()
})

test('onVitePreloadError prevents the default only when a reload is triggered', () => {
	const store = new Map<string, string>()
	const reload = vi.fn()
	installSessionStorage(store)
	installWindow(reload)
	setStaleRouteChunkReloadArmed(true)

	const first = new Event('vite:preloadError', { cancelable: true })
	Object.assign(first, { payload: new TypeError(chromium) })
	onVitePreloadError(first)
	expect(first.defaultPrevented).toBe(true)
	expect(reload).toHaveBeenCalledTimes(1)

	const second = new Event('vite:preloadError', { cancelable: true })
	Object.assign(second, { payload: new TypeError(firefox) })
	onVitePreloadError(second)
	expect(second.defaultPrevented).toBe(false)
	expect(reload).toHaveBeenCalledTimes(1)

	const css = new Event('vite:preloadError', { cancelable: true })
	Object.assign(css, {
		payload: new Error(
			'Unable to preload CSS for https://kody.codes/assets/app.css',
		),
	})
	onVitePreloadError(css)
	expect(css.defaultPrevented).toBe(false)
})
