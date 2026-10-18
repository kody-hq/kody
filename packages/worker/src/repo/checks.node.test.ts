import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	createFileSystemSnapshot: vi.fn(),
	createTypescriptLanguageService: vi.fn(),
	buildKodyAppBundle: vi.fn(),
	buildKodyImportableModuleBundle: vi.fn(),
	buildKodyModuleBundle: vi.fn(),
}))

vi.mock('#worker/worker-bundler-modules.ts', () => ({
	importWorkerBundler: async () => ({
		createFileSystemSnapshot: (...args: Array<unknown>) =>
			mockModule.createFileSystemSnapshot(...args),
	}),
	importWorkerBundlerTypescript: async () => ({
		createTypescriptLanguageService: (...args: Array<unknown>) =>
			mockModule.createTypescriptLanguageService(...args),
	}),
}))

vi.mock('#worker/package-runtime/module-graph.ts', () => ({
	buildKodyAppBundle: (...args: Array<unknown>) =>
		mockModule.buildKodyAppBundle(...args),
	buildKodyImportableModuleBundle: (...args: Array<unknown>) =>
		mockModule.buildKodyImportableModuleBundle(...args),
	buildKodyModuleBundle: (...args: Array<unknown>) =>
		mockModule.buildKodyModuleBundle(...args),
}))

import {
	repoChecksSourceMaxFiles,
	repoChecksSourceMaxTotalBytes,
	runRepoChecks,
} from './checks.ts'
import { withRequiredPackageDocs } from './checks-test-docs.ts'
import {
	credentialPatternFindingsNotice,
	credentialPatternNoticeForFiles,
} from './credential-pattern-check.ts'
import {
	createMalformedPackageSkillsFixtureFiles,
	createPackageSkillsFixtureFiles,
} from '#worker/test-support/package-skills-fixture.ts'
import {
	isolatedBundleChunkConcurrency,
	isolatedBundleChunkSize,
} from './isolated-check-phases.ts'
import { maxRepoSourceFileBytes } from './large-file-policy.ts'
import { type PublishPhaseTimings } from './publish-phase-timing.ts'

type RepoCheckRun = Awaited<ReturnType<typeof runRepoChecks>>

const ready = 'export const ready = true\n'
const moduleCheckPath = '.__kody_repo_module_check__.ts'
const bundleContext = {
	env: {} as Env,
	baseUrl: 'https://kody.dev',
	userId: ownerIdFromStored('user-123'),
}

function onceJob(entry: string) {
	return { entry, schedule: { type: 'once', runAt: '2026-04-17T15:00:00Z' } }
}

function manifest(
	id: string,
	kody: Record<string, unknown> = {},
	pkg: Record<string, unknown> = {},
) {
	return JSON.stringify({
		name: `@kody/${id}`,
		exports: { '.': './src/index.ts' },
		...pkg,
		kody: { id, description: `Test package ${id}`, ...kody },
	})
}

function packageFiles(
	packageJson: string,
	sources: Record<string, string> = {},
) {
	return new Map<string, string>([
		['package.json', packageJson],
		['src/index.ts', ready],
		...Object.entries(sources),
	])
}

function findCheck(result: RepoCheckRun, kind: string) {
	return result.results.find((check) => check.kind === kind)
}

function setupDefaultBundleMocks() {
	mockModule.buildKodyAppBundle.mockResolvedValue({
		mainModule: 'dist/app.js',
		modules: {
			'dist/app.js':
				'export default { async fetch() { return new Response("ok") } }',
		},
		dependencies: [],
	})
	mockModule.buildKodyModuleBundle.mockResolvedValue({
		mainModule: 'dist/module.js',
		modules: {
			'dist/module.js': 'export default async function run() { return "ok" }',
		},
		dependencies: [],
	})
	mockModule.buildKodyImportableModuleBundle.mockResolvedValue({
		mainModule: 'dist/importable.js',
		modules: { 'dist/importable.js': 'export const ready = true' },
		dependencies: [],
	})
}

async function runChecks(
	files: Map<string, string>,
	options: Partial<Omit<Parameters<typeof runRepoChecks>[0], 'workspace'>> & {
		getSemanticDiagnostics?: ReturnType<typeof vi.fn>
	} = {},
) {
	const { getSemanticDiagnostics = vi.fn(() => []), ...input } = options
	setupDefaultBundleMocks()
	withRequiredPackageDocs(files)
	let snapshotFiles = new Map<string, string>()
	const snapshot = {
		read: vi.fn((path: string) => snapshotFiles.get(path) ?? null),
	}
	const typeScriptFileSystem = {
		...snapshot,
		write: vi.fn((path: string, content: string) => {
			snapshotFiles.set(path, content)
		}),
	}
	mockModule.createFileSystemSnapshot.mockImplementation(
		async (entries: AsyncIterable<readonly [string, string]>) => {
			snapshotFiles = new Map()
			for await (const [path, content] of entries) {
				snapshotFiles.set(path, content)
			}
			return snapshot
		},
	)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: typeScriptFileSystem,
		languageService: { dispose: vi.fn(), getSemanticDiagnostics },
	})
	const glob = vi.fn(async (_pattern: string) =>
		Array.from(files.keys()).map((path) => ({ path, type: 'file' })),
	)
	const result = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			glob,
		},
		manifestPath: 'package.json',
		sourceRoot: '/',
		...input,
	})
	return {
		result,
		glob,
		snapshot,
		snapshotFiles,
		typeScriptFileSystem,
		getSemanticDiagnostics,
	}
}

function isolatedEnv(
	runIsolatedCheckPhase: (request: Record<string, unknown>) => unknown,
) {
	const kv = {
		put: vi.fn(
			async (_key: string, _value: string, _options: KVNamespacePutOptions) =>
				undefined,
		),
		delete: vi.fn(async (_key: string) => undefined),
	}
	const namespace = {
		idFromName: vi.fn((name: string) => ({ name })),
		get: vi.fn(() => ({ runIsolatedCheckPhase })),
	}
	const env = {
		REPO_SESSION: namespace,
		BUNDLE_ARTIFACTS_KV: kv,
	} as unknown as Env
	return { kv, namespace, env }
}

test('runRepoChecks fails when the source root exceeds publish file-count, total-byte, or per-file caps', async () => {
	const tooManyFiles = packageFiles(manifest('too-many-files'))
	for (let index = 0; index < repoChecksSourceMaxFiles; index += 1) {
		tooManyFiles.set(`generated/file-${index}.txt`, 'x')
	}
	const halfCapChunk = 'x'.repeat(repoChecksSourceMaxTotalBytes / 2)
	const tooManyBytes = packageFiles(manifest('too-many-bytes'), {
		'assets/blob-1.bin': halfCapChunk,
		'assets/blob-2.bin': halfCapChunk,
		'assets/blob-3.bin': halfCapChunk,
	})
	for (const files of [tooManyFiles, tooManyBytes]) {
		const { result } = await runChecks(files)
		expect(result.ok).toBe(false)
		expect(result.sourceFiles).toEqual({})
		expect(result.results).toEqual([
			expect.objectContaining({ kind: 'manifest', ok: true }),
			expect.objectContaining({ kind: 'bundle', ok: false }),
		])
	}

	const { result } = await runChecks(
		packageFiles(manifest('one-large-file'), {
			'assets/dataset.csv': 'x'.repeat(maxRepoSourceFileBytes + 1),
		}),
	)
	expect(result.ok).toBe(false)
	expect(result.sourceFiles).toEqual({})
	const bundleCheck = findCheck(result, 'bundle')
	expect(bundleCheck?.ok).toBe(false)
	expect(bundleCheck?.message).toContain('"assets/dataset.csv"')
	expect(bundleCheck?.message).toContain('per-file limit')
})

test('runRepoChecks keeps non-code source files for publish snapshots while excluding git internals', async () => {
	const files = packageFiles(manifest('static-assets'), {
		'styles/app.css': 'body { color: red; }\n',
		'public/icon.svg': '<svg />\n',
		'.git/config': '[remote "origin"]\n',
	})
	const { result, glob, snapshotFiles } = await runChecks(files)

	expect(glob).toHaveBeenCalledWith('**/*')
	expect(result.sourceFiles).toEqual({
		'package.json': files.get('package.json'),
		'README.md': files.get('README.md'),
		'AGENTS.md': files.get('AGENTS.md'),
		'src/index.ts': files.get('src/index.ts'),
		'styles/app.css': files.get('styles/app.css'),
		'public/icon.svg': files.get('public/icon.svg'),
	})
	expect(snapshotFiles.has('.git/config')).toBe(false)
})

test('runRepoChecks strips repo-session workspace prefixes from package snapshot paths', async () => {
	const { result, snapshot, snapshotFiles, getSemanticDiagnostics } =
		await runChecks(
			new Map([
				[
					'/session/package.json',
					manifest('session-backed-job', {
						jobs: { session: onceJob('/src/job.ts') },
					}),
				],
				['/session/src/index.ts', ready],
				['/session/src/job.ts', 'export default async () => ({ ok: true })\n'],
			]),
			{ manifestPath: '/session/package.json', sourceRoot: '/session/' },
		)

	expect(result.ok).toBe(true)
	expect(Array.from(snapshotFiles.keys())).toEqual([
		'package.json',
		'src/index.ts',
		'src/job.ts',
		'README.md',
		'AGENTS.md',
		'.__kody_repo_runtime__.d.ts',
		moduleCheckPath,
	])
	expect(snapshot.read).toHaveBeenCalledWith('src/index.ts')
	expect(snapshot.read).toHaveBeenCalledWith('src/job.ts')
	expect(snapshot.read).not.toHaveBeenCalledWith('/src/job.ts')
	expect(getSemanticDiagnostics).toHaveBeenCalledWith(moduleCheckPath)
})

test('runRepoChecks records typecheck and bundle phase timings when a collector is provided', async () => {
	const phaseTimings: PublishPhaseTimings = {}
	const { result } = await runChecks(
		packageFiles(manifest('phase-timings'), {
			'src/index.ts': 'export default async () => ({ ok: true })\n',
		}),
		{ phaseTimings },
	)
	expect(result.ok).toBe(true)
	expect(phaseTimings).toEqual({
		checks_typecheck_ms: expect.any(Number),
		checks_bundle_ms: expect.any(Number),
	})
	expect(phaseTimings.checks_typecheck_ms).toBeGreaterThanOrEqual(0)
	expect(phaseTimings.checks_bundle_ms).toBeGreaterThanOrEqual(0)
})

test('runRepoChecks typechecks package-owned jobs (kody:runtime imports, emits, and ESM entrypoints)', async () => {
	const jobs = { runtime: onceJob('src/job.ts') }
	const runtimeGlobals = await runChecks(
		packageFiles(manifest('runtime-globals-job', { jobs }), {
			'src/job.ts': `import { kody, packageStorage } from 'kody:runtime'

export default async (params) => {
  await kody.valueGet({ name: 'projectId' })
  await packageStorage().get('count')
  return params
}
`,
		}),
	)
	expect(runtimeGlobals.result.ok).toBe(true)
	expect(findCheck(runtimeGlobals.result, 'dependencies')?.ok).toBe(true)
	expect(findCheck(runtimeGlobals.result, 'typecheck')?.ok).toBe(true)
	expect(runtimeGlobals.getSemanticDiagnostics).toHaveBeenCalledWith(
		moduleCheckPath,
	)
	const prelude = runtimeGlobals.typeScriptFileSystem.write.mock.calls.find(
		(call) => call[0] === '.__kody_repo_runtime__.d.ts',
	)?.[1]
	expect(prelude).toContain('declare module "kody:runtime"')
	expect(prelude).toContain('export function packageStorage()')
	expect(prelude).not.toMatch(
		/declare const (capabilities|secretHeaders|packageContext|packages|email|workflows|events|packageSecrets)/,
	)
	expect(prelude).not.toMatch(
		/declare function (createAuthenticatedFetch|oauthClientCredentials)/,
	)

	const emitsConstrained = await runChecks(
		packageFiles(
			manifest(
				'discord-gateway',
				{
					jobs,
					emits: {
						'@kentcdodds/discord.message.created': {
							description: 'A Discord message was created.',
						},
					},
				},
				{ name: '@kentcdodds/discord-gateway' },
			),
			{
				'src/job.ts': `import { events } from 'kody:runtime'

export default async () => {
  await events.dispatch({
    topic: '@kentcdodds/discord.message.created',
    idempotencyKey: 'discord:message-create:123',
  })
}
`,
			},
		),
	)
	expect(emitsConstrained.result.ok).toBe(true)
	expect(findCheck(emitsConstrained.result, 'typecheck')?.ok).toBe(true)

	const esmEntrypoint = await runChecks(
		packageFiles(manifest('esm-job', { jobs }), {
			'src/job.ts': 'export default async () => ({ ok: true })\n',
		}),
		{
			getSemanticDiagnostics: vi.fn((path: string) =>
				path === moduleCheckPath
					? []
					: [{ messageText: `unexpected diagnostics for ${path}` }],
			),
		},
	)
	expect(esmEntrypoint.result.ok).toBe(true)
	expect(findCheck(esmEntrypoint.result, 'typecheck')?.ok).toBe(true)
	expect(esmEntrypoint.typeScriptFileSystem.write).toHaveBeenCalledWith(
		moduleCheckPath,
		expect.any(String),
	)
	expect(esmEntrypoint.typeScriptFileSystem.write).not.toHaveBeenCalledWith(
		moduleCheckPath,
		expect.stringContaining('import userEntrypoint from "./src/index"'),
	)
})

test('runRepoChecks validates every persisted package artifact target before publish', async () => {
	const { result, getSemanticDiagnostics } = await runChecks(
		packageFiles(
			manifest(
				'persisted-artifacts',
				{
					jobs: { digest: onceJob('src/job.ts') },
					subscriptions: {
						'email.message.received': { handler: './src/subscription.ts' },
					},
					retrievers: {
						search: {
							export: './search',
							name: 'Search',
							description: 'Searches package records.',
							scopes: ['search'],
						},
					},
				},
				{
					exports: {
						'.': './src/index.ts',
						'./job': './src/job.ts',
						'./search': './src/search.ts',
						'./subscription': './src/subscription.ts',
					},
				},
			),
			{
				'src/index.ts':
					'export default async () => ({ ready: true })\nexport const ready = true\n',
				'src/job.ts': `import { kody, packageStorage } from 'kody:runtime'

export default async (params) => {
  const result = await kody.valueGet({ name: 'projectId' })
  await packageStorage().get('count')
  return { params, result }
}
`,
				'src/search.ts': 'export default async (params) => ({ results: [] })\n',
				'src/subscription.ts': 'export default async (event) => event\n',
			},
		),
		bundleContext,
	)

	expect(result.ok).toBe(true)
	expect(findCheck(result, 'bundle')?.ok).toBe(true)
	expect(findCheck(result, 'typecheck')?.ok).toBe(true)
	for (const bundler of [
		mockModule.buildKodyModuleBundle,
		mockModule.buildKodyImportableModuleBundle,
	]) {
		expect(bundler).toHaveBeenCalledWith(
			expect.objectContaining({ entryPoint: 'src/index.ts' }),
		)
	}
	expect(getSemanticDiagnostics).toHaveBeenCalledWith(moduleCheckPath)
})

test('runRepoChecks typechecks every callable through one language-service program', async () => {
	const getSemanticDiagnostics = vi.fn((path: string) =>
		path === moduleCheckPath ? [] : [],
	)
	const { result, typeScriptFileSystem } = await runChecks(
		packageFiles(
			manifest(
				'multi-callable',
				{
					jobs: {
						alpha: onceJob('src/job-a.ts'),
						beta: onceJob('src/job-b.ts'),
					},
					subscriptions: {
						'email.message.received': { handler: './src/on-email.ts' },
					},
				},
				{
					exports: {
						'.': './src/index.ts',
						'./job-a': './src/job-a.ts',
						'./job-b': './src/job-b.ts',
						'./on-email': './src/on-email.ts',
					},
				},
			),
			{
				'src/index.ts': 'export const ready = true\n',
				'src/job-a.ts': 'export default async () => ({ a: true })\n',
				'src/job-b.ts': 'export default async () => ({ b: true })\n',
				'src/on-email.ts': 'export default async (event) => event\n',
			},
		),
		{ getSemanticDiagnostics },
	)

	expect(result.ok).toBe(true)
	expect(findCheck(result, 'typecheck')?.ok).toBe(true)
	expect(getSemanticDiagnostics).toHaveBeenCalledTimes(1)
	expect(getSemanticDiagnostics).toHaveBeenCalledWith(moduleCheckPath)
	const harnessWrite = typeScriptFileSystem.write.mock.calls.find(
		(call) => call[0] === moduleCheckPath,
	)?.[1]
	expect(harnessWrite).toEqual(
		expect.stringContaining('import userEntrypoint0 from'),
	)
	expect(harnessWrite).toEqual(
		expect.stringContaining('import userEntrypoint1 from'),
	)
	expect(harnessWrite).toEqual(
		expect.stringContaining('import userEntrypoint2 from'),
	)
	expect(harnessWrite).toEqual(
		expect.stringContaining('__kodyTypecheckModule(userEntrypoint0)'),
	)
	expect(harnessWrite).toEqual(
		expect.stringContaining('__kodyTypecheckModule(userEntrypoint2)'),
	)
	// One harness write — not one rewrite per callable target.
	expect(
		typeScriptFileSystem.write.mock.calls.filter(
			(call) => call[0] === moduleCheckPath,
		),
	).toHaveLength(1)
})

test('runRepoChecks still reports unknown globals for package-owned jobs', async () => {
	const { result } = await runChecks(
		packageFiles(
			manifest('broken-job', { jobs: { broken: onceJob('src/job.ts') } }),
			{ 'src/job.ts': 'export default async () => totallyMissingThing()\n' },
		),
		{
			getSemanticDiagnostics: vi.fn((path: string) =>
				path === moduleCheckPath
					? [
							{
								messageText: "Cannot find name 'totallyMissingThing'.",
								start: 0,
								file: {
									getLineAndCharacterOfPosition: () => ({
										line: 1,
										character: 11,
									}),
								},
							},
						]
					: [],
			),
		},
	)

	expect(result.ok).toBe(false)
	expect(findCheck(result, 'typecheck')).toMatchObject({
		ok: false,
		message: expect.stringContaining(`Cannot find name 'totallyMissingThing'.`),
	})
})

test('runRepoChecks injects package tsconfig overlays that allow optional .ts imports', async () => {
	const packageJson = manifest('ts-extension-job', {
		jobs: { tsExtension: onceJob('src/job.ts') },
	})
	const sources = {
		'src/job.ts': 'export { default } from "./helper.ts"\n',
		'src/helper.ts': 'export default async () => ({ ok: true })\n',
	}
	async function readTypecheckFile(
		files: Map<string, string>,
		path: string,
	): Promise<string | null> {
		const { result } = await runChecks(files)
		expect(result.ok).toBe(true)
		const input = mockModule.createTypescriptLanguageService.mock.calls.at(
			-1,
		)?.[0] as { fileSystem: { read(path: string): string | null } }
		return input.fileSystem.read(path)
	}
	const overlay = {
		compilerOptions: { allowImportingTsExtensions: true, noEmit: true },
	}

	const synthetic = packageFiles(packageJson, sources)
	expect(
		JSON.parse((await readTypecheckFile(synthetic, 'tsconfig.json')) ?? 'null'),
	).toMatchObject(overlay)
	expect(
		await readTypecheckFile(synthetic, './.__kody_repo_tsconfig_base__.json'),
	).toBe(null)

	const repoTsconfig = JSON.stringify({
		compilerOptions: {
			module: 'NodeNext',
			moduleResolution: 'NodeNext',
			strict: true,
		},
	})
	const withRepoTsconfig = packageFiles(packageJson, {
		'tsconfig.json': repoTsconfig,
		...sources,
	})
	expect(
		JSON.parse(
			(await readTypecheckFile(withRepoTsconfig, 'tsconfig.json')) ?? 'null',
		),
	).toMatchObject({
		extends: './.__kody_repo_tsconfig_base__.json',
		...overlay,
	})
	expect(
		await readTypecheckFile(
			withRepoTsconfig,
			'.__kody_repo_tsconfig_base__.json',
		),
	).toBe(repoTsconfig)
})

test('runRepoChecks returns typecheck failure for formatDiagnostics path(line,col) form', async () => {
	// @typescript/vfs formatDiagnostics uses `path(line,col): error TS####:`
	// when the diagnostic names the synthetic extends base. That must still
	// become checks_failed, not a thrown internal error (Bugbot on #2877).
	const files = packageFiles(manifest('tsconfig-path-diag'), {
		'tsconfig.json': JSON.stringify({
			compilerOptions: { strict: true, noEmit: true },
		}),
	})
	withRequiredPackageDocs(files)
	setupDefaultBundleMocks()
	let snapshotFiles = new Map<string, string>()
	const snapshot = {
		read: vi.fn((path: string) => snapshotFiles.get(path) ?? null),
	}
	mockModule.createFileSystemSnapshot.mockImplementation(
		async (entries: AsyncIterable<readonly [string, string]>) => {
			snapshotFiles = new Map()
			for await (const [path, content] of entries) {
				snapshotFiles.set(path, content)
			}
			return snapshot
		},
	)
	const message =
		".__kody_repo_tsconfig_base__.json(1,1): error TS5023: Unknown compiler option 'totallyBogusOption'."
	mockModule.createTypescriptLanguageService.mockRejectedValue(
		new Error(message),
	)
	const result = await runRepoChecks({
		workspace: {
			async readFile(path: string) {
				return files.get(path) ?? null
			},
			async glob() {
				return Array.from(files.keys()).map((path) => ({ path, type: 'file' }))
			},
		},
		manifestPath: 'package.json',
		sourceRoot: '/',
	})
	expect(result.ok).toBe(false)
	expect(findCheck(result, 'typecheck')).toEqual({
		kind: 'typecheck',
		ok: false,
		message,
	})
})

test('runRepoChecks validates static kody package dependency declarations and returns manifest failures instead of throwing', async () => {
	// Invalid kody.dependencies (npm-style ranges, non-package specifiers) must
	// return checks_failed, not throw — otherwise MCP observability opens a
	// Sentry platform-bug issue.
	const manifestFailures: Array<[Record<string, string>, string | RegExp]> = [
		[{ '@kentcdodds/helper': '^1.2.3' }, /must be "\*"/],
		[{ '@kentcdodds/helper/run': '*' }, 'must be scoped package names'],
	]
	for (const [dependencies, message] of manifestFailures) {
		const { result } = await runChecks(
			packageFiles(manifest('invalid-deps', { dependencies })),
		)
		expect(result.ok).toBe(false)
		expect(result.manifest).toBeNull()
		expect(result.results).toEqual([
			{
				kind: 'manifest',
				ok: false,
				message:
					typeof message === 'string'
						? expect.stringContaining(message)
						: expect.stringMatching(message),
			},
		])
	}

	const helperImport =
		'import helper from "kody:@kentcdodds/helper/run"\nexport const ready = helper\n'
	const declaresHelper = { dependencies: { '@kentcdodds/helper': '*' } }
	const cases: Array<
		[
			packageJson: string,
			sources: Record<string, string>,
			dependenciesOk: boolean,
			resultOk: boolean,
			message?: string,
		]
	> = [
		[
			manifest('missing-declaration'),
			{ 'src/index.ts': helperImport },
			false,
			false,
			'@kentcdodds/helper',
		],
		[
			manifest('declared-imports', declaresHelper),
			{
				'src/index.ts': [
					helperImport.split('\n')[0]!,
					'import type { HelperConfig } from "kody:@kentcdodds/types/config"',
					'export { type HelperResult } from "kody:@kentcdodds/types/result"',
					'export const ready: HelperConfig | unknown = helper',
				].join('\n'),
			},
			true,
			true,
		],
		[
			manifest(
				'declaration-file-types',
				{},
				{
					exports: {
						'.': { import: './src/index.ts', types: './src/index.d.ts' },
					},
				},
			),
			{
				'src/index.d.ts':
					'import { HelperConfig } from "kody:@kentcdodds/types/config"\nexport type Options = HelperConfig\n',
			},
			true,
			true,
		],
		[
			manifest('mixed-export'),
			{
				'src/index.ts':
					'export { run, type RunInput } from "kody:@kentcdodds/runner"\n',
			},
			false,
			false,
			'missing "@kentcdodds/runner"',
		],
		// Dynamic imports need no declaration (the removed literal form fails lint).
		[
			manifest('dynamic-import'),
			{
				'src/index.ts':
					'export async function load() { return await import("kody:@kentcdodds/dynamic/run") }\n',
			},
			true,
			false,
		],
		[
			manifest('unused-declaration', {
				dependencies: { '@kentcdodds/unused': '*' },
			}),
			{},
			false,
			false,
			'@kentcdodds/unused',
		],
	]
	for (const [packageJson, sources, ok, resultOk, message = ''] of cases) {
		const { result } = await runChecks(packageFiles(packageJson, sources))
		const name = JSON.parse(packageJson).name
		expect([name, result.ok, findCheck(result, 'dependencies')]).toEqual([
			name,
			resultOk,
			expect.objectContaining({
				ok,
				message: expect.stringContaining(message),
			}),
		])
	}
})

test('runRepoChecks bundles npm-dependency packages and surfaces bundler failures as bundle checks', async () => {
	const files = () =>
		packageFiles(
			manifest('npm-deps-package', {}, { dependencies: { marked: '18.0.2' } }),
			{
				'src/index.ts':
					'import { marked } from "marked"\nexport default async () => marked.parse("**ok**")\n',
			},
		)
	const passing = files()
	const { result } = await runChecks(passing, bundleContext)
	expect(result.ok).toBe(true)
	expect(findCheck(result, 'dependencies')?.ok).toBe(true)
	expect(findCheck(result, 'bundle')?.ok).toBe(true)
	expect(mockModule.buildKodyImportableModuleBundle).toHaveBeenCalledWith(
		expect.objectContaining({
			entryPoint: 'src/index.ts',
			userId: ownerIdFromStored('user-123'),
			sourceFiles: {
				'package.json': passing.get('package.json'),
				'README.md': passing.get('README.md'),
				'AGENTS.md': passing.get('AGENTS.md'),
				'src/index.ts': passing.get('src/index.ts'),
			},
		}),
	)
	expect(mockModule.buildKodyModuleBundle).toHaveBeenCalledWith(
		expect.objectContaining({
			entryPoint: 'src/index.ts',
			userId: ownerIdFromStored('user-123'),
		}),
	)

	const failures = [
		[
			mockModule.buildKodyImportableModuleBundle,
			'No such module "marked" imported from bundle.js',
		],
		[
			mockModule.buildKodyImportableModuleBundle,
			'Could not resolve version for marked@18.0.2',
		],
		[
			mockModule.buildKodyModuleBundle,
			'No matching default export for import "default"',
		],
	] as const
	for (const [bundler, error] of failures) {
		bundler.mockRejectedValueOnce(new Error(error))
		const { result } = await runChecks(files(), bundleContext)
		expect(result.ok).toBe(false)
		expect(findCheck(result, 'bundle')).toMatchObject({
			ok: false,
			message: expect.stringContaining(`src/index.ts: ${error}`),
		})
	}
})

test('runRepoChecks rejects object-only packages.invoke with the permanent repair path', async () => {
	const { result } = await runChecks(
		packageFiles(
			manifest('object-invoke', {}, { name: '@kentcdodds/object-invoke' }),
			{
				'src/index.ts': [
					"import { packages } from 'kody:runtime'",
					'export default async function run() {',
					"\treturn packages.invoke({ kodyId: 'github', exportName: './request' })",
					'}',
				].join('\n'),
				'src/asserted.ts': [
					"import { packages } from 'kody:runtime'",
					'export async function run() {',
					"\treturn packages.invoke(({ kodyId: 'github', exportName: './request' }) as unknown as string)",
					'}',
				].join('\n'),
			},
		),
	)

	expect(result.ok).toBe(false)
	const lint = findCheck(result, 'lint')
	expect(lint?.ok).toBe(false)
	expect(lint?.message).toContain('object-only packages.invoke was removed')
	expect(lint?.message).toContain('0006-invoke-object-to-specifier')
	expect(lint?.message).toContain('src/asserted.ts')
})

test('runRepoChecks fails ambient storage imports in package code with the packageStorage() remedy', async () => {
	// Type-only imports, declaration files, and aliased imports of other
	// helpers are not runtime storage accesses; aliased `storage` still is
	// because the imported name identifies the helper.
	const cases: Array<
		[
			id: string,
			sources: Record<string, string>,
			ok: boolean,
			parts: Array<string>,
		]
	> = [
		[
			'ambient-storage',
			{
				'src/index.ts': `import { storage } from 'kody:runtime'

export default async function main() {
	return await storage.get('key')
}
`,
			},
			false,
			['"src/index.ts"', 'packageStorage()', 'not a kody:runtime export'],
		],
		[
			'package-storage',
			{
				'src/index.ts': `import { packageStorage } from 'kody:runtime'

export default async function main() {
	return await packageStorage().get('key')
}
`,
			},
			true,
			[],
		],
		[
			'type-only-storage',
			{
				'src/index.ts': `import type { storage } from 'kody:runtime'
import { kody as client } from 'kody:runtime'

export default async function main() {
	void (null as unknown as typeof storage)
	return await client.valueGet({ name: 'projectId' })
}
`,
				'src/types.d.ts': `import { storage } from 'kody:runtime'
export type Bucket = typeof storage
`,
			},
			true,
			[],
		],
		[
			'aliased-storage',
			{
				'src/index.ts': `import { storage as bucket } from 'kody:runtime'

export default async function main() {
	return await bucket.get('key')
}
`,
			},
			false,
			['packageStorage()'],
		],
	]
	for (const [id, sources, ok, parts] of cases) {
		const { result } = await runChecks(packageFiles(manifest(id), sources))
		const lint = findCheck(result, 'lint')
		expect([id, result.ok, lint?.ok]).toEqual([id, ok, ok])
		for (const part of parts) expect(lint?.message).toContain(part)
	}
})

test('heavy check phases run in throwaway isolates when the env has the bindings', async () => {
	const targets = ['index', 'a', 'b', 'c', 'd', 'e']
	const files = packageFiles(
		manifest(
			'offloaded-package',
			{
				jobs: {
					daily: {
						entry: './src/index.ts',
						schedule: { type: 'interval', every: '1d' },
					},
				},
			},
			{
				exports: Object.fromEntries(
					targets.map((name) => [
						name === 'index' ? '.' : `./${name}`,
						`./src/${name}.ts`,
					]),
				),
			},
		),
		Object.fromEntries(
			targets.map((name) => [
				`src/${name}.ts`,
				`export default async function ${name}() {\n\treturn '${name}'\n}\n`,
			]),
		),
	)

	const phaseRequests: Array<Record<string, unknown>> = []
	let resolveGate: (() => void) | undefined
	const gate = new Promise<void>((resolve) => {
		resolveGate = resolve
	})
	let bundleChunksInFlight = 0
	let maxBundleChunksInFlight = 0
	const runIsolatedCheckPhase = vi.fn(
		async (request: Record<string, unknown>) => {
			phaseRequests.push(request)
			if (request.phase === 'bundle-chunk') {
				bundleChunksInFlight += 1
				maxBundleChunksInFlight = Math.max(
					maxBundleChunksInFlight,
					bundleChunksInFlight,
				)
			}
			await gate
			if (request.phase === 'bundle-chunk') bundleChunksInFlight -= 1
			return request.phase === 'typecheck'
				? { ok: true, message: 'No semantic diagnostics (isolated).' }
				: { ok: true, message: 'chunk ok' }
		},
	)
	const { kv, namespace, env } = isolatedEnv(runIsolatedCheckPhase)
	const resultPromise = runChecks(files, {
		env,
		baseUrl: '/',
		userId: ownerIdFromStored('user-123'),
	})

	// Wait until typecheck and the first bundle chunks have started while the
	// gate is still closed — proves isolated phases fan out, not sequence.
	// Remaining chunks stay queued until a slot frees (concurrency cap).
	let stableCallCount = 0
	let stableTicks = 0
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const callCount = runIsolatedCheckPhase.mock.calls.length
		const phases = phaseRequests.map((request) => request.phase)
		if (
			phases.includes('typecheck') &&
			phases.includes('bundle-chunk') &&
			callCount === stableCallCount
		) {
			stableTicks += 1
			if (stableTicks >= 3) break
		} else {
			stableCallCount = callCount
			stableTicks = 0
		}
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
	const startedPhases = phaseRequests.map((request) => request.phase)
	expect(startedPhases).toContain('typecheck')
	expect(startedPhases).toContain('bundle-chunk')
	const startedPhaseCount = runIsolatedCheckPhase.mock.calls.length
	expect(startedPhaseCount).toBeGreaterThan(1)
	expect(startedPhaseCount).toBeLessThanOrEqual(
		1 + isolatedBundleChunkConcurrency,
	)
	expect(maxBundleChunksInFlight).toBeGreaterThanOrEqual(1)
	resolveGate?.()
	const { result } = await resultPromise
	expect(runIsolatedCheckPhase.mock.calls.length).toBeGreaterThan(
		startedPhaseCount,
	)
	expect(maxBundleChunksInFlight).toBeLessThanOrEqual(
		isolatedBundleChunkConcurrency,
	)

	expect(result.ok).toBe(true)
	// The staged snapshot is written once with a TTL and cleaned up after.
	expect(kv.put).toHaveBeenCalledTimes(1)
	const [stagingKey, stagedBody, stagedOptions] = kv.put.mock.calls[0]!
	expect(stagingKey.startsWith('repo-checks-staging:v1:user-123:')).toBe(true)
	expect(JSON.parse(stagedBody).sourceFiles['src/a.ts']).toContain(
		'export default',
	)
	expect(stagedOptions.expirationTtl).toBeGreaterThan(0)
	expect(kv.delete).toHaveBeenCalledWith(stagingKey)

	// The language service and bundlers never run in this isolate.
	expect(mockModule.createTypescriptLanguageService).not.toHaveBeenCalled()
	expect(mockModule.buildKodyModuleBundle).not.toHaveBeenCalled()

	// One typecheck phase plus ceil(targets / chunk) bundle chunks, each in a
	// fresh throwaway isolate namespaced by the requesting user.
	const typecheckRequests = phaseRequests.filter(
		(request) => request.phase === 'typecheck',
	)
	expect(typecheckRequests).toHaveLength(1)
	expect(typecheckRequests[0]).toMatchObject({
		userId: ownerIdFromStored('user-123'),
	})
	for (const [name] of namespace.idFromName.mock.calls) {
		expect(name).toContain('-user-123-')
	}
	const chunkSizes = phaseRequests
		.filter((request) => request.phase === 'bundle-chunk')
		.map((request) => (request.bundleTargets as Array<unknown>).length)
	const totalTargets = chunkSizes.reduce((sum, size) => sum + size, 0)
	expect(totalTargets).toBeGreaterThanOrEqual(6)
	expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(isolatedBundleChunkSize)
	expect(chunkSizes.length).toBe(
		Math.ceil(totalTargets / isolatedBundleChunkSize),
	)
	expect(
		new Set(namespace.idFromName.mock.calls.map(([name]) => name)).size,
	).toBe(phaseRequests.length)

	expect(findCheck(result, 'bundle')).toMatchObject({
		ok: true,
		message: `Bundled ${totalTargets} package target(s) successfully.`,
	})
	expect(findCheck(result, 'typecheck')).toMatchObject({
		ok: true,
		message: 'No semantic diagnostics (isolated).',
	})
})

test('an isolate reset during a check phase becomes a failed check, not a crash', async () => {
	const { env } = isolatedEnv(async (request) => {
		if (request.phase === 'bundle-chunk') {
			throw new Error(
				"Durable Object's isolate exceeded its memory limit and was reset.",
			)
		}
		return { ok: true, message: 'No semantic diagnostics (isolated).' }
	})
	const { result } = await runChecks(
		packageFiles(manifest('oversized-package'), {
			'src/index.ts': `export default async function main() {\n\treturn 'ok'\n}\n`,
		}),
		{ env, baseUrl: '/', userId: ownerIdFromStored('user-123') },
	)

	expect(result.ok).toBe(false)
	const bundleResult = findCheck(result, 'bundle')
	expect(bundleResult?.ok).toBe(false)
	expect(bundleResult?.message).toContain(
		"exceeded the isolated check runner's",
	)
	expect(bundleResult?.message).toContain(
		'search({ entity: "guide:heavy_work_offload" })',
	)
})

test('runRepoChecks validates package skills and fails publish on malformed SKILL.md frontmatter', async () => {
	const okFiles = packageFiles(
		manifest('skilled', {}, { name: '@kentcdodds/skilled' }),
		createPackageSkillsFixtureFiles(),
	)
	const { result: ok } = await runChecks(okFiles)
	expect(findCheck(ok, 'skills')).toEqual({
		kind: 'skills',
		ok: true,
		message: 'Validated 1 package skill: hello-skill.',
	})
	expect(ok.ok).toBe(true)

	const { result: bad } = await runChecks(
		packageFiles(
			manifest('skilled', {}, { name: '@kentcdodds/skilled' }),
			createMalformedPackageSkillsFixtureFiles(),
		),
	)
	expect(bad.ok).toBe(false)
	expect(findCheck(bad, 'skills')).toEqual({
		kind: 'skills',
		ok: false,
		message: expect.stringContaining('missing frontmatter "name"'),
	})
	expect(findCheck(bad, 'bundle')).toBeUndefined()

	const { result: none } = await runChecks(packageFiles(manifest('plain')))
	expect(findCheck(none, 'skills')).toEqual({
		kind: 'skills',
		ok: true,
		message: 'No package skills found.',
	})
})

test('runRepoChecks can keep credential stamp findings informational', async () => {
	const { result } = await runChecks(
		packageFiles(
			manifest('legacy-credentials-informational', {
				secretMounts: { token: { name: 'TOKEN' } },
			}),
			{
				'src/index.ts': [
					"import { createAuthenticatedFetch } from 'kody:runtime'",
					'export const ready = true',
					'export const run = (name: string) => createAuthenticatedFetch(name)',
				].join('\n'),
			},
		),
		{ enforceCredentialStamp: false },
	)
	expect(result.ok).toBe(true)
	const check = findCheck(result, 'credentials')
	expect(check?.ok).toBe(true)
	expect(check?.message).toMatch(/informational|enforceCredentialStamp=false/)
	expect(check?.message).not.toMatch(/Publish failed/)
	// Soft-fail must keep the conversion-ready guidance, not strip the whole
	// first line when replacing the Publish failed prefix.
	expect(check?.message).toMatch(/conversion-ready/)
	expect(check?.message).toMatch(/secretMounts|computed integration/)
})

test('runRepoChecks hard-fails unstampable credential patterns (issue #3836 phase 1)', async () => {
	const { result } = await runChecks(
		packageFiles(
			manifest('legacy-credentials', {
				secretMounts: { token: { name: 'TOKEN' } },
			}),
			{
				'src/index.ts': [
					"import { createAuthenticatedFetch } from 'kody:runtime'",
					'export const ready = true',
					"export const run = (name: string) => createAuthenticatedFetch(name).then(() => fetch('https://api.example.com', { headers: { Authorization: 'Bearer {{secret:TOKEN}}' } }))",
				].join('\n'),
			},
		),
	)
	expect(result.ok).toBe(false)
	const check = findCheck(result, 'credentials')
	expect(check?.ok).toBe(false)
	expect(check?.message).toMatch(/Credential stamp publish gate/)
	expect(check?.message).toMatch(/secretMounts|computed integration/)
	expect(check?.message).toMatch(/conversion-ready/)
	expect(check?.message).toMatch(/credentials call map/)
	expect(credentialPatternFindingsNotice(result.results)).toBe(check!.message)

	const clean = await runChecks(packageFiles(manifest('clean-credentials')))
	expect(findCheck(clean.result, 'credentials')?.ok).toBe(true)
	expect(findCheck(clean.result, 'credentials')?.message).toMatch(
		/Credential stamp is empty/,
	)
	expect(findCheck(clean.result, 'credentials')?.message).not.toMatch(
		/x-kody-secret-resolution/,
	)
	expect(findCheck(clean.result, 'credentials')?.message).toMatch(
		/Credential stamp publish gate/,
	)

	const { result: docsFailed } = await runChecks(
		packageFiles(manifest('docs-fail-credentials'), {
			'AGENTS.md': '',
			'src/send.ts': "export const h = { a: '{{secret:OLD_KEY}}' }",
		}),
	)
	expect(findCheck(docsFailed, 'credentials')?.ok).toBe(false)
	expect(findCheck(docsFailed, 'credentials')?.message).toMatch(
		/missing a description|OLD_KEY/,
	)

	const { result: migrated } = await runChecks(
		packageFiles(
			manifest('migrated-credentials', {
				credentials: {
					RESEND_API_KEY: {
						kind: 'secret',
						provider: 'resend',
						description: 'Resend API key.',
					},
				},
			}),
			{
				'src/send.ts':
					"export const h = { Authorization: 'Bearer {{secret:RESEND_API_KEY}}' }",
			},
		),
	)
	expect(findCheck(migrated, 'credentials')?.ok).toBe(true)
	expect(findCheck(migrated, 'credentials')?.message).toMatch(
		/Credential stamp keys \(sorted\): RESEND_API_KEY/,
	)
	expect(migrated.ok).toBe(true)
	expect(
		migrated.results.filter(
			(check) =>
				check.kind === 'manifest' &&
				check.message.startsWith('kody.credentials'),
		),
	).toEqual([
		{
			kind: 'manifest',
			ok: true,
			message: [
				'kody.credentials notes (publish is unaffected):',
				'kody.credentials.RESEND_API_KEY: keys usually name their provider; "resend" would read more clearly as the key.',
			].join('\n'),
		},
	])
})

test('runRepoChecks warns when a fetch body is not opted out of secret resolution', async () => {
	const { result } = await runChecks(
		packageFiles(
			manifest('forwarded-body', {
				credentials: {
					github: { kind: 'secret', description: 'GitHub token.' },
				},
			}),
			{
				'src/index.ts': [
					'export const ready = true',
					'export async function post(userReport: string) {',
					"  await fetch('https://api.example.com/issues', {",
					"    method: 'POST',",
					"    headers: { Authorization: 'Bearer {{secret:github}}' },",
					'    body: JSON.stringify({ body: userReport }),',
					'  })',
					'}',
				].join('\n'),
			},
		),
	)
	expect(result.ok).toBe(true)
	const check = findCheck(result, 'credentials')
	expect(check?.ok).toBe(true)
	expect(check?.message).toContain('WARNING:')
	expect(check?.message).toContain('x-kody-secret-resolution: headers-only')
	expect(check?.message).toContain('src/index.ts:')
	expect(check?.message).toContain('does not block publish')

	const optedOut = await runChecks(
		packageFiles(
			manifest('forwarded-body-opt-out', {
				credentials: {
					github: { kind: 'secret', description: 'GitHub token.' },
				},
			}),
			{
				'src/index.ts': [
					'export const ready = true',
					'export async function post(userReport: string) {',
					"  await fetch('https://api.example.com/issues', {",
					"    method: 'POST',",
					'    headers: {',
					"      Authorization: 'Bearer {{secret:github}}',",
					"      'x-kody-secret-resolution': 'headers-only',",
					'    },',
					'    body: JSON.stringify({ body: userReport }),',
					'  })',
					'}',
				].join('\n'),
			},
		),
	)
	expect(optedOut.result.ok).toBe(true)
	expect(findCheck(optedOut.result, 'credentials')?.message).not.toContain(
		'WARNING:',
	)
})

test('runRepoChecks fails plain http credential fetches', async () => {
	const { result } = await runChecks(
		packageFiles(
			manifest('plain-http-credentials', {
				credentials: {
					TOKEN: { kind: 'secret', description: 'API token.' },
				},
			}),
			{
				'src/send.ts': [
					"export const h = { Authorization: 'Bearer {{secret:TOKEN}}' }",
					"export const send = () => fetch('http://api.example.com', { headers: h })",
				].join('\n'),
			},
		),
	)
	expect(result.ok).toBe(false)
	const message = findCheck(result, 'credentials')?.message
	expect(message).toMatch(/plain http/)
	expect(message).toMatch(/https:\/\//)

	const { result: https } = await runChecks(
		packageFiles(
			manifest('https-credentials', {
				credentials: {
					TOKEN: { kind: 'secret', description: 'API token.' },
				},
			}),
			{
				'src/send.ts': "export const h = { a: '{{secret:TOKEN}}' }",
			},
		),
	)
	expect(findCheck(https, 'credentials')?.ok).toBe(true)
	expect(findCheck(https, 'credentials')?.message).not.toContain('plain http')
})

test('runRepoChecks offers optional credential types only for placements one fits', async () => {
	const { result } = await runChecks(
		packageFiles(
			manifest('typed-credentials', {
				credentials: {
					HOOK_PATH: { kind: 'secret', description: 'Hook path.' },
					LOGIN_SECRET: { kind: 'secret', description: 'Login secret.' },
					github: { kind: 'oauth', description: 'GitHub.' },
				},
			}),
			{
				'src/send.ts': [
					"export const hook = () => fetch('https://hooks.example.com/{{secret:HOOK_PATH}}')",
					"export const login = () => fetch('https://api.example.com/login', { method: 'POST', body: JSON.stringify({ password: '{{secret:LOGIN_SECRET}}' }) })",
					"export const gh = () => fetch('https://api.github.com/user', { headers: { Authorization: 'Bearer {{integration-token:github}}' } })",
				].join('\n'),
			},
		),
	)
	expect(result.ok).toBe(true)
	const message = findCheck(result, 'credentials')!.message
	expect(message).toMatch(
		/Credential stamp keys \(sorted\): HOOK_PATH, LOGIN_SECRET, github/,
	)
	// Declared slots of the matching kind are omitted from optional type hints.
	expect(message).not.toContain(
		'Optional, if you want a scoped credential type for these (ADR 0068):',
	)

	const { result: signing } = await runChecks(
		packageFiles(
			manifest('signing-credentials', {
				credentials: {
					APNS_KEY: { kind: 'secret', description: 'APNS key.' },
				},
			}),
			{
				'src/sign.ts': [
					"import { kody } from 'kody:runtime'",
					"export const sign = () => kody.secretJwtSign({ private_key_secret_name: 'APNS_KEY', claims: {} })",
				].join('\n'),
			},
		),
	)
	expect(findCheck(signing, 'credentials')?.ok).toBe(true)

	const { result: unfit } = await runChecks(
		packageFiles(
			manifest('sdk-credentials', {
				credentials: {
					SDK_KEY: { kind: 'secret', description: 'SDK key.' },
				},
			}),
			{
				'src/sdk.ts':
					"export const client = (make: (o: object) => unknown) => make({ apiKey: '{{secret:SDK_KEY}}' })",
			},
		),
	)
	const unfitMessage = findCheck(unfit, 'credentials')?.message ?? ''
	expect(findCheck(unfit, 'credentials')?.ok).toBe(true)
	expect(unfitMessage).toMatch(/Credential stamp keys \(sorted\): SDK_KEY/)
	expect(unfitMessage).not.toContain('Optional, if you want')
})

test('credentialPatternNoticeForFiles reads repo paths under the source root', () => {
	const files = {
		'packages/app/package.json': manifest('rooted', {
			credentials: {
				T: { kind: 'secret', description: 'Token.' },
			},
		}),
		'packages/app/src/send.ts': "export const h = { a: '{{secret:T}}' }",
		'other/src/x.ts': "export const h = { a: '{{secret:X}}' }",
	}
	const notice = credentialPatternNoticeForFiles(files, '/packages/app/')
	expect(notice).toMatch(/Credential stamp/)
	expect(notice).toMatch(/T/)
	expect(notice).not.toContain('other/')
	expect(
		credentialPatternNoticeForFiles({ 'package.json': manifest('clean') }),
	).toMatch(/Credential stamp is empty/)
})
