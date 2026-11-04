#!/usr/bin/env node
// Builds dist/ as an esbuild bundle instead of one file per module.
//
// Every pure-JS dependency is bundled, so `npm install @kodycodes/cli` only
// has to fetch the packages that ship native code or platform binaries (the
// `dependencies` in package.json): fewer tarballs and a fraction of the bytes,
// which is most of what a cold `npx @kodycodes/cli` waits on. Code splitting
// keeps every `await import()` in src a separate chunk, so a command still
// loads only what it uses. `kody:*` is resolved by workerd at run time and msw
// is installed into the Kody cache on demand, so both stay unbundled.
//
// CommonJS dependencies call `require()` for Node builtins; an ESM bundle has
// no `require`, so each output file gets one from `createRequire`.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const pkg = createRequire(import.meta.url)('../package.json')

rmSync('dist', { recursive: true, force: true })

await build({
	entryPoints: ['src/bin.ts', 'src/cli.ts', 'src/skill-refresh.ts'],
	outdir: 'dist',
	bundle: true,
	splitting: true,
	format: 'esm',
	platform: 'node',
	target: 'node22',
	mainFields: ['module', 'main'],
	external: [...Object.keys(pkg.dependencies), 'msw', 'kody:*'],
	banner: {
		js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
	},
	sourcemap: true,
	sourcesContent: false,
	logLevel: 'warning',
})

// Publish offload builder: the worker's own artifact builders, served from
// a local workerd (the bundler only runs there), so a CLI or
// execution-context build makes the same bytes as a cloud rebuild. The
// worker loads its bundler from generated additional modules; here it
// resolves straight to the package. .wasm imports stay external and are
// copied beside the bundle as workerd wasm modules.
const workerGeneratedModules = {
	'worker-bundler': '@cloudflare/worker-bundler',
	'worker-bundler-typescript': '@cloudflare/worker-bundler/typescript',
}
const builderWasmDir = 'dist/publish-builder-wasm'
mkdirSync(builderWasmDir, { recursive: true })
await build({
	entryPoints: {
		'publish-builder': '../worker/src/publish-offload/builder-workerd-entry.ts',
	},
	outdir: 'dist',
	bundle: true,
	format: 'esm',
	platform: 'browser',
	conditions: ['workerd', 'worker', 'browser'],
	target: 'es2024',
	external: ['node:*', 'cloudflare:*'],
	plugins: [
		{
			name: 'wasm-modules',
			setup(pluginBuild) {
				pluginBuild.onResolve({ filter: /\.wasm$/ }, (args) => {
					const file = args.path.startsWith('.')
						? path.resolve(args.resolveDir, args.path)
						: createRequire(path.join(args.resolveDir, 'index.js')).resolve(
								args.path,
							)
					const name = path.basename(file)
					copyFileSync(file, path.join(builderWasmDir, name))
					return { path: `./${name}`, external: true }
				})
			},
		},
		{
			name: 'worker-generated-modules',
			setup(pluginBuild) {
				pluginBuild.onResolve(
					{ filter: /^\.\/generated\/.+\.mjs$/ },
					(args) => ({
						path: args.path,
						external: true,
					}),
				)
				pluginBuild.onResolve(
					{ filter: /\.kody-generated\/[^/]+\.mjs$/ },
					async (args) => {
						const name = args.path
							.replace(/^.*\.kody-generated\//, '')
							.replace(/\.mjs$/, '')
						const target = workerGeneratedModules[name]
						if (!target) return { path: args.path, external: true }
						return await pluginBuild.resolve(target, {
							kind: args.kind,
							resolveDir: '../worker',
						})
					},
				)
			},
		},
	],
	logLevel: 'warning',
})
