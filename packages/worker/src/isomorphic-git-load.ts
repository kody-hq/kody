import { isolateMemo } from '#worker/isolate-memo.ts'
/**
 * Load isomorphic-git (and `@cloudflare/shell/git`'s `createGit`) from the
 * deferred additional module. Specifier must stay
 * `./node_modules/.kody-generated/…` relative to `packages/worker/src` so
 * Wrangler matches the ESModule rule (same trap as oauth-provider /
 * local-execute-runtime-support / worker-bundler). Callers under `repo/` must
 * not import the `.mjs` with a `../` path — that inlines the module into the
 * main entry.
 *
 * Type the payload with `typeof import(...)` queries only. A top-level
 * `import type` from `isomorphic-git` / `isomorphic-git/http/web` /
 * `@cloudflare/shell/git` still lands those packages in Wrangler's main
 * source map (forbidden by the startup-bundle check) even when erased at
 * runtime.
 */

export type IsomorphicGit = {
	git: typeof import('isomorphic-git').default
	http: typeof import('isomorphic-git/http/web').default
	createGit: typeof import('@cloudflare/shell/git').createGit
}

/**
 * isomorphic-git builds large lookup tables when its module evaluates. Every
 * git operation runs inside an async repo call, so the library loads on first
 * use and is cached for the isolate.
 *
 * Wrangler inlines ordinary `import('isomorphic-git')` and
 * `import('@cloudflare/shell/git')` into the worker main module (bytes count
 * toward the startup budget even when evaluation is deferred). Load the
 * pre-bundled additional module instead. Import this helper; never import
 * those packages on the startup path.
 */
export const loadIsomorphicGit: () => Promise<IsomorphicGit> = isolateMemo(
	() =>
		import('./node_modules/.kody-generated/isomorphic-git.mjs') as Promise<IsomorphicGit>,
)
