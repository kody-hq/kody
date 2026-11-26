import { isolateMemo } from '#worker/isolate-memo.ts'
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

export const loadNormalizeCode: () => Promise<NormalizeCode> = isolateMemo(() =>
	import('./node_modules/.kody-generated/codemode-normalize.mjs').then(
		(module) => module.normalizeCode,
	),
)

export type ParseJavaScript = typeof import('acorn').parse

/** Acorn's `parse`, from the same deferred module as `normalizeCode`. */
export const loadJavaScriptParser: () => Promise<ParseJavaScript> = isolateMemo(
	() =>
		import('./node_modules/.kody-generated/codemode-normalize.mjs').then(
			(module) => module.parseJavaScript,
		),
)
