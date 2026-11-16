import { expect, test } from 'vitest'
import { rewriteGlobalObjectFetchReads } from './rewrite-local-execute-secret-fetch.ts'

const rewrite = (source: string) => rewriteGlobalObjectFetchReads(source, 'F')

test('reads of fetch through the global object use the replacement', async () => {
	expect(await rewrite(`await globalThis.fetch(url)`)).toBe(`await F(url)`)
	expect(await rewrite(`const f = self.fetch`)).toBe(`const f = F`)
	expect(await rewrite(`globalThis['fetch'](url)`)).toBe(`F(url)`)
	expect(
		await rewrite(`new Sdk({ fetch: globalThis.fetch.bind(globalThis) })`),
	).toBe(`new Sdk({ fetch: F.bind(globalThis) })`)
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

test('a global object also used as a value is still read as the global object', async () => {
	expect(
		await rewrite(`const g = globalThis; globalThis.fetch(url); g.fetch(url)`),
	).toBe(`const g = globalThis; F(url); g.fetch(url)`)
	expect(
		await rewrite(`if ('document' in self) self.fetch(url, { self })`),
	).toBe(`if ('document' in self) F(url, { self })`)
})

test('a name is the global object only outside the scopes that declare it', async () => {
	expect(
		await rewrite(
			`function run(self) { return self.fetch(url) }\nexport const a = () => self.fetch(url)`,
		),
	).toBe(
		`function run(self) { return self.fetch(url) }\nexport const a = () => F(url)`,
	)
	expect(
		await rewrite(
			`export const a = () => { var self = this; return self.fetch(url) }\nself.fetch(url)`,
		),
	).toBe(
		`export const a = () => { var self = this; return self.fetch(url) }\nF(url)`,
	)
})

test('a parenthesized global object is still read as the global object', async () => {
	expect(await rewrite(`(globalThis).fetch(url)`)).toBe(`F(url)`)
})

test('an optional read through the global object is still a read', async () => {
	expect(await rewrite(`globalThis?.fetch(url)`)).toBe(`F(url)`)
	expect(await rewrite(`self?.fetch?.(url)`)).toBe(`F?.(url)`)
})
