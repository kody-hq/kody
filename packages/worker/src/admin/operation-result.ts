export class AdminOperationError extends Error {
	readonly status: number
	readonly data: { ok: false; error: string; code?: string }
	constructor(
		message: string,
		status: number,
		data: { ok: false; error: string; code?: string } = {
			ok: false,
			error: message,
		},
	) {
		super(message)
		this.status = status
		this.data = data
	}
}

/** Domain results stay plain data. HTTP and server functions choose their own transport. */
export function adminOperationResult<T>(value: T): T
export function adminOperationResult<T extends { ok: false; error: string }>(
	value: T,
	status: number,
): never
export function adminOperationResult<T>(value: T, status?: number): T {
	if (status !== undefined && status >= 400) {
		throw new AdminOperationError(
			(value as { error: string }).error,
			status,
			value as { ok: false; error: string; code?: string },
		)
	}
	return value
}
