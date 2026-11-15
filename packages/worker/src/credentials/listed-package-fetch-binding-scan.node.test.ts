import { expect, test } from 'vitest'
import { scanModulesForGlobalObjectFetch } from './listed-package-fetch-binding-scan.ts'

test('reports reads of fetch through the global object', async () => {
	expect(
		await scanModulesForGlobalObjectFetch({
			'bundle.js': `export const a = () => globalThis.fetch(url)`,
		}),
	).toEqual({ globalReads: true, notParsed: false, aliasShapes: [] })
	expect(
		(
			await scanModulesForGlobalObjectFetch({
				'bundle.js': `export const a = () => self.fetch(url)`,
			})
		).globalReads,
	).toBe(true)
})

test('a plain fetch call or a write is not a read through the global object', async () => {
	expect(
		await scanModulesForGlobalObjectFetch({
			'bundle.js': `globalThis.fetch = polyfill; export const a = () => fetch(url)`,
		}),
	).toEqual({ globalReads: false, notParsed: false, aliasShapes: [] })
})

test('reports a possible alias only when the global object is used as a value and fetch is read from another name', async () => {
	expect(
		await scanModulesForGlobalObjectFetch({
			'bundle.js': `const g = globalThis;\nexport const a = () => g.fetch(url)`,
		}),
	).toEqual({
		globalReads: false,
		notParsed: false,
		aliasShapes: ['= globalThis', 'g.fetch'],
	})
	expect(
		(
			await scanModulesForGlobalObjectFetch({
				'bundle.js': `export const a = (options) => options.fetch(url)`,
			})
		).aliasShapes,
	).toEqual([])
	expect(
		(
			await scanModulesForGlobalObjectFetch({
				'bundle.js': `const g = globalThis;\nexport const a = () => g.setTimeout(f)`,
			})
		).aliasShapes,
	).toEqual([])
})

test('a module that cannot be parsed is reported, not counted as free of such reads', async () => {
	expect(
		await scanModulesForGlobalObjectFetch({
			'bundle.js': `export const a = () => globalThis.fetch(url) }}} (`,
		}),
	).toEqual({ globalReads: true, notParsed: true, aliasShapes: [] })
})
