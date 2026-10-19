import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	createAdHocExecuteSourceFiles,
	runBundledModuleWithRegistry,
} from '#mcp/run-kody-registry.ts'
import {
	buildKodyAppClientBundle,
	buildKodyImportableModuleBundle,
	buildKodyModuleBundle,
} from './module-graph.ts'
import { packageAppClientModuleNamePattern } from './package-app-client-module-name.ts'
import { persistPublishedSourceSnapshot } from './published-runtime-artifacts.ts'
import { persistPublishedBundleArtifact } from './published-bundle-artifacts.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { ensureSoftDeleteTestColumns } from '#worker/soft-delete/test-schema.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

const baseUrl = 'https://kody.dev'

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

async function ensureSavedPackageArtifactSchema() {
	await runSql(`CREATE TABLE IF NOT EXISTS entity_sources (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		entity_kind TEXT NOT NULL,
		entity_id TEXT NOT NULL,
		repo_id TEXT NOT NULL,
		published_commit TEXT,
		indexed_commit TEXT,
		manifest_path TEXT NOT NULL DEFAULT 'package.json',
		source_root TEXT NOT NULL DEFAULT '/',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`)
	await runSql(`CREATE TABLE IF NOT EXISTS saved_packages (
		id TEXT PRIMARY KEY NOT NULL,
		user_id TEXT NOT NULL,
		name TEXT NOT NULL,
		kody_id TEXT NOT NULL,
		description TEXT NOT NULL,
		tags_json TEXT NOT NULL DEFAULT '[]',
		search_text TEXT,
		source_id TEXT NOT NULL,
		has_app INTEGER NOT NULL DEFAULT 0 CHECK (has_app IN (0, 1)),
		has_skills INTEGER NOT NULL DEFAULT 0 CHECK (has_skills IN (0, 1)),
		hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
		is_private INTEGER NOT NULL DEFAULT 1 CHECK (is_private IN (0, 1)),
		is_internet_visible INTEGER NOT NULL DEFAULT 0,
		locked_at TEXT,
		created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
		updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
	)`)
	for (const column of [
		'is_private INTEGER NOT NULL DEFAULT 1',
		'is_internet_visible INTEGER NOT NULL DEFAULT 0',
		'locked_at TEXT',
	]) {
		try {
			await runSql(`ALTER TABLE saved_packages ADD COLUMN ${column}`)
		} catch {
			// Column already present on newer schemas.
		}
	}
	await runSql(`CREATE TABLE IF NOT EXISTS published_bundle_artifacts (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		source_id TEXT NOT NULL,
		published_commit TEXT NOT NULL,
		artifact_kind TEXT NOT NULL,
		artifact_name TEXT,
		entry_point TEXT NOT NULL,
		kv_key TEXT NOT NULL,
		dependencies_json TEXT NOT NULL DEFAULT '[]',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`)
	await ensureSoftDeleteTestColumns(env.APP_DB)
}

function makePackageFiles(
	kodyId: string,
	manifest: {
		description: string
		exports: Record<string, string>
		dependencies?: Record<string, string>
		app?: Record<string, unknown>
	},
	files: Record<string, string> = {},
) {
	const { description, app, ...rest } = manifest
	return {
		'package.json': JSON.stringify({
			name: `@kentcdodds/${kodyId}`,
			...rest,
			kody: { id: kodyId, description, app },
		}),
		...files,
	}
}

function callerContextFor(userId: string) {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl,
		user: {
			userId: personIdFromStored(userId),
			email: 'worker@example.com',
			displayName: 'Worker Test',
		},
	})
}

function buildAdHoc(userId: string, entrySource: string) {
	return buildKodyModuleBundle({
		env,
		baseUrl,
		userId,
		bundleContext: 'ad-hoc-execute',
		sourceFiles: { 'entry.ts': entrySource },
		entryPoint: 'entry.ts',
	})
}

function runBundle(
	userIdOrContext: string | ReturnType<typeof callerContextFor>,
	bundle: Parameters<typeof runBundledModuleWithRegistry>[2],
	input?: Parameters<typeof runBundledModuleWithRegistry>[3],
	options: Parameters<typeof runBundledModuleWithRegistry>[4] = {},
) {
	return runBundledModuleWithRegistry(
		env,
		typeof userIdOrContext === 'string'
			? callerContextFor(userIdOrContext)
			: userIdOrContext,
		{ mainModule: bundle.mainModule, modules: bundle.modules },
		input,
		{ skipCapabilityRegistry: true, ...options },
	)
}

async function publishImportablePackage(input: {
	kodyId: string
	description: string
	exportName: string
	entryPoint: string
	files: Record<string, string>
	stampRoot: boolean
}) {
	await ensureSavedPackageArtifactSchema()
	await ensureUsersTestSchema({ db: env.APP_DB })
	const unique = crypto.randomUUID()
	const userId = `user-${unique}`
	const packageId = `pkg-${unique}`
	const sourceId = `source-${unique}`
	const now = new Date().toISOString()
	await runSql(
		`INSERT INTO users (username, email, password_hash, stable_user_id)
		 VALUES (?, ?, ?, ?)`,
		`worker-${unique}`,
		`worker-${unique}@example.com`,
		'test-password-hash',
		userId,
	)
	await runSql(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, '[]', NULL, ?, 0, ?, ?)`,
		packageId,
		userId,
		`@kentcdodds/${input.kodyId}`,
		input.kodyId,
		`@kentcdodds/${input.kodyId} package`,
		sourceId,
		now,
		now,
	)
	const source = {
		id: sourceId,
		user_id: ownerIdFromStored(userId),
		entity_kind: 'package' as const,
		entity_id: packageId,
		repo_id: `repo-${sourceId}`,
		published_commit: `commit-${unique}`,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: now,
		updated_at: now,
	}
	await runSql(
		`INSERT INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, published_commit,
			indexed_commit, manifest_path, source_root, created_at, updated_at
		) VALUES (?, ?, 'package', ?, ?, ?, NULL, 'package.json', '/', ?, ?)`,
		sourceId,
		userId,
		packageId,
		source.repo_id,
		source.published_commit,
		now,
		now,
	)
	const sourceFiles = makePackageFiles(
		input.kodyId,
		{
			description: input.description,
			exports: { [input.exportName]: `./${input.entryPoint}` },
		},
		input.files,
	)
	await persistPublishedSourceSnapshot({
		env,
		userId,
		source,
		snapshot: { files: sourceFiles },
	})
	const bundle = await buildKodyImportableModuleBundle({
		env,
		baseUrl,
		userId,
		sourceFiles,
		entryPoint: input.entryPoint,
		...(input.stampRoot ? { rootPackageId: packageId } : {}),
	})
	await persistPublishedBundleArtifact({
		env,
		userId,
		source,
		kind: 'importable-module',
		artifactName: input.exportName,
		entryPoint: input.entryPoint,
		mainModule: bundle.mainModule,
		modules: bundle.modules,
		dependencies: bundle.dependencies,
		packageContext: { packageId, kodyId: input.kodyId, sourceId },
	})
	return {
		userId,
		packageId,
		sourceFiles,
		callerContext: callerContextFor(userId),
	}
}

test(
	'saved package bundles and executes npm dependencies declared in package.json',
	// Contended `npm run validate` on Cloud Agent VMs can spend ~20s here
	// (Friction #2760). Isolated run is ~14s for the whole file.
	{ timeout: 40_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl,
			userId: ownerIdFromStored('user-workers-test'),
			sourceFiles: makePackageFiles(
				'dependency-package',
				{
					description: 'Exercises npm dependency bundling',
					exports: { '.': './src/index.ts' },
					dependencies: { kleur: '^4.1.5' },
				},
				{
					'src/index.ts': `import kleur from 'kleur'
export default async function run() {
	return { formatted: kleur.green('dependency-ok') }
}`,
				},
			),
			entryPoint: 'src/index.ts',
		})

		const moduleSources = Object.values(bundle.modules)
			.map((module) => {
				if (typeof module === 'string') return module
				return [module.js, module.cjs, module.text]
					.filter((value): value is string => typeof value === 'string')
					.join('\n')
			})
			.join('\n')
		expect(moduleSources).toContain('dependency-ok')
		expect(moduleSources).not.toContain(`from "kleur"`)

		const result = await runBundle('user-workers-test', bundle)
		expect(result.error).toBeUndefined()
		expect(result.result).toEqual({ formatted: 'dependency-ok' })
	},
)

test(
	'saved package bundles and runs deps whose Node build imports bare module (#4074)',
	// fflate's Node export does `import { createRequire } from "module"`. The
	// bundler leaves that external; publish must accept it and workerd
	// nodejs_compat must resolve createRequire at runtime.
	{ timeout: 40_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl,
			userId: ownerIdFromStored('user-fflate-bare-module'),
			sourceFiles: makePackageFiles(
				'fflate-bare-module',
				{
					description: 'fflate bare module import regression',
					exports: { '.': './src/index.ts' },
					dependencies: { fflate: '0.8.2' },
				},
				{
					'src/index.ts': `import { gzipSync, gunzipSync } from 'fflate'
export default async function run() {
	const input = new Uint8Array([1, 2, 3, 4])
	const zipped = gzipSync(input)
	return { bytes: zipped.length, roundtrip: Array.from(gunzipSync(zipped)) }
}`,
				},
			),
			entryPoint: 'src/index.ts',
		})

		const moduleSources = Object.values(bundle.modules)
			.map((module) => {
				if (typeof module === 'string') return module
				return [module.js, module.cjs, module.text]
					.filter((value): value is string => typeof value === 'string')
					.join('\n')
			})
			.join('\n')
		expect(moduleSources).toMatch(/from\s+["']module["']/)
		expect(moduleSources).not.toContain(`from "fflate"`)

		const result = await runBundle('user-fflate-bare-module', bundle)
		expect(result.error).toBeUndefined()
		expect(result.result).toEqual({
			bytes: expect.any(Number),
			roundtrip: [1, 2, 3, 4],
		})
	},
)

test(
	'ad hoc execute synthesizes and executes npm dependencies through the bundler',
	{ timeout: 40_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const sourceFiles = createAdHocExecuteSourceFiles(`import kleur from 'kleur'
export default function main() {
	return { formatted: kleur.green('ad-hoc-dependency-ok') }
}`)
		expect(JSON.parse(sourceFiles['package.json'] ?? '{}')).toEqual({
			dependencies: { kleur: 'latest' },
		})
		const bundle = await buildKodyModuleBundle({
			env,
			baseUrl,
			userId: ownerIdFromStored('user-ad-hoc-npm-test'),
			sourceFiles,
			entryPoint: 'entry.ts',
			bundleContext: 'ad-hoc-execute',
		})
		const result = await runBundle('user-ad-hoc-npm-test', bundle)
		expect(result.error).toBeUndefined()
		expect(result.result).toEqual({ formatted: 'ad-hoc-dependency-ok' })
	},
)

test(
	'named-only package exports build callable artifacts and stay importable',
	{ timeout: 30_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const namedOnlySource =
			'export function double(value: number) { return value * 2 }'
		const { userId, packageId, sourceFiles, callerContext } =
			await publishImportablePackage({
				kodyId: 'named-only',
				description: 'Named-only export package',
				exportName: '.',
				entryPoint: 'src/index.ts',
				stampRoot: true,
				files: { 'src/index.ts': namedOnlySource },
			})

		for (const entrySource of [
			namedOnlySource,
			`interface Shape { value: number }
export { Shape as default }
${namedOnlySource}`,
		]) {
			const callableBundle = await buildKodyModuleBundle({
				env,
				baseUrl,
				userId,
				sourceFiles: { ...sourceFiles, 'src/index.ts': entrySource },
				entryPoint: 'src/index.ts',
				rootPackageId: packageId,
			})
			const invoked = await runBundle(callerContext, callableBundle)
			expect(invoked.result).toBeUndefined()
			expect(String(invoked.error)).toContain(
				'Kody execute modules must default export a function; "src/index.ts" has no default export.',
			)
		}

		const callerBundle = await buildAdHoc(
			userId,
			`import { double } from 'kody:@kentcdodds/named-only'
export default async function main() {
	return { doubled: double(21) }
}`,
		)
		const imported = await runBundle(callerContext, callerBundle)
		expect(imported.error).toBeUndefined()
		expect(imported.result).toEqual({ doubled: 42 })
	},
)

test(
	'computed import(specifier) loads caller-owned default export without packages bound',
	{ timeout: 30_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const { userId, callerContext } = await publishImportablePackage({
			kodyId: 'computed-import-target',
			description: 'Computed import Gate 2 target',
			exportName: './probe',
			entryPoint: 'src/probe.ts',
			stampRoot: true,
			files: {
				'src/probe.ts': `import { packageContext, packages } from 'kody:runtime'

export default async function probe(input: { marker?: string } = {}) {
	return {
		marker: input.marker ?? null,
		packageContextKodyId: packageContext?.kodyId ?? null,
		packagesBound: packages != null,
	}
}`,
			},
		})

		const callerBundle = await buildAdHoc(
			userId,
			`import { packages } from 'kody:runtime'

export default async function main() {
	const specifier = 'kody:@kentcdodds/computed-import-target/probe'
	const mod = await import(specifier)
	const result = await mod.default({ marker: 'from-computed-import' })
	return {
		result,
		callerPackagesBound: packages != null,
	}
}`,
		)
		const result = await runBundle(callerContext, callerBundle, undefined, {
			// Gate 2: computed import works with `packages` unbound.
			packageContext: null,
		})

		expect(result.error).toBeUndefined()
		expect(result.result).toEqual({
			result: {
				marker: 'from-computed-import',
				// Library-load semantics: caller's packageContext (null on execute).
				packageContextKodyId: null,
				packagesBound: false,
			},
			callerPackagesBound: false,
		})
	},
)

test(
	'kody.app.client bundles TypeScript for the browser into one fingerprinted ESM module',
	{ timeout: 20_000 },
	async () => {
		silenceIncidentalRuntimeWarnings()
		const clientPackageJson = (client: unknown) =>
			makePackageFiles('browser-client', {
				description: 'Exercises the browser client bundle',
				exports: { '.': './src/index.ts' },
				app: { entry: './src/app.ts', client },
			})['package.json']
		const sourceFiles = {
			'package.json': clientPackageJson('./src/client.ts'),
			'src/index.ts': 'export default async () => ({ ok: true })',
			'src/app.ts': `import { packageContext } from 'kody:runtime'
export default {
	async fetch() {
		return new Response(packageContext?.clientModuleUrl ?? "")
	},
}`,
			'src/client.ts': `import { render } from './render.ts'

type Greeting = { name: string }
const greeting: Greeting = { name: "browser" }
export const mounted = render(greeting.name)`,
			'src/render.ts': `export function render(name: string) {
	return \`hello \${name}\`
}`,
		}
		const buildClient = (overrides: Record<string, string> = {}) =>
			buildKodyAppClientBundle({
				sourceFiles: { ...sourceFiles, ...overrides },
				entryPoint: 'src/client.ts',
			})

		const bundle = await buildClient()
		expect(bundle.mainModule).toMatch(packageAppClientModuleNamePattern)
		expect(Object.keys(bundle.modules)).toEqual([bundle.mainModule])
		const source = bundle.modules[bundle.mainModule]
		expect(typeof source).toBe('string')
		const code = source as string
		// Browser ESM: TypeScript stripped, relative graph inlined, no imports
		// left for the browser to resolve, and the export surface preserved.
		expect(code).not.toContain('type Greeting')
		expect(code).not.toMatch(/\bimport\b/)
		expect(code).toContain('hello ${name}')
		expect(code).toMatch(/export\s*\{/)
		expect((await buildClient()).mainModule).toBe(bundle.mainModule)

		// Declared externals survive esbuild as bare imports for the page's
		// import map; the relative graph is still inlined around them.
		const withExternals = await buildClient({
			'package.json': clientPackageJson({
				entry: './src/client.ts',
				externals: ['lit'],
			}),
			'src/client.ts': `import { html } from 'lit'
import { render } from './render.ts'
export const mounted = render(String(html))`,
		})
		const externalCode = withExternals.modules[withExternals.mainModule]
		expect(externalCode).toMatch(/from\s+"lit"/)
		expect(externalCode).toContain('hello ${name}')
		expect(externalCode).not.toMatch(/from\s+["']\.\/render/)

		// Subpaths of a declared external stay external too, but a package that
		// merely shares the prefix is not silently externalized: it is an
		// unresolved bare import and fails publish with the externals hint.
		const preactPackageJson = clientPackageJson({
			entry: './src/client.ts',
			externals: ['preact'],
		})
		const subpath = await buildClient({
			'package.json': preactPackageJson,
			'src/client.ts': `import { useState } from 'preact/hooks'
export const state = useState`,
		})
		expect(subpath.modules[subpath.mainModule]).toMatch(
			/from\s+"preact\/hooks"/,
		)
		await expect(
			buildClient({
				'package.json': preactPackageJson,
				'src/client.ts': `import render from 'preact-render-to-string'
export const html = render`,
			}),
		).rejects.toThrow(
			/unresolved bare package imports after bundling \("preact-render-to-string"\)/,
		)
	},
)
