import { createRequire } from 'node:module'
import { describe, expect, test } from 'vitest'

const require = createRequire(import.meta.url)

/**
 * Guards the Zod Worker startup patch (`patches/zod+4.6.6.patch`).
 *
 * 1. Locales barrel stays English-only. Without that trim, `import { z } from
 *    'zod'` pulls ~50 locale modules into every Worker main (~190 KB).
 * 2. Classic / mini / core barrels omit `compile` (and related exports) plus
 *    unused `fromJSONSchema` / `deepPartial`. Zod 4.6 re-exports `compile` onto
 *    the `z` namespace via `export * as core`, which Wrangler cannot tree-shake
 *    (~32 KB compile.js plus from-json-schema). See
 *    docs/contributing/architecture/startup-budget.md.
 */
describe('zod worker startup barrel patch', () => {
	test('exposes only the English locale from the locales index', async () => {
		const locales = await import('zod/v4/locales/index.js')
		expect(Object.keys(locales).sort()).toEqual(['en'])
		expect(typeof locales.en).toBe('function')

		const cjsLocales = require('zod/v4/locales') as { en?: unknown }
		expect(Object.keys(cjsLocales).sort()).toEqual(['en'])
		expect(typeof cjsLocales.en).toBe('function')
	})

	test('classic zod entry still validates with English messages', async () => {
		const { z } = await import('zod')
		const result = z.string().safeParse(1)
		expect(result.success).toBe(false)
		if (result.success) return
		expect(result.error.issues[0]?.message).toMatch(/string/i)
	})

	test('classic and mini barrels omit compile and fromJSONSchema', async () => {
		const classic = await import('zod')
		const mini = await import('zod/mini')
		const classicKeys = Object.keys(classic.z)
		const miniKeys = Object.keys(mini)
		for (const key of [
			'compile',
			'withParser',
			'ZodCompileAsyncError',
			'ZodCompileUnsupportedError',
			'INVALID',
			'fromJSONSchema',
			'deepPartial',
		]) {
			expect(classicKeys).not.toContain(key)
			expect(miniKeys).not.toContain(key)
		}
		expect(typeof classic.z.toJSONSchema).toBe('function')
		expect(typeof mini.toJSONSchema).toBe('function')
	})

	test('classic and mini declaration barrels omit the stripped exports', async () => {
		const { readFile } = await import('node:fs/promises')
		const classicDts = await readFile(
			new URL('../node_modules/zod/v4/classic/external.d.ts', import.meta.url),
			'utf8',
		)
		const miniDts = await readFile(
			new URL('../node_modules/zod/v4/mini/external.d.ts', import.meta.url),
			'utf8',
		)
		const coreDts = await readFile(
			new URL('../node_modules/zod/v4/core/index.d.ts', import.meta.url),
			'utf8',
		)
		for (const snippet of [
			'compile',
			'withParser',
			'fromJSONSchema',
			'deepPartial',
			'INVALID',
			'CompileOptions',
		]) {
			expect(classicDts).not.toMatch(new RegExp(`\\b${snippet}\\b`))
			expect(miniDts).not.toMatch(new RegExp(`\\b${snippet}\\b`))
		}
		expect(coreDts).not.toContain('./compile.js')
	})
})
