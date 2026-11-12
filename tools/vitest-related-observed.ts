import { spawnSync } from 'node:child_process'
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { join, relative, resolve } from 'node:path'
import type { TestSpecification, Vitest } from 'vitest/node'
import { isExecutedDirectly } from './node-runtime.ts'
import {
	changedModulePaths,
	gitBlobHash,
	mergeTestModuleMapShards,
	pickTestModuleMap,
	readFileOrNull,
	selectObservedTests,
	testModuleMapArtifactPrefix,
	type TestModuleMapShard,
} from './test-module-map.ts'

/**
 * Pre-push unit tests for one project, chosen from what each test loaded in a
 * recent CI run (see `test-module-map.ts`). Without a map it falls back to
 * `vitest related`.
 *
 *   node tools/vitest-related-observed.ts --project node-unit <paths...>
 */

const mapRepo = 'kody-hq/kody'
const selectionEnvName = 'KODY_PRE_PUSH_TEST_SELECTION'
const cacheDir = resolve('node_modules/.cache/kody/test-module-map')
// Newest Validate runs to look through for a tree in local history.
const scannedRuns = 10
const localHistoryDepth = 2000
// Setup files load in every test but are not import edges of any test file,
// so `vitest related` misses them.
const setupPathPrefix = 'packages/worker/src/test-support/'

function gh(args: ReadonlyArray<string>, timeout: number) {
	const result = spawnSync('gh', args, {
		encoding: 'utf8',
		timeout,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	return result.status === 0 ? result.stdout : null
}

function readShards(dir: string): Array<TestModuleMapShard> {
	const shards: Array<TestModuleMapShard> = []
	for (const entry of readdirSync(dir, {
		recursive: true,
		withFileTypes: true,
	})) {
		if (entry.isFile() && entry.name.endsWith('.json')) {
			shards.push(
				JSON.parse(readFileSync(join(entry.parentPath, entry.name), 'utf8')),
			)
		}
	}
	return shards
}

function cachedRunFiles() {
	try {
		return readdirSync(cacheDir)
			.filter((name) => /^run-\d+\.json$/.test(name))
			.map((name) => join(cacheDir, name))
			.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
	} catch {
		return []
	}
}

function downloadRunShards(runId: string) {
	const cached = join(cacheDir, `run-${runId}.json`)
	const existing = readFileOrNull(cached)
	if (existing)
		return JSON.parse(existing.toString('utf8')) as Array<TestModuleMapShard>
	const dir = mkdtempSync(join(cacheDir, 'download-'))
	try {
		const ok = gh(
			[
				'run',
				'download',
				runId,
				'-R',
				mapRepo,
				'-p',
				`${testModuleMapArtifactPrefix}*`,
				'-D',
				dir,
			],
			120_000,
		)
		if (ok === null) return null
		const shards = readShards(dir)
		writeFileSync(cached, JSON.stringify(shards))
		for (const stale of cachedRunFiles().slice(scannedRuns)) rmSync(stale)
		return shards
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

function localTrees() {
	const result = spawnSync(
		'git',
		['log', `-${localHistoryDepth}`, '--format=%T', 'HEAD'],
		{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
	)
	return new Set(result.status === 0 ? result.stdout.split('\n') : [])
}

/** Map from recent Validate runs (cached ones when GitHub is unreachable). */
function loadTestModuleMap(project: string) {
	mkdirSync(cacheDir, { recursive: true })
	const runIds = gh(
		[
			'api',
			'-X',
			'GET',
			`repos/${mapRepo}/actions/artifacts`,
			'-f',
			`name=${testModuleMapArtifactPrefix}${project}-1`,
			'-f',
			`per_page=${scannedRuns}`,
			'--jq',
			// Same-repo runs only: a fork could upload a map that skips tests.
			'.artifacts[] | select((.expired | not) and .workflow_run.head_repository_id == .workflow_run.repository_id) | .workflow_run.id',
		],
		20_000,
	)
		?.split('\n')
		.filter(Boolean)
	function* maps() {
		if (runIds) {
			for (const runId of runIds) {
				const shards = downloadRunShards(runId)
				yield shards && mergeTestModuleMapShards(shards)
			}
			return
		}
		for (const file of cachedRunFiles()) {
			yield mergeTestModuleMapShards(JSON.parse(readFileSync(file, 'utf8')))
		}
	}
	return pickTestModuleMap(maps(), project, localTrees())
}

async function runSpecs(
	vitest: Vitest,
	specs: Array<TestSpecification>,
	project: string,
) {
	if (specs.length === 0) {
		console.log(`pre-push: no ${project} tests to run`)
		return 0
	}
	await vitest.standalone()
	await vitest.runTestSpecifications(specs)
	return vitest.state.getCountOfFailedTests() > 0 ||
		vitest.state.getUnhandledErrors().length > 0 ||
		(process.exitCode !== undefined && process.exitCode !== 0)
		? 1
		: 0
}

async function main() {
	const args = process.argv.slice(2)
	const projectIndex = args.indexOf('--project')
	const project = projectIndex === -1 ? undefined : args[projectIndex + 1]
	if (!project) {
		console.error('vitest-related-observed: expected --project <name>')
		return 1
	}
	const root = process.cwd()
	const pushed = args
		.filter((_, index) => index !== projectIndex && index !== projectIndex + 1)
		.map((path) => relative(root, resolve(path)).replaceAll('\\', '/'))
	const forceRelated = process.env[selectionEnvName] === 'related'
	const picked = forceRelated ? null : loadTestModuleMap(project)
	const map = picked?.map
	const observed = map?.projects.get(project)
	const { createVitest } = await import('vitest/node')
	const options = {
		project: [project],
		run: true,
		watch: false,
		passWithNoTests: true,
	}

	if (map && observed) {
		const vitest = await createVitest('test', options)
		try {
			const specs = (await vitest.globTestSpecifications()).filter(
				(spec) => spec.project.name === project,
			)
			const byPath = new Map(
				specs.map((spec) => [
					relative(root, spec.moduleId).replaceAll('\\', '/'),
					spec,
				]),
			)
			const changed = changedModulePaths(map, (path) =>
				gitBlobHash(readFileOrNull(join(root, path))),
			)
			for (const path of pushed) changed.add(path)
			const { selected, unmapped } = selectObservedTests({
				observed,
				testFiles: [...byPath.keys()],
				changed,
			})
			console.log(
				`pre-push: ${selected.length} of ${byPath.size} ${project} test files loaded one of ${changed.size} changed modules since CI run ${map.commit.slice(0, 12)}` +
					(unmapped.length > 0 ? ` (${unmapped.length} new or unmapped)` : '') +
					(picked.inHistory
						? ''
						: '. That run is not in your history, so main changes since your branch point count as changed; rebase to narrow it') +
					`. ${selectionEnvName}=related uses vitest related instead.`,
			)
			return await runSpecs(
				vitest,
				selected.map((path) => byPath.get(path)!),
				project,
			)
		} finally {
			await vitest.close()
		}
	}

	const touchesSetup = pushed.some((path) => path.startsWith(setupPathPrefix))
	console.log(
		touchesSetup
			? `pre-push: no CI test module map for ${project}; running every ${project} test because ${setupPathPrefix} changed`
			: forceRelated
				? `pre-push: ${selectionEnvName}=related; using vitest related`
				: `pre-push: no CI test module map for ${project} (needs an authenticated gh); using vitest related`,
	)
	const vitest = await createVitest('test', {
		...options,
		...(touchesSetup
			? {}
			: { related: pushed.map((path) => resolve(root, path)) }),
	})
	try {
		const specs = touchesSetup
			? (await vitest.globTestSpecifications()).filter(
					(spec) => spec.project.name === project,
				)
			: await vitest.getRelevantTestSpecifications()
		return await runSpecs(vitest, specs, project)
	} finally {
		await vitest.close()
	}
}

if (isExecutedDirectly(import.meta.url)) {
	process.exitCode = await main()
}
