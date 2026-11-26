import { isolateMemo } from '#worker/isolate-memo.ts'
/**
 * Load postal-mime from the deferred additional module. Specifier must stay
 * `./node_modules/.kody-generated/…` relative to `packages/worker/src` so
 * Wrangler matches the ESModule rule (same trap as `isomorphic-git-load.ts`).
 * Callers under `email/` must not import the `.mjs` with a `../` path — that
 * inlines the module into the main entry.
 *
 * Type the payload with `typeof import(...)` queries only. esbuild still walks
 * a top-level `import type` from `postal-mime` (or `email/postal-mime-module.ts`)
 * and keeps the package's side-effecting module code in Wrangler main.
 */

export type PostalMimeParser = typeof import('postal-mime').default
export type PostalMimeAddress = import('postal-mime').Address
export type PostalMimeAttachment = import('postal-mime').Attachment

/**
 * Every MIME parse is already async (inbound delivery, attachment reads), so
 * the parser loads on first use and is cached for the isolate.
 */
export const loadPostalMime: () => Promise<PostalMimeParser> = isolateMemo(() =>
	import('./node_modules/.kody-generated/postal-mime.mjs').then(
		(module) => module.PostalMime,
	),
)
