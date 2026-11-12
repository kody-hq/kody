import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Which repo modules each test file evaluated in a CI run. Pre-push selects
 * tests from this instead of `vitest related`, whose import graph follows the
 * lazy `import()` edges in `builtin-domains.ts` and so relates a one-line
 * capability change to ~1,000 tests that never load it (#4995, #5062).
 */

export const testModuleMapOutEnv = 'KODY_TEST_MODULE_MAP_OUT'
export const testModuleMapArtifactPrefix = 'test-module-map-'

type Shard = { index: number; count: number }

/**
 * One CI shard's observations. `modules` dedupes paths and `hashes` holds each
 * one's git blob hash, so a later tree finds its changed modules by content
 * without needing the CI commit. `projects` index into `modules`.
 */
export type TestModuleMapShard = {
	version: 1
	commit: string
	shard: Shard | null
	modules: Array<string>
	hashes: Array<string | null>
	projects: Record<string, Record<string, Array<number>>>
}

export type TestModuleMap = {
	commit: string
	hashes: Map<string, string | null>
	projects: Map<string, Map<string, ReadonlySet<string>>>
}

export function readFileOrNull(path: string) {
	try {
		return readFileSync(path)
	} catch {
		return null
	}
}

/** Same as `git hash-object`; null when the file does not exist. */
export function gitBlobHash(content: Buffer | null) {
	if (content === null) return null
	return createHash('sha1')
		.update(`blob ${content.byteLength}\0`)
		.update(content)
		.digest('hex')
}

export function encodeTestModuleMapShard(input: {
	commit: string
	shard: Shard | null
	projects: ReadonlyMap<string, ReadonlyMap<string, Iterable<string>>>
	hashOf: (path: string) => string | null
}): TestModuleMapShard {
	const modules: Array<string> = []
	const indexes = new Map<string, number>()
	const indexOf = (path: string) => {
		let index = indexes.get(path)
		if (index === undefined) {
			index = modules.push(path) - 1
			indexes.set(path, index)
		}
		return index
	}
	const projects: TestModuleMapShard['projects'] = {}
	for (const [project, tests] of input.projects) {
		const encoded: Record<string, Array<number>> = {}
		for (const [test, loaded] of tests) {
			encoded[test] = [...new Set(loaded)].map(indexOf)
		}
		projects[project] = encoded
	}
	return {
		version: 1,
		commit: input.commit,
		shard: input.shard,
		modules,
		hashes: modules.map(input.hashOf),
		projects,
	}
}

/**
 * Merges one run's shards. A project is kept only when every one of its shards
 * is present, so a test is never mistaken for one that loads nothing.
 */
export function mergeTestModuleMapShards(
	shards: ReadonlyArray<TestModuleMapShard>,
): TestModuleMap | null {
	const commit = shards[0]?.commit
	if (!commit || shards.some((shard) => shard.commit !== commit)) return null
	const seen = new Map<string, { count: number; indexes: Set<number> }>()
	const projects = new Map<string, Map<string, ReadonlySet<string>>>()
	const hashes = new Map<string, string | null>()
	for (const shard of shards) {
		if (shard.version !== 1) return null
		shard.modules.forEach((path, index) => {
			hashes.set(path, shard.hashes[index] ?? null)
		})
		for (const [project, tests] of Object.entries(shard.projects)) {
			const count = shard.shard?.count ?? 1
			const entry = seen.get(project) ?? { count, indexes: new Set() }
			if (entry.count !== count) return null
			entry.indexes.add(shard.shard?.index ?? 1)
			seen.set(project, entry)
			const merged = projects.get(project) ?? new Map()
			for (const [test, loaded] of Object.entries(tests)) {
				merged.set(test, new Set(loaded.map((index) => shard.modules[index]!)))
			}
			projects.set(project, merged)
		}
	}
	for (const [project, { count, indexes }] of seen) {
		if (indexes.size !== count) projects.delete(project)
	}
	return { commit, hashes, projects }
}

/** Mapped modules whose content differs from the mapped run (or were deleted). */
export function changedModulePaths(
	map: Pick<TestModuleMap, 'hashes'>,
	currentHash: (path: string) => string | null,
) {
	const changed = new Set<string>()
	for (const [path, hash] of map.hashes) {
		if (currentHash(path) !== hash) changed.add(path)
	}
	return changed
}

/**
 * Tests that loaded a changed module in the mapped run, plus tests the map has
 * not seen (new files). A test that loaded no changed module runs the same
 * code it ran in CI: any new import edge lives in a module it already loaded,
 * and that module changed.
 */
export function selectObservedTests(input: {
	observed: ReadonlyMap<string, ReadonlySet<string>>
	testFiles: ReadonlyArray<string>
	changed: ReadonlySet<string>
}) {
	const selected: Array<string> = []
	const unmapped: Array<string> = []
	for (const file of input.testFiles) {
		const loaded = input.observed.get(file)
		if (!loaded) {
			selected.push(file)
			unmapped.push(file)
			continue
		}
		if (input.changed.has(file)) {
			selected.push(file)
			continue
		}
		for (const path of input.changed) {
			if (loaded.has(path)) {
				selected.push(file)
				break
			}
		}
	}
	return { selected, unmapped }
}

/**
 * Extra Vitest args that record the map when `KODY_TEST_MODULE_MAP_OUT` is set.
 * The config adds `vitest-module-map-setup.ts` to setupFiles in that case.
 */
export function testModuleMapVitestArgs(env: NodeJS.ProcessEnv = process.env) {
	if (!env[testModuleMapOutEnv]) return []
	return [
		'--reporter=default',
		...(env.GITHUB_ACTIONS === 'true' ? ['--reporter=github-actions'] : []),
		`--reporter=${fileURLToPath(new URL('./vitest-module-map-reporter.ts', import.meta.url))}`,
	]
}
