import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { vi } from 'vitest'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'

export const moduleGraphMockModule = {
	createWorker: vi.fn(),
	resolveSavedPackageRef: vi.fn(),
	getSavedPackageByName: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
	loadPublishedBundleArtifactByIdentity: vi.fn(),
	loadPublishedBundleArtifactsByIdentities: vi.fn(),
}

export function createBundleResult(suffix: string) {
	return {
		mainModule: `dist/${suffix}.js`,
		modules: {
			[`dist/${suffix}.js`]: `export default { async fetch() { return new Response(${JSON.stringify(
				suffix,
			)}) } }`,
		} satisfies WorkerLoaderModules,
		dependencies: [],
	}
}

export function createBundleInput(input?: {
	cacheKey?: string | null
	entryPoint?: string
}) {
	return {
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceFiles: {
			'package.json': JSON.stringify({
				name: '@kentcdodds/example-package',
				exports: {
					'.': './index.js',
				},
				kody: {
					id: 'example-package',
					description: 'Example package',
					app: {
						entry: input?.entryPoint ?? 'app.js',
					},
				},
			}),
			'app.js':
				'export default { async fetch() { return new Response("app") } }',
			'index.js': 'export const value = "ok"',
		},
		entryPoint: input?.entryPoint ?? 'app.js',
		cacheKey: input?.cacheKey,
	}
}

export function createModuleBundleInput(input?: {
	reuseCachedBundle?: boolean
	userId?: string
	code?: string
}) {
	return {
		env: {
			APP_DB: {},
			REPO_SESSION: {},
		} as Env,
		baseUrl: 'https://heykody.dev',
		userId: input?.userId ?? 'user-1',
		sourceFiles: {
			'entry.ts':
				input?.code ?? 'export default async function run() { return "ok" }',
		},
		entryPoint: 'entry.ts',
		reuseCachedBundle: input?.reuseCachedBundle,
	}
}

export async function createTemporaryModuleGraph(files: WorkerLoaderModules) {
	const root = await mkdtemp(join(tmpdir(), 'kody-module-graph-'))
	for (const [filePath, source] of Object.entries(files)) {
		if (typeof source !== 'string') {
			throw new Error(`Expected string module source for ${filePath}.`)
		}
		const destination = join(root, filePath)
		await mkdir(dirname(destination), { recursive: true })
		await writeFile(destination, source, 'utf8')
	}
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({ type: 'module' }),
		'utf8',
	)
	return {
		async importModule(modulePath: string, options?: { cacheBust?: boolean }) {
			const moduleUrl = pathToFileURL(join(root, modulePath))
			if (options?.cacheBust ?? true) {
				moduleUrl.searchParams.set('cache', crypto.randomUUID())
			}
			return await import(moduleUrl.href)
		},
		async cleanup() {
			await rm(root, { recursive: true, force: true })
		},
	}
}

export type RuntimeModule = {
	__kodyRunInRuntime: <T>(
		runtime: Record<string, unknown>,
		callback: () => Promise<T>,
	) => Promise<T>
}

export function createSavedPackageRecord(input?: {
	name?: string
	kodyId?: string
	sourceId?: string
}) {
	return {
		id: 'pkg-1',
		userId: 'user-1',
		name: input?.name ?? '@kentcdodds/example-package',
		kodyId: input?.kodyId ?? 'example-package',
		description: 'Example package',
		tags: [],
		searchText: null,
		sourceId: input?.sourceId ?? 'source-1',
		hasApp: false,
		hidden: false,
		isPrivate: false,
		isInternetVisible: false,
		createdAt: '2026-04-24T00:00:00.000Z',
		updatedAt: '2026-04-24T00:00:00.000Z',
	}
}

export function createLoadedPackageSource() {
	return {
		source: {
			id: 'source-1',
			published_commit: 'commit-1',
		},
		manifest: {
			name: '@kentcdodds/example-package',
			exports: {
				'.': './index.js',
				'./follow-up-on-pr-agent': './follow-up-on-pr-agent.js',
			},
			kody: {
				id: 'example-package',
				description: 'Example package',
			},
		},
		files: {
			'index.js': 'export const value = "ok"',
			'follow-up-on-pr-agent.js':
				'export default async function followUp() { return "ok" }',
		},
	}
}
