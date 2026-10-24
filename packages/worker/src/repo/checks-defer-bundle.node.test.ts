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

import { runRepoChecks } from './checks.ts'
import { type PublishPhaseTimings } from './publish-phase-timing.ts'

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
		modules: {
			'dist/importable.js': 'export const ready = true',
		},
		dependencies: [],
	})
}

const digestJob = {
	digest: {
		entry: 'src/job.ts',
		schedule: { type: 'interval', every: '1h' },
	},
}

function packageJson(
	id: string,
	kody: Record<string, unknown>,
	exports: Record<string, string>,
) {
	return JSON.stringify({
		name: `@kody/${id}`,
		exports,
		kody: { id, description: `Test package ${id}`, jobs: digestJob, ...kody },
	})
}

async function runDeferred(files: Map<string, string>, env = {} as Env) {
	setupDefaultBundleMocks()
	const snapshot = { read: vi.fn((path: string) => files.get(path) ?? null) }
	const getSemanticDiagnostics = vi.fn(() => [])
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: { ...snapshot, write: vi.fn() },
		languageService: { dispose: vi.fn(), getSemanticDiagnostics },
	})
	const phaseTimings: PublishPhaseTimings = {}
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
		env,
		baseUrl: 'https://kody.dev',
		userId: ownerIdFromStored('user-123'),
		phaseTimings,
		deferBundleCheckToRebuild: true,
	})
	return { result, phaseTimings, getSemanticDiagnostics }
}

const docs: Array<[string, string]> = [
	['README.md', '# Deferred bundle\n\n## Intent\n\nTest package.\n'],
	['AGENTS.md', '# Agents\n\nSmoke-test the root export.\n'],
]

const deferredBundle = expect.objectContaining({
	kind: 'bundle',
	ok: true,
	message: expect.stringContaining(
		'Bundle validation deferred to published artifact rebuild.',
	),
})

function expectNoBundleBuilds() {
	expect(mockModule.buildKodyAppBundle).not.toHaveBeenCalled()
	expect(mockModule.buildKodyModuleBundle).not.toHaveBeenCalled()
	expect(mockModule.buildKodyImportableModuleBundle).not.toHaveBeenCalled()
}

test('runRepoChecks defers full esbuild when rebuild will validate the same targets', async () => {
	const files = new Map<string, string>([
		[
			'package.json',
			packageJson(
				'deferred-bundle',
				{ app: { entry: 'src/app.ts' } },
				{ '.': './src/index.ts', './helper': './src/helper.ts' },
			),
		],
		...docs,
		['src/index.ts', 'export default async () => ({ ready: true })\n'],
		['src/helper.ts', 'export const ready = true\n'],
		[
			'src/app.ts',
			'export default { async fetch() { return new Response("ok") } }\n',
		],
		['src/job.ts', 'export default async () => ({ ok: true })\n'],
	])
	const deferred = await runDeferred(files)
	expect(deferred.result.ok).toBe(true)
	expect(deferred.result.results).toEqual(
		expect.arrayContaining([
			deferredBundle,
			expect.objectContaining({ kind: 'typecheck', ok: true }),
		]),
	)
	expect(deferred.phaseTimings).toEqual({
		checks_typecheck_ms: expect.any(Number),
	})
	expectNoBundleBuilds()
	expect(deferred.getSemanticDiagnostics).toHaveBeenCalled()

	const missingFiles = new Map(files)
	missingFiles.delete('src/helper.ts')
	const missing = await runDeferred(missingFiles)
	expect(missing.result.ok).toBe(false)
	expect(missing.result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'bundle',
				ok: false,
				message: expect.stringContaining('src/helper.ts'),
			}),
		]),
	)
	expect(missing.phaseTimings.checks_bundle_ms).toBeUndefined()
	expectNoBundleBuilds()
})

test('deferred bundle check still typechecks in an isolate and does not start bundle-chunk isolates', async () => {
	const files = new Map<string, string>([
		[
			'package.json',
			packageJson(
				'deferred-isolated-bundle',
				{},
				{ '.': './src/a.ts', './b': './src/b.ts', './c': './src/c.ts' },
			),
		],
		...docs,
		['src/a.ts', 'export default async () => ({ a: true })\n'],
		['src/b.ts', 'export default async () => ({ b: true })\n'],
		['src/c.ts', 'export default async () => ({ c: true })\n'],
		['src/job.ts', 'export default async () => ({ ok: true })\n'],
	])
	const stub = {
		runIsolatedCheckPhase: vi.fn(async (request: Record<string, unknown>) =>
			request.phase === 'typecheck'
				? { ok: true, message: 'No semantic diagnostics (isolated).' }
				: { ok: true, message: 'chunk ok' },
		),
	}
	const env = {
		REPO_SESSION: {
			idFromName: vi.fn((name: string) => ({ name })),
			get: vi.fn(() => stub),
		},
		BUNDLE_ARTIFACTS_KV: {
			put: vi.fn(async () => undefined),
			delete: vi.fn(async () => undefined),
		},
	} as unknown as Env

	const { result, phaseTimings } = await runDeferred(files, env)

	expect(result.ok).toBe(true)
	expect(
		stub.runIsolatedCheckPhase.mock.calls.map(([request]) => request.phase),
	).toEqual(['typecheck'])
	expectNoBundleBuilds()
	expect(phaseTimings).toEqual({ checks_typecheck_ms: expect.any(Number) })
	expect(result.results).toEqual(
		expect.arrayContaining([
			deferredBundle,
			expect.objectContaining({
				kind: 'typecheck',
				ok: true,
				message: 'No semantic diagnostics (isolated).',
			}),
		]),
	)
})
