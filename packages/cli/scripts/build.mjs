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
import { rmSync } from 'node:fs'
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
