import {
	createProjectGraphAsync,
	hashArray,
	type FileData,
	type NxJsonConfiguration,
	type ProjectGraphProjectNode,
	readJsonFile,
} from 'nx/src/devkit-exports.js'
import {
	filterUsingGlobPatterns,
	getTargetInputs,
} from 'nx/src/hasher/task-hasher.js'
import { expect, test } from 'vitest'

let projectGraph: ReturnType<typeof createProjectGraphAsync> | undefined
async function getProjectNode(project: string) {
	projectGraph ??= createProjectGraphAsync()
	return (await projectGraph).nodes[project] as ProjectGraphProjectNode
}

async function getTargetPatterns(
	project: string,
	target: string,
): Promise<Array<string>> {
	// Nx 23 merges `nx.json` targetDefaults onto project targets during graph
	// construction. `getTargetInputs` no longer re-reads targetDefaults itself,
	// so the contract must use the graph-merged target config.
	const [nxJson, projectNode] = await Promise.all([
		readJsonFile<NxJsonConfiguration>('nx.json'),
		getProjectNode(project),
	])
	return getTargetInputs(nxJson, projectNode, target).selfInputs.filter(
		(input): input is string => typeof input === 'string',
	)
}

async function getWorkerTargetPatterns(target: string): Promise<Array<string>> {
	return getTargetPatterns('worker', target)
}

function expandNamedInputs(
	inputs: ReadonlyArray<unknown>,
	namedInputs: NxJsonConfiguration['namedInputs'],
): Array<unknown> {
	return inputs.flatMap((input) => {
		const named = typeof input === 'string' ? namedInputs?.[input] : undefined
		return named ? expandNamedInputs(named, namedInputs) : [input]
	})
}

async function getDeclaredInputs(project: string, target: string) {
	const [nxJson, projectNode] = await Promise.all([
		readJsonFile<NxJsonConfiguration>('nx.json'),
		getProjectNode(project),
	])
	return expandNamedInputs(
		projectNode.data.targets?.[target]?.inputs ?? [],
		nxJson.namedInputs,
	)
}

async function getWorkerDeclaredInputs(target: string) {
	return getDeclaredInputs('worker', target)
}

function includesEnvInput(inputs: ReadonlyArray<unknown>, envName: string) {
	const marker = `{env:${envName}}`
	return inputs.some((input) => {
		if (input === marker) return true
		return (
			typeof input === 'object' &&
			input !== null &&
			'env' in input &&
			(input as { env?: unknown }).env === envName
		)
	})
}

function includesCiEnv(inputs: ReadonlyArray<unknown>) {
	return includesEnvInput(inputs, 'CI')
}

function hashMatchedInputs(
	patterns: ReadonlyArray<string>,
	files: ReadonlyArray<FileData>,
	projectRoot = 'packages/worker',
): string {
	const workspacePatterns = patterns.map((pattern) =>
		pattern.replace('{workspaceRoot}/', ''),
	)
	const matchedFiles = filterUsingGlobPatterns(
		projectRoot,
		[...files],
		workspacePatterns,
	)
	return hashArray(
		matchedFiles
			.sort((left, right) => left.file.localeCompare(right.file))
			.map(({ file, hash }) => `${file}:${hash}`),
	)
}

// Every file a suite can read at run time must move its cache hash. node-unit
// collects `**/*.node.test.ts` repo-wide and tools tests read docs/ and
// .agents/; the worker bundles docs/guides, jobs-worker and highlight-worker
// into the suites; vite.config.ts and wrangler-env.ts shape the e2e/MCP
// servers. A pattern list that misses any of these replays a stale result.
const cloudflareMock = 'packages/mock-servers/cloudflare/src/index.ts'
const suiteDependencyFiles: Record<string, ReadonlyArray<string>> = {
	test: [
		cloudflareMock,
		'docs/guides/secrets.md',
		'packages/status/x.node.test.ts',
	],
	'test-node': [
		cloudflareMock,
		'docs/guides/secrets.md',
		'docs/contributing/index.md',
		'.agents/skills/ship-pr/SKILL.md',
		'packages/status/x.node.test.ts',
		'packages/backup-control-plane/x.node.test.ts',
		'e2e/x.node.test.ts',
		'.github/workflows/validate.yml',
		'.cursor/rules/x.mdc',
		'.husky/pre-commit',
	],
	'test-workers': [
		cloudflareMock,
		'docs/guides/secrets.md',
		'packages/jobs-worker/src/index.ts',
		'packages/highlight-worker/src/index.ts',
		'packages/shared/src/x.ts',
		'wrangler-env.ts',
	],
	'test-e2e': [
		cloudflareMock,
		'docs/guides/secrets.md',
		'packages/jobs-worker/src/index.ts',
		'packages/highlight-worker/src/index.ts',
		'vite.config.ts',
		'tools/e2e-web-server.ts',
		'e2e/x.spec.ts',
		'playwright.config.ts',
	],
	'test-mcp': [
		cloudflareMock,
		'docs/guides/secrets.md',
		'packages/jobs-worker/src/index.ts',
		'vite.config.ts',
		'wrangler-env.ts',
		'tools/mcp-test-support.ts',
	],
	typecheck: [cloudflareMock],
	build: ['docs/guides/secrets.md', 'vite.config.ts', 'tools/x.ts'],
}

test('every suite cache hash includes the files the suite reads at run time', async () => {
	const ignored: Array<string> = []
	for (const [target, files] of Object.entries(suiteDependencyFiles)) {
		const patterns = await getWorkerTargetPatterns(target)
		for (const dependencyFile of files) {
			const before = hashMatchedInputs(patterns, [
				{ file: dependencyFile, hash: 'before' },
			])
			const after = hashMatchedInputs(patterns, [
				{ file: dependencyFile, hash: 'after' },
			])
			if (after === before) ignored.push(`${target} ${dependencyFile}`)
		}
	}
	expect(ignored).toEqual([])
})

// `tools:typecheck` covers tsconfig-tools-typecheck.json: root TS files,
// tools/, e2e/, .agents/, and whatever they import from packages/. Docs,
// workflows, and editor policy never reach tsc, so they must not invalidate
// the cached result (every docs PR would otherwise re-run it).
const toolsTypecheckInputs = [
	'tools/x.ts',
	'e2e/x.ts',
	'.agents/skills/x/scripts/x.ts',
	'packages/shared/src/x.ts',
	'packages/worker/src/x.ts',
	'vitest.node.config.ts',
	'tsconfig-tools.json',
	'package.json',
]
const toolsTypecheckNonInputs = [
	'docs/contributing/index.md',
	'.github/workflows/validate.yml',
	'.cursor/rules/x.mdc',
]

function hashToolsTypecheckFile(
	patterns: ReadonlyArray<string>,
	file: string,
	hash: string,
) {
	return hashMatchedInputs(patterns, [{ file, hash }], '.')
}

test('tools:typecheck cache hash tracks tsc inputs and ignores docs, workflows, and CI', async () => {
	const patterns = await getTargetPatterns('tools', 'typecheck')
	const changes = (file: string) =>
		hashToolsTypecheckFile(patterns, file, 'after') !==
		hashToolsTypecheckFile(patterns, file, 'before')
	expect(toolsTypecheckInputs.filter((file) => !changes(file))).toEqual([])
	expect(toolsTypecheckNonInputs.filter(changes)).toEqual([])
	expect(includesCiEnv(await getDeclaredInputs('tools', 'typecheck'))).toBe(
		false,
	)
})

test('only suite targets key on CI so typecheck and build artifacts are shared', async () => {
	const keysOnCi: Record<string, boolean> = {}
	for (const target of [
		'test',
		'test-node',
		'test-workers',
		'test-mcp',
		'test-e2e',
		'typecheck',
		'typecheck-src',
		'typecheck-worker-test',
		'typecheck-client-test',
		'build',
	]) {
		keysOnCi[target] = includesCiEnv(await getWorkerDeclaredInputs(target))
	}
	expect(keysOnCi).toEqual({
		test: true,
		'test-node': true,
		'test-workers': true,
		'test-mcp': true,
		'test-e2e': true,
		typecheck: false,
		'typecheck-src': false,
		'typecheck-worker-test': false,
		'typecheck-client-test': false,
		build: false,
	})
})

test.each([
	['test-node', 'NODE_TEST_SHARD'],
	['test-workers', 'WORKERS_TEST_SHARD'],
	['test-e2e', 'E2E_SHARD'],
])(
	'%s hashes its shard separately from local unsharded runs',
	async (target, env) => {
		expect(includesEnvInput(await getWorkerDeclaredInputs(target), env)).toBe(
			true,
		)
	},
)

test('E2E cache restores blob reports for the merge job', async () => {
	const project = await getProjectNode('worker')
	expect(project.data.targets?.['test-e2e']?.outputs).toContain(
		'{workspaceRoot}/blob-report',
	)
})

// KODY_VALIDATE_LOAD only lowers workers-unit maxWorkers; measured on an
// isolated 4-core VM, the same 104 files / 401 tests pass with and without it
// (448s vs 526s). Hashing it would keep validate's test-workers artifact (flag
// on) from matching the same shard with the flag off, so no cached target may
// key on it. Full and sharded Workers runs still have distinct hashes.
test('no cached test target keys on KODY_VALIDATE_LOAD', async () => {
	for (const target of ['test', 'test-workers']) {
		const inputs = await getWorkerDeclaredInputs(target)
		expect(includesEnvInput(inputs, 'KODY_VALIDATE_LOAD')).toBe(false)
	}
})
