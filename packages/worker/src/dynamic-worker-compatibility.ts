/**
 * Compatibility settings for dynamic Worker Loader isolates (execute sandbox and
 * package apps). Keep these aligned with `packages/worker/wrangler.jsonc`.
 *
 * `enable_request_signal` is the exception: it makes `request.signal` abort
 * when the caller disconnects, which the package app entrypoint needs to
 * report a disconnected request instead of being cancelled silently.
 * Permanent: stored data or clients from before this change still exist.
 */
export const dynamicWorkerCompatibilityDate = '2026-04-16'

export const dynamicWorkerCompatibilityFlags = [
	'nodejs_compat',
	'global_fetch_strictly_public',
	'enhanced_error_serialization',
	'enable_request_signal',
] as const

export type DynamicWorkerCompatibilityOptions = {
	compatibilityDate: string
	compatibilityFlags: Array<string>
}

export function createDynamicWorkerCompatibilityOptions(): DynamicWorkerCompatibilityOptions {
	return {
		compatibilityDate: dynamicWorkerCompatibilityDate,
		compatibilityFlags: [...dynamicWorkerCompatibilityFlags],
	}
}
