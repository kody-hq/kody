import { expect, test } from 'vitest'
import { scanModulesForGlobalObjectFetch } from './listed-package-fetch-binding-scan.ts'

async function scan(source: string) {
	return await scanModulesForGlobalObjectFetch({ 'bundle.js': source })
}

const clean = {
	globalReads: false,
	notParsed: false,
	unboundShapes: [],
	unresolvedShapes: [],
	undefinedGlobalReads: 0,
}

test('reports reads of fetch through the global object that the on-load bind covers', async () => {
	expect(await scan(`export const a = () => globalThis.fetch(url)`)).toEqual({
		...clean,
		globalReads: true,
	})
	expect(await scan(`export const a = () => self.fetch(url)`)).toEqual({
		...clean,
		globalReads: true,
	})
})

test('a read next to other uses of the global object is still covered by the on-load bind', async () => {
	expect(
		await scan(
			`const f = globalThis.fetch.bind(globalThis); export const a = () => f(url)`,
		),
	).toEqual({ ...clean, globalReads: true })
})

test('a plain fetch call or a write is not a read through the global object', async () => {
	expect(
		await scan(
			`globalThis.fetch = polyfill; export const a = () => fetch(url)`,
		),
	).toEqual(clean)
})

test('a fetch option on an injected object is not a read through the global object, even next to uses of the global object', async () => {
	expect(
		await scan(`
			const g = typeof globalThis !== 'undefined' ? globalThis : self
			const timers = { set: g.setTimeout }
			export function create(deps, options, client) {
				return (deps.fetch ?? options.fetch ?? client.fetch ?? fetch)(url)
			}
			export class Router { handle(r) { return this.fetch(r) } }
		`),
	).toEqual(clean)
})

test.each([
	[`const g = globalThis; export const a = () => g.fetch(url)`, 'g.fetch'],
	[
		`var root = typeof self == 'object' && self || Function('return this')();
		 export const a = () => root.fetch(url)`,
		'root.fetch',
	],
	[
		`function getGlobal() { return globalThis }
		 export const a = () => getGlobal().fetch(url)`,
		'getGlobal().fetch',
	],
	[
		`const env = { root: self }
		 export const a = () => env.root.fetch(url)`,
		'env.root.fetch',
	],
	[
		`const env = { root: globalThis }; const { root } = env
		 export const a = () => root.fetch(url)`,
		'root.fetch',
	],
	[
		`const a = { load(scope) { return scope.fetch(url) } }
		 const b = { load(other) { return other.size } }
		 a.load(globalThis)`,
		'scope.fetch',
	],
	[
		`function run(scope) { return scope.fetch(url) }
		 export const a = run.bind(null, globalThis)`,
		'scope.fetch',
	],
	[
		`function getGlobal() { return globalThis }
		 const alias = getGlobal
		 export const a = () => alias().fetch(url)`,
		'alias().fetch',
	],
	[
		`function run(scope) { return scope.fetch(url) }
		 const alias = run
		 alias(globalThis)`,
		'scope.fetch',
	],
	[`(function (scope) { scope.fetch(url) })(globalThis)`, 'scope.fetch'],
	[
		`const { fetch: f } = globalThis; export const a = () => f(url)`,
		'{ fetch } = <global>',
	],
	[
		`export const a = () => Reflect.get(globalThis, 'fetch')(url)`,
		`Reflect.get(<global>, 'fetch')`,
	],
])(
	'reports a read the on-load bind does not cover: %s',
	async (source, shape) => {
		const scanned = await scan(source)
		expect(scanned.unboundShapes).toEqual([shape])
		expect(scanned.unresolvedShapes).toEqual([])
	},
)

test.each([
	[
		`const scope = wrap(globalThis); export const a = () => scope.fetch(url)`,
		['scope.fetch, from a call given <global>'],
	],
	[
		`export const all = [globalThis]; export const a = (deps) => deps.fetch(url)`,
		['deps.fetch', 'ArrayExpression holds <global>'],
	],
	[
		`export const a = (name) => globalThis[name](url) // fetch`,
		['globalThis[<computed>]'],
	],
	[
		`function run() { return this.fetch(url) }
		 export const a = () => run.call(globalThis) `,
		['this.fetch, this set to <global>'],
	],
	[
		`function run() { const scope = this; return scope.fetch(url) }
		 export const a = () => run.call(globalThis) `,
		['this.fetch, this set to <global>'],
	],
])(
	'keeps a read it cannot resolve in the upper bound: %s',
	async (source, shapes) => {
		const scanned = await scan(source)
		expect(scanned.unresolvedShapes).toEqual(shapes)
		expect(scanned.unboundShapes).toEqual([])
	},
)

test('a local or parameter named like the global object is not the global object', async () => {
	expect(
		await scan(`
			export function a(self) { return self.fetch(url) }
			export class Client {
				run() { const self = this; return () => self.fetch(url) }
			}
			register(globalThis)
			export const b = (deps) => deps.fetch(url)
		`),
	).toEqual(clean)
})

test('a name is only an alias where it refers to the aliased variable', async () => {
	expect(
		await scan(`
			function first() { const e = globalThis; return e.setTimeout }
			export function second(e) { return e.fetch(url) }
		`),
	).toEqual(clean)
})

test('a global object passed to a function in the module is followed into it', async () => {
	const scanned = await scan(`
		const helpers = { load(scope, url) { return scope.fetch(url) } }
		export const a = () => helpers.load(globalThis, url)
	`)
	expect(scanned.unboundShapes).toEqual(['scope.fetch'])
})

test('a computed read with a symbol or a known other key is resolved', async () => {
	expect(
		await scan(`
			const key = '__state'
			const marker = Symbol.for('marker')
			const seen = globalThis[marker]
			const state =
				globalThis[key] ?? globalThis[Symbol.for('state')] ?? globalThis['__kv_' + id]
			export const a = () => fetch(url, state)
		`),
	).toEqual(clean)
})

test('window.fetch and global.fetch are reported apart', async () => {
	expect(
		await scan(`export const a = (k) => window.fetch(url, window[k])`),
	).toEqual({
		...clean,
		undefinedGlobalReads: 1,
	})
})

test('a module that cannot be parsed is reported, not counted as free of such reads', async () => {
	expect(
		await scan(`export const a = () => globalThis.fetch(url) }}} (`),
	).toEqual({ ...clean, globalReads: true, notParsed: true })
})
