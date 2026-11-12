import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import type { Reporter, TestModule, Vitest } from 'vitest/node'
import type {} from './vitest-module-map-setup.ts'
import {
	encodeTestModuleMapShard,
	gitBlobHash,
	readFileOrNull,
	testModuleMapOutEnv,
} from './test-module-map.ts'

/** Repo-relative path for a Vitest module ID, or null for deps and virtual modules. */
export function repoModulePath(root: string, moduleId: string) {
	const id = moduleId.replace(/[?#].*$/, '').replaceAll('\\', '/')
	const base = root.replaceAll('\\', '/').replace(/\/$/, '')
	if (!id.startsWith(`${base}/`) || id.includes('/node_modules/')) return null
	return relative(base, id).replaceAll('\\', '/')
}

export default class TestModuleMapReporter implements Reporter {
	#vitest: Vitest | undefined
	#projects = new Map<string, Map<string, Array<string>>>()

	onInit(vitest: Vitest) {
		this.#vitest = vitest
	}

	onTestModuleEnd(testModule: TestModule) {
		const root = this.#vitest?.config.root ?? process.cwd()
		const test = repoModulePath(root, testModule.moduleId)
		if (!test) return
		const loaded = (testModule.meta().kodyEvaluatedModules ?? [])
			.map((id) => repoModulePath(root, id))
			.filter(
				(path): path is string =>
					path !== null && path !== 'tools/vitest-module-map-setup.ts',
			)
		// No record of the test itself means the graph was lost; leave it
		// unmapped so pre-push always runs it.
		if (!loaded.includes(test)) return
		const project = testModule.project.name
		const tests = this.#projects.get(project) ?? new Map()
		tests.set(test, loaded)
		this.#projects.set(project, tests)
	}

	onTestRunEnd() {
		const out = process.env[testModuleMapOutEnv]
		if (!out) return
		const root = this.#vitest?.config.root ?? process.cwd()
		const shard = this.#vitest?.config.shard
		const commit =
			process.env.GITHUB_SHA ??
			execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
		mkdirSync(dirname(out), { recursive: true })
		writeFileSync(
			out,
			JSON.stringify(
				encodeTestModuleMapShard({
					commit,
					shard: shard ? { index: shard.index, count: shard.count } : null,
					projects: this.#projects,
					hashOf: (path) => gitBlobHash(readFileOrNull(join(root, path))),
				}),
			),
		)
	}
}
