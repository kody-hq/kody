/**
 * Load local-execute rewrite + shim builders from the deferred additional
 * module. Specifier must stay `./node_modules/.kody-generated/…` relative to
 * `packages/worker/src` so Wrangler matches the ESModule rule (same trap as
 * oauth-provider / worker-bundler). Callers under `package-runtime/` must not
 * import the `.mjs` with a `../` path — that inlines the module into the main
 * entry.
 */

export type LocalExecuteRuntimeSupport = {
	rewriteInlinedLocalExecuteBundleSource: (input: {
		modulePath: string
		source: string
		primaryRuntimePath: string
	}) => Promise<{
		source: string
		rewritten: boolean
		packageId: string | null
	}>
	createLocalExecuteRuntimeShimSource: (
		modulePath?: string,
		options?: { packageBindings?: Record<string, string> },
	) => string
	createLocalExecutePackageRuntimeModuleSource: (packageId: string) => string
}

let localExecuteRuntimeSupportPromise: Promise<LocalExecuteRuntimeSupport> | null =
	null

export function loadLocalExecuteRuntimeSupport() {
	localExecuteRuntimeSupportPromise ??=
		import('./node_modules/.kody-generated/local-execute-runtime-support.mjs') as Promise<LocalExecuteRuntimeSupport>
	return localExecuteRuntimeSupportPromise
}
