import { expect, test } from 'vitest'
import {
	getSessionStorageItem,
	setSessionStorageItem,
} from './session-storage-access.ts'

const originalDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	'sessionStorage',
)

function restoreSessionStorage() {
	if (originalDescriptor) {
		Object.defineProperty(globalThis, 'sessionStorage', originalDescriptor)
	} else {
		Reflect.deleteProperty(globalThis, 'sessionStorage')
	}
}

test('sessionStorage helpers tolerate SecurityError and round-trip when storage works', () => {
	try {
		Object.defineProperty(globalThis, 'sessionStorage', {
			configurable: true,
			enumerable: true,
			get() {
				throw new DOMException('The operation is insecure.', 'SecurityError')
			},
		})
		expect(getSessionStorageItem('storage-access-test')).toBeNull()
		expect(setSessionStorageItem('storage-access-test', '{}')).toBe(false)

		const store = new Map<string, string>()
		Object.defineProperty(globalThis, 'sessionStorage', {
			configurable: true,
			enumerable: true,
			value: {
				getItem(key: string) {
					return store.get(key) ?? null
				},
				setItem(key: string, value: string) {
					store.set(key, value)
				},
			},
		})
		expect(setSessionStorageItem('kody:test', '{"a":1}')).toBe(true)
		expect(getSessionStorageItem('kody:test')).toBe('{"a":1}')
	} finally {
		restoreSessionStorage()
	}
})
