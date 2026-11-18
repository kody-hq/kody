/**
 * Load codemode's `normalizeCode` from the deferred additional module.
 * Specifier must stay `./node_modules/.kody-generated/…` relative to
 * `packages/worker/src` so Wrangler matches the ESModule rule (same trap as
 * `isomorphic-git-load.ts`). Never import `normalizeCode` from
 * `@cloudflare/codemode` on the Worker graph: it is the only export that uses
 * acorn, and `patches/acorn+*.patch` marks acorn side-effect free so esbuild
 * drops it from Wrangler main when nothing else references it.
 *
 * Type the payload with a `typeof import(...)` query only; esbuild walks a
 * top-level `import type` edge.
 */

export type NormalizeCode = typeof import('@cloudflare/codemode').normalizeCode

let memo: Promise<NormalizeCode> | null = null

export function loadNormalizeCode(): Promise<NormalizeCode> {
	memo ??= import('./node_modules/.kody-generated/codemode-normalize.mjs').then(
		(module) => module.normalizeCode,
		(error: unknown) => {
			memo = null
			throw error
		},
	)
	return memo
}

export type ParseJavaScript = typeof import('acorn').parse

let parserMemo: Promise<ParseJavaScript> | null = null

/** Acorn's `parse`, from the same deferred module as `normalizeCode`. */
export function loadJavaScriptParser(): Promise<ParseJavaScript> {
	parserMemo ??=
		import('./node_modules/.kody-generated/codemode-normalize.mjs').then(
			(module) => module.parseJavaScript,
			(error: unknown) => {
				parserMemo = null
				throw error
			},
		)
	return parserMemo
}
