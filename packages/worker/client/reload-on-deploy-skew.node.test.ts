import { resetIsolateState } from '@kody-internal/shared/isolate-state-test-support.ts'
import { afterEach, expect, test, vi } from 'vitest'
import { setNavigationLoadArmed } from './navigation-load.ts'
import {
	clearDeploySkewReloadFlag,
	createDeploySkewRecoveryError,
	deploySkewReloadFlag,
	isDeploySkewRecoveryError,
	readClientBuildId,
	reloadOnDeploySkew,
} from './reload-on-deploy-skew.ts'

const oldSha = 'a'.repeat(40)
const newSha = 'b'.repeat(40)
const sameSha = 'c'.repeat(40)

const originalWindow = globalThis.window
const originalSessionStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	'sessionStorage',
)
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

function restoreGlobals() {
	globalThis.window = originalWindow
	if (originalSessionStorage) {
		Object.defineProperty(globalThis, 'sessionStorage', originalSessionStorage)
	} else {
		Reflect.deleteProperty(globalThis, 'sessionStorage')
	}
	if (originalDocument) {
		Object.defineProperty(globalThis, 'document', originalDocument)
	} else {
		Reflect.deleteProperty(globalThis, 'document')
	}
	vi.unstubAllGlobals()
	resetIsolateState()
}

afterEach(() => {
	setNavigationLoadArmed(false)
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

function installWindow(reload: () => void, href = 'https://kody.test/blog') {
	const location = { href, reload }
	globalThis.window = { location } as unknown as Window & typeof globalThis
	return location
}

function installBuildMeta(buildId: string | null) {
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		value: {
			querySelector(selector: string) {
				if (selector !== 'meta[name="kody:build"]' || buildId === null)
					return null
				return {
					getAttribute(name: string) {
						return name === 'content' ? buildId : null
					},
				}
			},
		},
	})
}

test('reloadOnDeploySkew reloads a navigation destination once per server build', () => {
	const store = new Map<string, string>()
	const reload = vi.fn()
	installSessionStorage(store)
	const location = installWindow(reload)
	installBuildMeta(oldSha)
	setNavigationLoadArmed(true)

	expect(reloadOnDeploySkew(newSha)).toBe(true)
	expect(reload).toHaveBeenCalledTimes(1)
	expect(store.get(deploySkewReloadFlag)).toBe(
		`${newSha}\nhttps://kody.test/blog`,
	)

	expect(reloadOnDeploySkew(newSha)).toBe(false)
	expect(reload).toHaveBeenCalledTimes(1)

	location.href = 'https://kody.test/docs'
	expect(reloadOnDeploySkew(newSha)).toBe(true)
	expect(reload).toHaveBeenCalledTimes(2)
})

test('reloadOnDeploySkew never reloads outside a navigation load', () => {
	const store = new Map<string, string>()
	const reload = vi.fn()
	installSessionStorage(store)
	installWindow(reload)
	installBuildMeta(oldSha)

	expect(reloadOnDeploySkew(newSha)).toBe(false)
	expect(reload).not.toHaveBeenCalled()
	expect(store.has(deploySkewReloadFlag)).toBe(false)
})

test('reloadOnDeploySkew ignores same-release and missing builds', () => {
	const store = new Map<string, string>()
	const reload = vi.fn()
	installSessionStorage(store)
	installWindow(reload)
	installBuildMeta(sameSha)
	setNavigationLoadArmed(true)

	expect(reloadOnDeploySkew(sameSha)).toBe(false)
	resetIsolateState()
	installBuildMeta(null)
	expect(reloadOnDeploySkew(newSha)).toBe(false)
	expect(reload).not.toHaveBeenCalled()
	expect(store.has(deploySkewReloadFlag)).toBe(false)
})

test('clearDeploySkewReloadFlag allows a later deploy to recover again', () => {
	const store = new Map<string, string>()
	const reload = vi.fn()
	installSessionStorage(store)
	installWindow(reload)
	installBuildMeta(oldSha)
	setNavigationLoadArmed(true)

	expect(reloadOnDeploySkew(newSha)).toBe(true)
	clearDeploySkewReloadFlag()
	expect(store.has(deploySkewReloadFlag)).toBe(false)
	expect(reloadOnDeploySkew(newSha)).toBe(true)
	expect(reload).toHaveBeenCalledTimes(2)
})

test('readClientBuildId caches a resolved meta so SPA head updates cannot hide skew', () => {
	installBuildMeta(oldSha)
	expect(readClientBuildId()).toBe(oldSha)
	installBuildMeta(newSha)
	expect(readClientBuildId()).toBe(oldSha)
	resetIsolateState()
	expect(readClientBuildId()).toBe(newSha)
})

test('readClientBuildId does not permanently cache a missing meta', () => {
	installBuildMeta(null)
	expect(readClientBuildId()).toBeNull()
	installBuildMeta(sameSha)
	expect(readClientBuildId()).toBe(sameSha)
})

test('readClientBuildId prefers the baked build ID over meta', () => {
	vi.stubGlobal('__KODY_APP_COMMIT_SHA__', oldSha)
	installBuildMeta(newSha)
	expect(readClientBuildId()).toBe(oldSha)
})

test('readClientBuildId uses the baked build ID when meta is missing', () => {
	vi.stubGlobal('__KODY_APP_COMMIT_SHA__', oldSha)
	installBuildMeta(null)
	expect(readClientBuildId()).toBe(oldSha)
})

test('readClientBuildId ignores a short baked SHA that cannot match X-Kody-Build', () => {
	vi.stubGlobal('__KODY_APP_COMMIT_SHA__', 'abcdef1')
	installBuildMeta(null)
	expect(readClientBuildId()).toBeNull()
})

test('reloadOnDeploySkew does not throw or reload when sessionStorage is unavailable', () => {
	const reload = vi.fn()
	installWindow(reload)
	installBuildMeta(oldSha)
	setNavigationLoadArmed(true)
	Object.defineProperty(globalThis, 'sessionStorage', {
		configurable: true,
		get() {
			throw new DOMException('The operation is insecure.', 'SecurityError')
		},
	})

	expect(() => reloadOnDeploySkew(newSha)).not.toThrow()
	expect(reload).not.toHaveBeenCalled()
})

test('clearDeploySkewReloadFlag does not throw when sessionStorage is unavailable', () => {
	Object.defineProperty(globalThis, 'sessionStorage', {
		configurable: true,
		get() {
			throw new DOMException('The operation is insecure.', 'SecurityError')
		},
	})
	expect(() => clearDeploySkewReloadFlag()).not.toThrow()
})

test('deploy skew recovery errors are identifiable for Sentry filters', () => {
	const error = createDeploySkewRecoveryError()
	expect(error.name).toBe('DeploySkewRecovery')
	expect(isDeploySkewRecoveryError(error)).toBe(true)
	expect(isDeploySkewRecoveryError(new Error('Deploy skew recovery'))).toBe(
		false,
	)
})
