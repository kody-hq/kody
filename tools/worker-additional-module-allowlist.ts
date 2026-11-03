/**
 * Filenames Wrangler may upload from `packages/worker/src` via
 * `find_additional_modules`. The three worker `wrangler.jsonc` files name
 * these files exactly. A `*.mjs` glob also uploads a stray file left in
 * `node_modules/.kody-generated/` (Friction #2504).
 *
 * Both spellings are required: the bare path matches the on-disk walk, and
 * the `./` path matches the import specifier (Wrangler's specifier matcher
 * has no globstar). The `node_modules/` prefix stays so the directory
 * watcher skips these files (Friction #1789).
 */

export const guideGeneratedModuleNames = [
	'guide-catalog.mjs',
	'guide-metadata.mjs',
] as const

export const kodyGeneratedEsModuleNames = [
	'worker-bundler.mjs',
	'worker-bundler-typescript.mjs',
	'oauth-provider.mjs',
	'local-execute-runtime-support.mjs',
	'isomorphic-git.mjs',
	'postal-mime.mjs',
	'codemode-normalize.mjs',
	'disposable-email-domains.mjs',
] as const

export const kodyGeneratedWasmNames = ['esbuild.wasm'] as const

/** Planted by the startup-bundle check. Never an allowlisted upload name. */
export const strayKodyGeneratedModuleName = 'stray-experiment.mjs'

export const wranglerAdditionalModuleConfigPaths = [
	'packages/worker/wrangler.jsonc',
	'packages/platform-worker/wrangler.jsonc',
	'packages/runtime-worker/wrangler.jsonc',
] as const

export function expectedKodyGeneratedUploadNames() {
	return [...kodyGeneratedEsModuleNames, ...kodyGeneratedWasmNames]
}
