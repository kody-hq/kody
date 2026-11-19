import { afterAll, afterEach } from 'vitest'

/**
 * Records every module this test file evaluated, including lazy `import()`s
 * that run during tests, on the file's task meta for
 * `vitest-module-map-reporter.ts`. Loaded only when
 * `KODY_TEST_MODULE_MAP_OUT` is set. Snapshots after each test too, since
 * `vi.resetModules()` clears the runner's module graph.
 */

declare module 'vitest' {
	interface TaskMeta {
		kodyEvaluatedModules?: Array<string>
	}
}

type ModuleNode = { file?: string; id: string; evaluated?: boolean }
type WorkerState = {
	evaluatedModules?: { idToModuleMap: Map<string, ModuleNode> }
}

const evaluated = new Set<string>()

function snapshot() {
	const state = (globalThis as { __vitest_worker__?: WorkerState })
		.__vitest_worker__
	for (const node of state?.evaluatedModules?.idToModuleMap.values() ?? []) {
		if (node.evaluated !== false) evaluated.add(node.file || node.id)
	}
}

afterEach(() => snapshot())

// Vitest requires an object pattern for the hook context.
// oxlint-disable-next-line no-empty-pattern
afterAll(({}, suite) => {
	snapshot()
	suite.meta.kodyEvaluatedModules = [...evaluated]
})
