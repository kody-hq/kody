import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	createFileSystemSnapshot: vi.fn(),
	createTypescriptLanguageService: vi.fn(),
	buildKodyAppBundle: vi.fn(),
	buildKodyAppClientBundle: vi.fn(),
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
	buildKodyAppClientBundle: (...args: Array<unknown>) =>
		mockModule.buildKodyAppClientBundle(...args),
	buildKodyImportableModuleBundle: (...args: Array<unknown>) =>
		mockModule.buildKodyImportableModuleBundle(...args),
	buildKodyModuleBundle: (...args: Array<unknown>) =>
		mockModule.buildKodyModuleBundle(...args),
}))

import { runRepoChecks } from './checks.ts'
import { withRequiredPackageDocs } from './checks-test-docs.ts'

function createAppManifest(app: Record<string, unknown>) {
	return JSON.stringify({
		name: '@kody/client-app',
		exports: { '.': './src/index.ts' },
		kody: {
			id: 'client-app',
			description: 'App with a platform-built browser client',
			app,
		},
	})
}

function setupBundleMocks() {
	mockModule.buildKodyAppBundle.mockReset()
	mockModule.buildKodyAppClientBundle.mockReset()
	mockModule.buildKodyModuleBundle.mockReset()
	mockModule.buildKodyImportableModuleBundle.mockReset()
	mockModule.buildKodyAppBundle.mockResolvedValue({
		mainModule: 'dist/app.js',
		modules: { 'dist/app.js': 'export default { fetch() {} }' },
		dependencies: [],
	})
	mockModule.buildKodyAppClientBundle.mockResolvedValue({
		mainModule: 'client.0123456789abcdef.js',
		modules: { 'client.0123456789abcdef.js': 'console.log("hi")' },
		dependencies: [],
	})
	mockModule.buildKodyModuleBundle.mockResolvedValue({
		mainModule: 'dist/module.js',
		modules: { 'dist/module.js': 'export default async () => "ok"' },
		dependencies: [],
	})
	mockModule.buildKodyImportableModuleBundle.mockResolvedValue({
		mainModule: 'dist/importable.js',
		modules: { 'dist/importable.js': 'export const ready = true' },
		dependencies: [],
	})
}

const baseFiles: Array<[string, string]> = [
	['src/index.ts', 'export default async () => ({ ready: true })\n'],
	[
		'src/app.ts',
		'export default { async fetch() { return new Response("ok") } }\n',
	],
	['src/client.ts', 'document.body.textContent = "hi"\n'],
	['public/styles.css', 'body { color: red }\n'],
]

async function runChecks(
	app: Record<string, unknown>,
	extraFiles: Array<[string, string]> = [],
	clientError?: Error,
) {
	setupBundleMocks()
	if (clientError) {
		mockModule.buildKodyAppClientBundle.mockRejectedValue(clientError)
	}
	const files = new Map([
		['package.json', createAppManifest(app)],
		...baseFiles,
		...extraFiles,
	])
	withRequiredPackageDocs(files)
	const snapshot = {
		read: vi.fn((path: string) => files.get(path) ?? null),
	}
	mockModule.createFileSystemSnapshot.mockResolvedValue(snapshot)
	mockModule.createTypescriptLanguageService.mockResolvedValue({
		fileSystem: { ...snapshot, write: vi.fn() },
		languageService: {
			dispose: vi.fn(),
			getSemanticDiagnostics: vi.fn(() => []),
		},
	})
	return await runRepoChecks({
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
		env: {} as Env,
		baseUrl: 'https://kody.dev',
		userId: ownerIdFromStored('user-123'),
	})
}

const appWithClient = { entry: './src/app.ts', client: './src/client.ts' }

test('runRepoChecks bundles kody.app.client for the browser alongside the Worker entry', async () => {
	const result = await runChecks({ ...appWithClient, assets: './public' })
	expect(result.ok).toBe(true)
	expect(result.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: 'bundle', ok: true }),
		]),
	)
	expect(mockModule.buildKodyAppBundle).toHaveBeenCalledWith(
		expect.objectContaining({ entryPoint: 'src/app.ts' }),
	)
	expect(mockModule.buildKodyAppClientBundle).toHaveBeenCalledWith(
		expect.objectContaining({ entryPoint: 'src/client.ts' }),
	)
	expect(mockModule.buildKodyAppClientBundle).toHaveBeenCalledTimes(1)

	// Shared helpers imported from both sides are fine; only the client entry
	// itself is off limits to the Worker graph.
	const sharedHelper = await runChecks(appWithClient, [
		[
			'src/app.ts',
			[
				"import { formatCount } from './format.ts'",
				'export default { async fetch() { return new Response(formatCount(1)) } }',
			].join('\n'),
		],
		[
			'src/client.ts',
			"import { formatCount } from './format.ts'\ndocument.body.textContent = formatCount(2)\n",
		],
		['src/format.ts', 'export const formatCount = (n: number) => `${n}`\n'],
	])
	expect(sharedHelper.ok).toBe(true)
})

test('runRepoChecks leaves apps without kody.app.client on the Worker-only path', async () => {
	const result = await runChecks({ entry: './src/app.ts' })
	expect(result.ok).toBe(true)
	expect(mockModule.buildKodyAppBundle).toHaveBeenCalledTimes(1)
	expect(mockModule.buildKodyAppClientBundle).not.toHaveBeenCalled()
})

test('runRepoChecks publishes a data-only app package with no exports field', async () => {
	const result = await runChecks({ entry: './src/app.ts' }, [
		[
			'package.json',
			JSON.stringify({
				name: '@kody/board-app',
				kody: {
					id: 'board-app',
					description: 'Data-only package with an app',
					app: { entry: './src/app.ts' },
				},
			}),
		],
	])
	expect(result.ok).toBe(true)
	expect(result.manifest?.exports).toEqual({})
	expect(result.results[0]).toMatchObject({ kind: 'manifest', ok: true })
	expect(mockModule.buildKodyAppBundle).toHaveBeenCalledTimes(1)
	expect(mockModule.buildKodyModuleBundle).not.toHaveBeenCalled()
	expect(mockModule.buildKodyImportableModuleBundle).not.toHaveBeenCalled()
})

test('runRepoChecks reports kody.app client, asset, and graph problems as bundle failures', async () => {
	const importsClient = [
		"import './client.ts'",
		'export default { async fetch() { return new Response("ok") } }',
	].join('\n')
	const cases: Array<{
		name: string
		app: Record<string, string>
		files?: Array<[string, string]>
		clientError?: Error
		messages: Array<string>
		notBuilt?: typeof mockModule.buildKodyAppBundle
	}> = [
		{
			name: 'missing client entry',
			app: { entry: './src/app.ts', client: './src/missing-client.ts' },
			messages: ['src/missing-client.ts'],
			notBuilt: mockModule.buildKodyAppClientBundle,
		},
		{
			name: 'browser bundle error',
			app: appWithClient,
			clientError: new Error(
				'Saved package app client "src/client.ts" bundle imports server-only modules that cannot run in the browser (src/client.ts: "kody:runtime").',
			),
			messages: ['src/client.ts: ', 'kody:runtime'],
		},
		{
			name: 'empty assets directory',
			app: { entry: './src/app.ts', assets: './static' },
			messages: ['no files exist under that directory'],
			notBuilt: mockModule.buildKodyAppBundle,
		},
		{
			name: 'assets at package root',
			app: { entry: './src/app.ts', assets: '.' },
			messages: ['must name a subdirectory'],
		},
		{
			name: 'worker imports client entry',
			app: appWithClient,
			files: [['src/app.ts', importsClient]],
			messages: ['imports the browser client entry "src/client.ts"'],
			notBuilt: mockModule.buildKodyAppBundle,
		},
		{
			name: 'worker imports client entry via helper',
			app: appWithClient,
			files: [
				[
					'src/app.ts',
					[
						"import { render } from './render.ts'",
						'export default { async fetch() { return new Response(render()) } }',
					].join('\n'),
				],
				[
					'src/render.ts',
					"import './client.ts'\nexport const render = () => 'x'\n",
				],
			],
			messages: [],
		},
		{
			name: 'worker and client share an entry',
			app: { entry: './src/app.ts', client: './src/app.ts' },
			messages: ['both point at "src/app.ts"'],
		},
		{
			name: 'asset shadowed by platform-served name',
			app: { ...appWithClient, assets: './public' },
			files: [['public/__version.json', '{"stale": true}']],
			messages: ['"public/__version.json"'],
			notBuilt: mockModule.buildKodyAppClientBundle,
		},
	]
	for (const { name, app, files, clientError, messages, notBuilt } of cases) {
		const result = await runChecks(app, files, clientError)
		const bundle = result.results.find((entry) => entry.kind === 'bundle')
		expect([name, result.ok, bundle?.ok]).toEqual([name, false, false])
		for (const message of messages) {
			expect([name, bundle?.message]).toEqual([
				name,
				expect.stringContaining(message),
			])
		}
		expect(notBuilt?.mock.calls ?? []).toEqual([])
	}
})

test('runRepoChecks accepts MCP tool capabilities and rejects malformed ones by name', async () => {
	const mcpApp = await runChecks({
		entry: './src/app.ts',
		capabilities: ['mcp:home:court_get_status', 'secretList'],
	})
	expect(mcpApp.ok).toBe(true)
	expect(mcpApp.results).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ kind: 'manifest', ok: true }),
		]),
	)

	const wildcard = await runChecks({
		entry: './src/app.ts',
		capabilities: ['mcp:home:*'],
	})
	expect(wildcard.ok).toBe(false)
	expect(JSON.stringify(wildcard.results)).toContain(
		'list each MCP tool by name (\\"mcp:<server>:<tool>\\"); wildcards are not supported.',
	)
})
