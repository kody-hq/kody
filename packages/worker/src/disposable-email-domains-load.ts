/**
 * Loads the disposable email domain list from its additional module so the
 * ~160 KB list stays off the platform/runtime startup graph. The specifier is
 * `./node_modules/.kody-generated/…` relative to `packages/worker/src`, like
 * `postal-mime-load.ts`.
 */
let memo: Promise<ReadonlySet<string>> | null = null

export function loadDisposableEmailDomains(): Promise<ReadonlySet<string>> {
	memo ??=
		import('./node_modules/.kody-generated/disposable-email-domains.mjs').then(
			(module) => new Set<string>(module.disposableEmailDomainList),
			(error: unknown) => {
				memo = null
				throw error
			},
		)
	return memo
}
