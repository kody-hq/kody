/**
 * Expected "you may not do that here" outcome for website pages and server
 * functions. Route error components render it as a 403 explainer and the
 * browser Sentry client drops it. Start serializes it with
 * `permissionDeniedSerializationAdapter` so the name and permission survive
 * SSR dehydration and server-function responses (plain errors keep only
 * `message`).
 */
const permissionDeniedErrorName = 'PermissionDeniedError'

export class PermissionDeniedError extends Error {
	readonly status = 403
	readonly permission: string | null

	constructor(
		message: string,
		options?: { permission?: string | null; cause?: unknown },
	) {
		super(message, { cause: options?.cause })
		this.name = permissionDeniedErrorName
		this.permission = options?.permission ?? null
	}
}

/**
 * Our denial, or the server's `AuthorizationError` (an expected caller outcome)
 * before Start serializes it. Name checks avoid importing worker-only code.
 */
export function isPermissionDeniedError(error: unknown): error is Error {
	return (
		error instanceof Error &&
		(error.name === permissionDeniedErrorName ||
			error.name === 'AuthorizationError')
	)
}

/** Grantable permission (e.g. `email:read`), or null for role-gated pages. */
export function readDeniedPermission(error: Error) {
	const permission = 'permission' in error ? error.permission : null
	return typeof permission === 'string' ? permission : null
}

export function toPermissionDeniedPayload(error: Error) {
	return { message: error.message, permission: readDeniedPermission(error) }
}

/** 403 only when every route failure is a denial; any other failure stays 500. */
export function isOnlyPermissionDenied(errors: ReadonlyArray<unknown>) {
	return errors.length > 0 && errors.every(isPermissionDeniedError)
}
