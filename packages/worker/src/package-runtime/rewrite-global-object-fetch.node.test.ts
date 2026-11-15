import { expect, test } from 'vitest'
import {
	rewriteGlobalObjectFetchReads,
	sourceReadsFetchThroughGlobalObject,
} from './rewrite-local-execute-secret-fetch.ts'

const rewrite = (source: string) => rewriteGlobalObjectFetchReads(source, 'F')

test('reads of fetch through the global object use the replacement', async () => {
	expect(await rewrite(`await globalThis.fetch(url)`)).toBe(`await F(url)`)
	expect(await rewrite(`const f = self.fetch`)).toBe(`const f = F`)
	expect(await rewrite(`globalThis['fetch'](url)`)).toBe(`F(url)`)
	expect(
		await rewrite(`new Sdk({ fetch: globalThis.fetch.bind(globalThis) })`),
	).toBe(`new Sdk({ fetch: globalThis.fetch.bind(globalThis) })`)
	expect(await rewrite(`new Sdk({ fetch: globalThis.fetch, self: 1 })`)).toBe(
		`new Sdk({ fetch: F, self: 1 })`,
	)
})

test('writes, aliases and local bindings are left alone', async () => {
	for (const source of [
		`globalThis.fetch = polyfill`,
		`({ fetch: globalThis.fetch } = polyfill)`,
		`[globalThis.fetch] = [polyfill]`,
		`for (globalThis.fetch of fetchers) {}`,
		`for (globalThis.fetch in fetchers) {}`,
		`globalThis.fetch ||= polyfill`,
		`delete globalThis.fetch`,
		`const g = globalThis; g.fetch(url)`,
		`function run(self) { return self.fetch(url) }`,
		`const self = makeClient(); self.fetch(url)`,
		`client.self.fetch(url)`,
		`globalThis.fetcher(url)`,
		`this is not ( valid js globalThis.fetch`,
	]) {
		expect(await rewrite(source)).toBe(source)
	}
})

test('a module can read through one global object while aliasing the other', async () => {
	expect(
		await rewrite(`const s = self; globalThis.fetch(url); s.fetch(url)`),
	).toBe(`const s = self; F(url); s.fetch(url)`)
})

test('a parenthesized global object is still read as the global object', async () => {
	expect(await rewrite(`(globalThis).fetch(url)`)).toBe(`F(url)`)
})

test('a read is still found where the module also uses the global object as a value', async () => {
	// One package's alias in an inlined bundle must not hide another's read.
	const source = `const shared = globalThis\nshared.fetch(a)\nglobalThis.fetch(b)`
	expect(await rewrite(source)).toBe(source)
	expect(await sourceReadsFetchThroughGlobalObject(source)).toBe(true)
	expect(
		await sourceReadsFetchThroughGlobalObject(`const shared = globalThis`),
	).toBe(false)
	expect(
		await sourceReadsFetchThroughGlobalObject(`globalThis.fetch = polyfill`),
	).toBe(false)
})
