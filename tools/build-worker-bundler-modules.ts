import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
	copyFile,
	link,
	mkdir,
	open,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { isExecutedDirectly } from './node-runtime.ts'

/**
 * Pre-bundles `@cloudflare/worker-bundler` (and its `/typescript` entry),
 * `@cloudflare/workers-oauth-provider`, local-execute runtime support
 * (inlined CAF rewrite + CapabilityProxy shim source builders), and
 * isomorphic-git into standalone ES modules under
 * `packages/worker/.generated/`.
 *
 * Why: wrangler inlines every dynamic `import()` into the single main worker
 * module, so the ~3.6 MB runtime bundler/TypeScript compiler was parsed and
 * evaluated on every isolate cold start even though only repo checks use it.
 * With `find_additional_modules` enabled in `wrangler.jsonc`, these generated
 * `.mjs` files upload as separate external modules that only load when the
 * repo-check paths actually import them. The rules name each file, so a stray
 * sibling under `node_modules/.kody-generated/` is not uploaded (Friction
 * #2504). The OAuth provider rides the same lane: origin's `fetch` wrapper
 * imports it statically, but
 * `#worker/oauth-helpers.ts` needs it only when `OAUTH_PROVIDER` is absent
 * (scheduled purge lane, the `MCP` Durable Object on kody-platform), and the
 * platform/runtime startup entries must not carry it. Local-execute package
 * graph (#2830 rewrite / shim templates) uses the same deferral so platform
 * startup bytes stay under budget (kody#2831). isomorphic-git is already lazy
 * for CPU via `#worker/isomorphic-git-load.ts`; the additional module
 * keeps its ~160 KB (+ pako) out of the Wrangler main byte graph after the
 * Zod 4.6.5 startup growth (kody#2839 / kody#2856). postal-mime (~80 KB) and
 * codemode's acorn-backed `normalizeCode` (~123 KB) ride the same lane: every
 * MIME parse and every execute is already async (kody#3367 / kody#3368).
 *
 * Wrangler discovers additional ES modules by walking the entry directory
 * (`packages/worker/src`) and file-watches every discovered module. Overlay-FS
 * create events on those files retrigger `wrangler dev` (Friction #1789).
 * Artifacts live in `packages/worker/.generated/` and are hardlinked under
 * `src/node_modules/.kody-generated/` so the walk finds them, the directory
 * watcher skips `node_modules`, and `tools/wrangler-filter-kody-generated-watch.ts`
 * clears that collector's esbuild `watchFiles` / `watchDirs`. workerd still
 * requires CompiledWasm for `esbuild.wasm` (`WebAssembly.compile` is
 * disallowed).
 *
 * Origin UI still imports `remix` from repo `node_modules`. This generator
 * does not vendor Remix (or any other third-party package) into package
 * bundles; packages declare and install their own dependencies.
 *
 * The output is deterministic for a given installed package version, so a
 * stamp file makes re-runs a no-op (important: this runs in front of every
 * wrangler dev/build/deploy and once per vitest run).
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
export const workerBundlerGeneratedDir = path.join(
	repoRoot,
	'packages/worker/.generated',
)
export const workerBundlerWranglerDir = path.join(
	repoRoot,
	'packages/worker/src/node_modules/.kody-generated',
)
const leftoverSrcGeneratedDir = path.join(
	repoRoot,
	'packages/worker/src/generated',
)
export const leftoverSrcGeneratedBundlerNames = [
	'worker-bundler.mjs',
	'worker-bundler-typescript.mjs',
	'esbuild.wasm',
	'esbuild-wasm.mjs',
	'worker-bundler.stamp.json',
] as const
const leftoverPackageAppRemixModuleName = 'package-app-remix.mjs'
export const localExecuteRuntimeSupportModuleName =
	'local-execute-runtime-support.mjs'
const localExecuteRuntimeSupportEntry = path.join(
	repoRoot,
	'packages/worker/src/package-runtime/local-execute-runtime-support.ts',
)
export const isomorphicGitModuleName = 'isomorphic-git.mjs'
const isomorphicGitModuleEntry = path.join(
	repoRoot,
	'packages/worker/src/repo/isomorphic-git-module.ts',
)
export const postalMimeModuleName = 'postal-mime.mjs'
const postalMimeModuleEntry = path.join(
	repoRoot,
	'packages/worker/src/email/postal-mime-module.ts',
)
export const disposableEmailDomainsModuleName = 'disposable-email-domains.mjs'
const disposableEmailDomainsModuleEntry = path.join(
	repoRoot,
	'packages/worker/src/identity/disposable-email-domains-module.ts',
)
const disposableEmailDomainsListPath = path.join(
	repoRoot,
	'packages/worker/src/identity/disposable-email-domains.ts',
)
export const codemodeNormalizeModuleName = 'codemode-normalize.mjs'
const codemodeNormalizeModuleEntry = path.join(
	repoRoot,
	'packages/worker/src/mcp/codemode-normalize-module.ts',
)
const generatedArtifactNames = [
	'worker-bundler.mjs',
	'worker-bundler-typescript.mjs',
	'oauth-provider.mjs',
	localExecuteRuntimeSupportModuleName,
	isomorphicGitModuleName,
	postalMimeModuleName,
	codemodeNormalizeModuleName,
	disposableEmailDomainsModuleName,
	'esbuild.wasm',
] as const
const leftoverWranglerVisibleNames = [
	...generatedArtifactNames,
	'esbuild-wasm.mjs',
	leftoverPackageAppRemixModuleName,
] as const
const stampPath = path.join(
	workerBundlerGeneratedDir,
	'worker-bundler.stamp.json',
)

const nodeBuiltins = new Set([
	'assert',
	'async_hooks',
	'buffer',
	'child_process',
	'crypto',
	'events',
	'fs',
	'http',
	'https',
	'inspector',
	'module',
	'net',
	'os',
	'path',
	'perf_hooks',
	'process',
	'stream',
	'tls',
	'url',
	'util',
	'worker_threads',
	'zlib',
])

/**
 * Keeps `./esbuild.wasm` imports external verbatim (wrangler uploads the wasm
 * as a sibling CompiledWasm module), leaves `cloudflare:*` runtime modules to
 * workerd, and normalizes Node builtins to their `node:`-prefixed form so
 * `nodejs_compat` resolves them at runtime.
 */
const externalsPlugin: Plugin = {
	name: 'worker-bundler-externals',
	setup(pluginBuild) {
		pluginBuild.onResolve({ filter: /\.wasm$/ }, (args) => ({
			path: args.path,
			external: true,
		}))
		pluginBuild.onResolve({ filter: /^cloudflare:/ }, (args) => ({
			path: args.path,
			external: true,
		}))
		pluginBuild.onResolve({ filter: /^node:/ }, (args) => ({
			path: args.path,
			external: true,
		}))
		pluginBuild.onResolve({ filter: /^[a-z_]+$/ }, (args) => {
			if (!nodeBuiltins.has(args.path)) return null
			return { path: `node:${args.path}`, external: true }
		})
	},
}

const workerSrcRoot = path.join(repoRoot, 'packages/worker/src')

/** Resolve `#worker/…` and `#mcp/…` / `#universal/…` / `#app/…` package imports. */
const kodyPackageImportsPlugin: Plugin = {
	name: 'kody-package-imports',
	setup(pluginBuild) {
		pluginBuild.onResolve({ filter: /^#worker\// }, (args) => ({
			path: path.join(workerSrcRoot, args.path.slice('#worker/'.length)),
		}))
		pluginBuild.onResolve({ filter: /^#mcp\// }, (args) => ({
			path: path.join(workerSrcRoot, 'mcp', args.path.slice('#mcp/'.length)),
		}))
		pluginBuild.onResolve({ filter: /^#app\// }, (args) => ({
			path: path.join(workerSrcRoot, 'app', args.path.slice('#app/'.length)),
		}))
		pluginBuild.onResolve({ filter: /^#universal\// }, (args) => ({
			path: path.join(
				repoRoot,
				'packages/worker/universal',
				args.path.slice('#universal/'.length),
			),
		}))
	},
}

async function readStamp(): Promise<string | null> {
	try {
		return await readFile(stampPath, 'utf8')
	} catch {
		return null
	}
}

function resolveWorkerBundlerDistDir() {
	// Resolved by direct path: the package is ESM-only so CJS
	// `require.resolve` cannot see its exports, and `import.meta.resolve` is
	// unsupported inside vitest's module runner (this runs as global setup).
	return path.join(repoRoot, 'node_modules', '@cloudflare', 'worker-bundler')
}

function resolveOAuthProviderPackageDir() {
	return path.join(
		repoRoot,
		'node_modules',
		'@cloudflare',
		'workers-oauth-provider',
	)
}

async function buildStampContent(
	bundlerPackageDir: string,
	oauthProviderPackageDir: string,
) {
	const bundlerPackageJson = await readFile(
		path.join(bundlerPackageDir, 'package.json'),
		'utf8',
	)
	const oauthProviderPackageJson = await readFile(
		path.join(oauthProviderPackageDir, 'package.json'),
		'utf8',
	)
	const lockfile = await readFile(
		path.join(repoRoot, 'package-lock.json'),
		'utf8',
	)
	const generatorSource = await readFile(fileURLToPath(import.meta.url), 'utf8')
	const localExecuteRuntimeSupportSource = await readFile(
		localExecuteRuntimeSupportEntry,
		'utf8',
	)
	const localExecuteRewriteSource = await readFile(
		path.join(
			repoRoot,
			'packages/worker/src/package-runtime/rewrite-inlined-local-runtime.ts',
		),
		'utf8',
	)
	// Bundled into local-execute-runtime-support.mjs via rewrite →
	// `#worker/module-source.ts` (`parseModuleSource`). Hash it so parser-only
	// edits regenerate the deferred module (node tests alias the TS source and
	// would otherwise stay green against a stale .mjs).
	const localExecuteModuleSource = await readFile(
		path.join(repoRoot, 'packages/worker/src/module-source.ts'),
		'utf8',
	)
	const isomorphicGitModuleSource = await readFile(
		isomorphicGitModuleEntry,
		'utf8',
	)
	const isomorphicGitPackageJson = await readFile(
		path.join(repoRoot, 'node_modules', 'isomorphic-git', 'package.json'),
		'utf8',
	)
	const postalMimeModuleSource = await readFile(postalMimeModuleEntry, 'utf8')
	const codemodeNormalizeModuleSource = await readFile(
		codemodeNormalizeModuleEntry,
		'utf8',
	)
	const disposableEmailDomainsSource = await readFile(
		disposableEmailDomainsListPath,
		'utf8',
	)
	const disposableEmailDomainsModuleSource = await readFile(
		disposableEmailDomainsModuleEntry,
		'utf8',
	)
	const shellPackageJson = await readFile(
		path.join(repoRoot, 'node_modules', '@cloudflare', 'shell', 'package.json'),
		'utf8',
	)
	const esbuildVersion = (
		JSON.parse(
			await readFile(
				path.join(repoRoot, 'node_modules', 'esbuild', 'package.json'),
				'utf8',
			),
		) as { version: string }
	).version
	const hash = createHash('sha256')
		.update(bundlerPackageJson)
		.update(oauthProviderPackageJson)
		.update(lockfile)
		.update(esbuildVersion)
		.update(generatorSource)
		.update(localExecuteRuntimeSupportSource)
		.update(localExecuteRewriteSource)
		.update(localExecuteModuleSource)
		.update(isomorphicGitModuleSource)
		.update(isomorphicGitPackageJson)
		.update(postalMimeModuleSource)
		.update(disposableEmailDomainsSource)
		.update(disposableEmailDomainsModuleSource)
		.update(codemodeNormalizeModuleSource)
		.update(shellPackageJson)
		.update(
			await readFile(
				path.join(
					repoRoot,
					'packages/worker/src/package-runtime/module-graph-path-basics.ts',
				),
				'utf8',
			),
		)
		.update(
			await readFile(
				path.join(
					repoRoot,
					'packages/worker/src/mcp/execute-modules/credential-client-source.ts',
				),
				'utf8',
			),
		)
		.update(
			await readFile(
				path.join(
					repoRoot,
					'packages/worker/src/credentials/credential-client-header.ts',
				),
				'utf8',
			),
		)
		.digest('hex')
	return JSON.stringify({ hash }, null, '\t')
}

async function pathExists(filePath: string) {
	try {
		await stat(filePath)
		return true
	} catch {
		return false
	}
}

async function wranglerVisibleModulesExist() {
	const results = await Promise.all(
		generatedArtifactNames.map((name) =>
			pathExists(path.join(workerBundlerWranglerDir, name)),
		),
	)
	return results.every(Boolean)
}

export async function removeLeftoverSrcGeneratedBundlerArtifacts() {
	await Promise.all(
		leftoverSrcGeneratedBundlerNames.map((name) =>
			rm(path.join(leftoverSrcGeneratedDir, name), { force: true }),
		),
	)
}

async function materializeWranglerVisibleModules() {
	await mkdir(workerBundlerWranglerDir, { recursive: true })
	await Promise.all(
		leftoverWranglerVisibleNames.map((name) =>
			rm(path.join(workerBundlerWranglerDir, name), { force: true }),
		),
	)
	for (const name of generatedArtifactNames) {
		const from = path.join(workerBundlerGeneratedDir, name)
		const to = path.join(workerBundlerWranglerDir, name)
		try {
			await link(from, to)
		} catch {
			await copyFile(from, to)
		}
	}
}

/** Idempotent: skips the esbuild work when the stamp is already current. */
export async function ensureWorkerBundlerModules() {
	const bundlerPackageDir = resolveWorkerBundlerDistDir()
	const oauthProviderPackageDir = resolveOAuthProviderPackageDir()
	const stampContent = await buildStampContent(
		bundlerPackageDir,
		oauthProviderPackageDir,
	)
	await removeLeftoverSrcGeneratedBundlerArtifacts()
	await rm(path.join(workerBundlerGeneratedDir, 'esbuild-wasm.mjs'), {
		force: true,
	})
	await rm(
		path.join(workerBundlerGeneratedDir, leftoverPackageAppRemixModuleName),
		{
			force: true,
		},
	)
	await rm(
		path.join(workerBundlerWranglerDir, leftoverPackageAppRemixModuleName),
		{
			force: true,
		},
	)
	if (
		(await readStamp()) === stampContent &&
		(await wranglerVisibleModulesExist())
	) {
		return
	}

	await mkdir(workerBundlerGeneratedDir, { recursive: true })
	await build({
		entryPoints: {
			'worker-bundler': path.join(bundlerPackageDir, 'dist/index.js'),
			'worker-bundler-typescript': path.join(
				bundlerPackageDir,
				'dist/typescript.js',
			),
			'oauth-provider': path.join(
				oauthProviderPackageDir,
				'dist/oauth-provider.js',
			),
		},
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		minify: true,
		outdir: workerBundlerGeneratedDir,
		outExtension: { '.js': '.mjs' },
		plugins: [externalsPlugin],
		logLevel: 'silent',
	})
	await buildLocalExecuteRuntimeSupportModule()
	await buildIsomorphicGitModule()
	await build({
		entryPoints: {
			'postal-mime': postalMimeModuleEntry,
			'codemode-normalize': codemodeNormalizeModuleEntry,
			'disposable-email-domains': disposableEmailDomainsModuleEntry,
		},
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		minify: true,
		outdir: workerBundlerGeneratedDir,
		outExtension: { '.js': '.mjs' },
		plugins: [externalsPlugin],
		logLevel: 'silent',
	})
	await copyFile(
		path.join(bundlerPackageDir, 'dist/esbuild.wasm'),
		path.join(workerBundlerGeneratedDir, 'esbuild.wasm'),
	)
	await writeFile(stampPath, stampContent)
	await rm(path.join(workerBundlerGeneratedDir, 'esbuild-wasm.mjs'), {
		force: true,
	})
	await materializeWranglerVisibleModules()
	await fsyncGeneratedDir()
}

async function buildLocalExecuteRuntimeSupportModule() {
	await build({
		entryPoints: [localExecuteRuntimeSupportEntry],
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		target: 'es2022',
		minify: true,
		outfile: path.join(
			workerBundlerGeneratedDir,
			localExecuteRuntimeSupportModuleName,
		),
		plugins: [externalsPlugin, kodyPackageImportsPlugin],
		logLevel: 'silent',
	})
}

async function buildIsomorphicGitModule() {
	// Do not reuse `externalsPlugin` here: marking `buffer` external leaves a
	// `require("node:buffer")` in the additional module, and workerd rejects
	// dynamic Node builtin requires in ESM additional modules (package-create /
	// RepoSession git paths fail with "Dynamic require of node:buffer is not
	// supported"). Polyfill Buffer into the bundle; keep only `node:crypto` for
	// `@cloudflare/shell` workspace hashing under `nodejs_compat`.
	const require = createRequire(import.meta.url)
	const isomorphicGitExternalsPlugin: Plugin = {
		name: 'isomorphic-git-externals',
		setup(pluginBuild) {
			pluginBuild.onResolve({ filter: /^cloudflare:/ }, (args) => ({
				path: args.path,
				external: true,
			}))
			pluginBuild.onResolve({ filter: /^node:crypto$/ }, (args) => ({
				path: args.path,
				external: true,
			}))
			pluginBuild.onResolve({ filter: /^crypto$/ }, () => ({
				path: 'node:crypto',
				external: true,
			}))
			pluginBuild.onResolve({ filter: /^(node:)?buffer$/ }, () => ({
				path: require.resolve('buffer/'),
			}))
		},
	}
	await build({
		entryPoints: [isomorphicGitModuleEntry],
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		minify: true,
		outfile: path.join(workerBundlerGeneratedDir, isomorphicGitModuleName),
		plugins: [isomorphicGitExternalsPlugin],
		logLevel: 'silent',
	})
}

async function fsyncGeneratedDir() {
	const handle = await open(workerBundlerGeneratedDir, 'r')
	try {
		await handle.sync()
	} finally {
		await handle.close()
	}
}

if (isExecutedDirectly(import.meta.url)) {
	await ensureWorkerBundlerModules()
}
