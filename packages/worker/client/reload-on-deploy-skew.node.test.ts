import { afterEach, expect, test, vi } from 'vitest'
import {
	clearDeploySkewReloadFlag,
	createDeploySkewRecoveryError,
	deploySkewReloadFlag,
	isDeploySkewRecoveryError,
	readClientBuildId,
	reloadOnDeploySkew,
	resetDeploySkewClientBuildCache,
	setBakedClientBuildIdForTests,
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
	resetDeploySkewClientBuildCache()
}

afterEach(() => {
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

function installWindow(assign: (href: string) => void) {
	globalThis.window = {
		location: { assign },
	} as unknown as Window & typeof globalThis
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

test('reloadOnDeploySkew hard-navigates once per server build and href', () => {
	const store = new Map<string, string>()
	const assign = vi.fn()
	installSessionStorage(store)
	installWindow(assign)
	installBuildMeta(oldSha)

	expect(reloadOnDeploySkew({ serverBuild: newSha, href: '/blog' })).toBe(true)
	expect(assign).toHaveBeenCalledTimes(1)
	expect(assign).toHaveBeenCalledWith('/blog')
	expect(store.get(deploySkewReloadFlag)).toBe(`${newSha}\n/blog`)

	expect(reloadOnDeploySkew({ serverBuild: newSha, href: '/blog' })).toBe(false)
	expect(assign).toHaveBeenCalledTimes(1)

	expect(reloadOnDeploySkew({ serverBuild: newSha, href: '/docs' })).toBe(true)
	expect(assign).toHaveBeenCalledTimes(2)
	expect(assign).toHaveBeenLastCalledWith('/docs')
})

test('reloadOnDeploySkew ignores same-release and missing builds', () => {
	const store = new Map<string, string>()
	const assign = vi.fn()
	installSessionStorage(store)
	installWindow(assign)
	installBuildMeta(sameSha)

	expect(reloadOnDeploySkew({ serverBuild: sameSha, href: '/blog' })).toBe(
		false,
	)
	resetDeploySkewClientBuildCache()
	installBuildMeta(null)
	expect(reloadOnDeploySkew({ serverBuild: newSha, href: '/blog' })).toBe(false)
	expect(assign).not.toHaveBeenCalled()
	expect(store.has(deploySkewReloadFlag)).toBe(false)
})

test('clearDeploySkewReloadFlag allows a later deploy to recover again', () => {
	const store = new Map<string, string>()
	const assign = vi.fn()
	installSessionStorage(store)
	installWindow(assign)
	installBuildMeta(oldSha)

	expect(reloadOnDeploySkew({ serverBuild: newSha, href: '/blog' })).toBe(true)
	clearDeploySkewReloadFlag()
	expect(store.has(deploySkewReloadFlag)).toBe(false)
	expect(reloadOnDeploySkew({ serverBuild: newSha, href: '/blog' })).toBe(true)
	expect(assign).toHaveBeenCalledTimes(2)
})

test('readClientBuildId caches a resolved meta so SPA head updates cannot hide skew', () => {
	installBuildMeta(oldSha)
	expect(readClientBuildId()).toBe(oldSha)
	installBuildMeta(newSha)
	expect(readClientBuildId()).toBe(oldSha)
	resetDeploySkewClientBuildCache()
	expect(readClientBuildId()).toBe(newSha)
})

test('readClientBuildId does not permanently cache a missing meta', () => {
	installBuildMeta(null)
	expect(readClientBuildId()).toBeNull()
	installBuildMeta(sameSha)
	expect(readClientBuildId()).toBe(sameSha)
})

test('readClientBuildId prefers the baked build ID over meta', () => {
	setBakedClientBuildIdForTests(oldSha)
	installBuildMeta(newSha)
	expect(readClientBuildId()).toBe(oldSha)
})

test('readClientBuildId uses the baked build ID when meta is missing', () => {
	setBakedClientBuildIdForTests(oldSha)
	installBuildMeta(null)
	expect(readClientBuildId()).toBe(oldSha)
})

test('readClientBuildId ignores a short baked SHA that cannot match X-Kody-Build', () => {
	setBakedClientBuildIdForTests('abcdef1')
	installBuildMeta(null)
	expect(readClientBuildId()).toBeNull()
})

test('reloadOnDeploySkew does not throw or navigate when sessionStorage is unavailable', () => {
	const assign = vi.fn()
	installWindow(assign)
	installBuildMeta(oldSha)
	Object.defineProperty(globalThis, 'sessionStorage', {
		configurable: true,
		get() {
			throw new DOMException('The operation is insecure.', 'SecurityError')
		},
	})

	expect(() =>
		reloadOnDeploySkew({ serverBuild: newSha, href: '/blog' }),
	).not.toThrow()
	expect(assign).not.toHaveBeenCalled()
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
