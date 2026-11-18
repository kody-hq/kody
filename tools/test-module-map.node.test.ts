import { expect, test } from 'vitest'
import {
	changedModulePaths,
	encodeTestModuleMapShard,
	gitBlobHash,
	mergeTestModuleMapShards,
	pickTestModuleMap,
	selectObservedTests,
	testModuleMapVitestArgs,
} from './test-module-map.ts'

const hashOf = (path: string) => `hash:${path}`

function shard(
	index: number,
	count: number,
	tests: Record<string, Array<string>>,
) {
	return encodeTestModuleMapShard({
		commit: 'c'.repeat(40),
		tree: 't'.repeat(40),
		shard: { index, count },
		projects: new Map([['node-unit', new Map(Object.entries(tests))]]),
		hashOf,
	})
}

test('gitBlobHash matches git hash-object', () => {
	// `printf 'hello\n' | git hash-object --stdin`
	expect(gitBlobHash(Buffer.from('hello\n'))).toBe(
		'ce013625030ba8dba906f756967f9e9ca394464a',
	)
	expect(gitBlobHash(null)).toBeNull()
})

test('shards round-trip through encode and merge', () => {
	const map = mergeTestModuleMapShards([
		shard(1, 2, { 'a.node.test.ts': ['a.node.test.ts', 'shared.ts', 'a.ts'] }),
		shard(2, 2, { 'b.node.test.ts': ['b.node.test.ts', 'shared.ts'] }),
	])
	expect(map?.projects.get('node-unit')).toEqual(
		new Map([
			['a.node.test.ts', new Set(['a.node.test.ts', 'shared.ts', 'a.ts'])],
			['b.node.test.ts', new Set(['b.node.test.ts', 'shared.ts'])],
		]),
	)
	expect(map?.hashes.get('shared.ts')).toBe('hash:shared.ts')
})

test('a project missing a shard is dropped rather than treated as loading nothing', () => {
	const map = mergeTestModuleMapShards([
		shard(1, 2, { 'a.node.test.ts': ['a.ts'] }),
	])
	expect(map?.projects.has('node-unit')).toBe(false)
})

test('shards from different commits do not merge', () => {
	const other = { ...shard(2, 2, {}), commit: 'd'.repeat(40) }
	expect(mergeTestModuleMapShards([shard(1, 2, {}), other])).toBeNull()
	expect(mergeTestModuleMapShards([])).toBeNull()
})

test('pickTestModuleMap prefers the newest map whose tree is in local history', () => {
	const map = (tree: string, projects: Array<string> = ['node-unit']) => ({
		commit: tree,
		tree,
		hashes: new Map(),
		projects: new Map(projects.map((name) => [name, new Map()])),
	})
	const read: Array<string | null> = []
	function* maps() {
		for (const next of [
			null,
			map('workers-only', ['workers-unit']),
			map('newer-pr-merge'),
			map('main-tree'),
			map('older-main-tree'),
		]) {
			read.push(next?.tree ?? null)
			yield next
		}
	}
	const trees = new Set(['main-tree', 'older-main-tree'])
	expect(pickTestModuleMap(maps(), 'node-unit', trees)).toEqual({
		map: map('main-tree'),
		inHistory: true,
	})
	expect(read).toEqual([null, 'workers-only', 'newer-pr-merge', 'main-tree'])
	expect(pickTestModuleMap(maps(), 'node-unit', new Set())).toEqual({
		map: map('newer-pr-merge'),
		inHistory: false,
	})
	expect(pickTestModuleMap(maps(), 'other', trees)).toBeNull()
})

test('changed modules are those whose content hash differs or that were deleted', () => {
	const hashes = new Map<string, string | null>([
		['same.ts', 'h1'],
		['edited.ts', 'h2'],
		['deleted.ts', 'h3'],
		['generated.ts', null],
	])
	const current = new Map([
		['same.ts', 'h1'],
		['edited.ts', 'h2-new'],
	])
	expect(
		changedModulePaths({ hashes }, (path) => current.get(path) ?? null),
	).toEqual(new Set(['edited.ts', 'deleted.ts']))
})

test('selection runs tests that loaded a changed module and tests the map has not seen', () => {
	const observed = new Map<string, ReadonlySet<string>>([
		[
			'capabilities.node.test.ts',
			new Set(['capabilities.node.test.ts', 'capabilities.ts']),
		],
		[
			'registry.node.test.ts',
			new Set(['registry.node.test.ts', 'registry.ts']),
		],
		['other.node.test.ts', new Set(['other.node.test.ts'])],
	])
	expect(
		selectObservedTests({
			observed,
			testFiles: [
				'capabilities.node.test.ts',
				'registry.node.test.ts',
				'other.node.test.ts',
				'new.node.test.ts',
			],
			changed: new Set(['capabilities.ts']),
		}),
	).toEqual({
		selected: ['capabilities.node.test.ts', 'new.node.test.ts'],
		unmapped: ['new.node.test.ts'],
	})
})

test('a changed test file always runs', () => {
	expect(
		selectObservedTests({
			observed: new Map([['a.node.test.ts', new Set<string>()]]),
			testFiles: ['a.node.test.ts'],
			changed: new Set(['a.node.test.ts']),
		}).selected,
	).toEqual(['a.node.test.ts'])
})

test('map recording args are added only when KODY_TEST_MODULE_MAP_OUT is set', () => {
	expect(testModuleMapVitestArgs({})).toEqual([])
	const args = testModuleMapVitestArgs({
		KODY_TEST_MODULE_MAP_OUT: '/tmp/map.json',
		GITHUB_ACTIONS: 'true',
	})
	expect(args).toContain('--reporter=default')
	expect(args.some((arg) => arg.includes('importDurations'))).toBe(false)
	expect(args).toContain('--reporter=github-actions')
	expect(
		args.some((arg) => arg.endsWith('vitest-module-map-reporter.ts')),
	).toBe(true)
	expect(
		testModuleMapVitestArgs({ KODY_TEST_MODULE_MAP_OUT: '/tmp/map.json' }),
	).not.toContain('--reporter=github-actions')
})
