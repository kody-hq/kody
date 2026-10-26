import { expect, test } from 'vitest'
import {
	createRandomPackageBindingToken,
	packageAppBindingTokenFor,
} from './package-app-binding-token.ts'

const serverKey = 'test-server-key-at-least-32-characters'
const otherServerKey = 'other-server-key-at-least-32-characters'
const noon = new Date('2026-10-23T12:00:00.000Z')

test('the same build key, server key, and UTC day derive the same capability', async () => {
	const first = await packageAppBindingTokenFor({
		secretStoreKey: serverKey,
		cacheKey: 'build-a',
		now: noon,
	})
	const later = await packageAppBindingTokenFor({
		secretStoreKey: serverKey,
		cacheKey: 'build-a',
		now: new Date('2026-10-23T23:59:59.000Z'),
	})
	expect(first).toMatch(/^[0-9a-f]{64}$/)
	expect(later).toBe(first)
})

test('a different build key, server key, or UTC day derives a different capability', async () => {
	const base = await packageAppBindingTokenFor({
		secretStoreKey: serverKey,
		cacheKey: 'build-a',
		now: noon,
	})
	const variants = await Promise.all([
		packageAppBindingTokenFor({
			secretStoreKey: serverKey,
			cacheKey: 'build-b',
			now: noon,
		}),
		packageAppBindingTokenFor({
			secretStoreKey: otherServerKey,
			cacheKey: 'build-a',
			now: noon,
		}),
		packageAppBindingTokenFor({
			secretStoreKey: serverKey,
			cacheKey: 'build-a',
			now: new Date('2026-10-24T00:00:00.000Z'),
		}),
	])
	for (const variant of variants) {
		expect(variant).toMatch(/^[0-9a-f]{64}$/)
		expect(variant).not.toBe(base)
	}
	expect(new Set(variants).size).toBe(variants.length)
})

test('the capability does not contain the build key or server key', async () => {
	const token = await packageAppBindingTokenFor({
		secretStoreKey: serverKey,
		cacheKey: 'build-a',
		now: noon,
	})
	expect(token).not.toContain('build-a')
	expect(token).not.toContain(serverKey)
})

test('without a usable server key the capability is random per build', async () => {
	for (const secretStoreKey of [undefined, '', 'too-short']) {
		const first = await packageAppBindingTokenFor({
			secretStoreKey,
			cacheKey: 'build-a',
			now: noon,
		})
		const second = await packageAppBindingTokenFor({
			secretStoreKey,
			cacheKey: 'build-a',
			now: noon,
		})
		expect(first).toMatch(/^[0-9a-f]{64}$/)
		expect(second).not.toBe(first)
	}
	expect(createRandomPackageBindingToken()).toMatch(/^[0-9a-f]{64}$/)
})
