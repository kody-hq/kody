import assert from 'node:assert/strict'
import { test } from 'node:test'
import { maxConcurrentRuns } from '../src/execution-context/commands.ts'
import { createPackageGraphCache } from '../src/execution-context/package-graph-cache.ts'
import { type LocalPackageGraph } from '../src/local-package-graph.ts'

const graph = (tag: string) =>
	({
		modules: [{ path: tag }],
		imports: [],
		packageBindings: {},
		packageIdsByImport: {},
	}) as unknown as LocalPackageGraph

const scope = {
	apiUrl: 'https://kody.codes',
	userId: 'u_1',
	orgId: 'o_1',
	code: 'export default () => 1',
}

test('a cached graph is served only to the same requester, org, conversation and code', () => {
	const cache = createPackageGraphCache()
	cache.slot(scope).set(graph('a'))
	assert.deepEqual(cache.slot(scope).get(), graph('a'))
	assert.equal(cache.slot({ ...scope, userId: 'u_2' }).get(), undefined)
	assert.equal(cache.slot({ ...scope, orgId: 'o_2' }).get(), undefined)
	assert.equal(cache.slot({ ...scope, conversationId: 'c_1' }).get(), undefined)
	assert.equal(
		cache.slot({ ...scope, code: 'export default () => 2' }).get(),
		undefined,
	)
	assert.equal(
		cache.slot({ ...scope, apiUrl: 'https://other.example' }).get(),
		undefined,
	)
})

test('entries expire after the TTL', () => {
	let now = 1_000
	const cache = createPackageGraphCache({ ttlMs: 50, now: () => now })
	cache.slot(scope).set(graph('a'))
	now += 49
	assert.ok(cache.slot(scope).get())
	now += 1
	assert.equal(cache.slot(scope).get(), undefined)
	assert.equal(cache.size, 0)
})

test('the cache is bounded and evicts the least recently used graph', () => {
	const cache = createPackageGraphCache({ maxEntries: 2 })
	const code = (n: number) => ({ ...scope, code: `export default () => ${n}` })
	cache.slot(code(1)).set(graph('1'))
	cache.slot(code(2)).set(graph('2'))
	assert.ok(cache.slot(code(1)).get())
	cache.slot(code(3)).set(graph('3'))
	assert.equal(cache.size, 2)
	assert.equal(cache.slot(code(2)).get(), undefined)
	assert.ok(cache.slot(code(1)).get())
	assert.ok(cache.slot(code(3)).get())
})

test('max concurrent runs defaults to 2 and rejects values outside 1..cap', () => {
	assert.equal(maxConcurrentRuns(undefined), 2)
	assert.equal(maxConcurrentRuns(''), 2)
	assert.equal(maxConcurrentRuns('1'), 1)
	assert.equal(maxConcurrentRuns('4'), 4)
	for (const bad of ['0', '-1', '1.5', 'two', '1000']) {
		assert.throws(() => maxConcurrentRuns(bad), /--max-concurrent/)
	}
})
