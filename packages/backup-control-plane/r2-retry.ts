import { BackupError } from './backup-policy.ts'
import type { BackupEnvironment } from './backup-types.ts'

/**
 * R2 Workers API service errors Cloudflare documents as retryable: 10001
 * InternalError, 10043 ServiceUnavailable, 10054 ClientDisconnect, 10058
 * TooManyRequests. The binding puts the code at the end of the message, e.g.
 * `put: We encountered an internal error. Please try again. (10001)`.
 * @see https://developers.cloudflare.com/r2/api/error-codes/#service-errors
 */
const retryableR2PlatformErrorPattern = /\((?:10001|10043|10054|10058)\)$/u

function isRetryableR2PlatformError(error: unknown): boolean {
	return (
		error instanceof Error &&
		retryableR2PlatformErrorPattern.test(error.message.trim())
	)
}

export type R2RetryOptions = {
	attempts?: number
	baseDelayMs?: number
}

const defaultAttempts = 3
const defaultBaseDelayMs = 250

async function retryR2PlatformErrors<T>(
	operation: string,
	run: () => Promise<T>,
	options: R2RetryOptions,
): Promise<T> {
	const attempts = options.attempts ?? defaultAttempts
	const baseDelayMs = options.baseDelayMs ?? defaultBaseDelayMs
	for (let attempt = 1; ; attempt += 1) {
		try {
			return await run()
		} catch (error) {
			if (!isRetryableR2PlatformError(error)) throw error
			if (attempt >= attempts) {
				throw new BackupError(
					'r2-platform-error',
					`R2 ${operation} still failing after ${attempts} attempts: ${(error as Error).message}`,
					true,
				)
			}
			// Equal jitter: half fixed, half random, doubling each attempt.
			const ceiling = baseDelayMs * 2 ** (attempt - 1)
			const delayMs = ceiling / 2 + Math.random() * (ceiling / 2)
			await new Promise((resolve) => setTimeout(resolve, delayMs))
		}
	}
}

type R2PutValue = Parameters<R2Bucket['put']>[1]

/** A stream is consumed by the first attempt, so only buffered bodies replay. */
function isReplayablePutValue(value: R2PutValue): boolean {
	return !(value instanceof ReadableStream)
}

/**
 * Wraps a bucket so every head/get/list/delete, and every put with a buffered
 * body, retries documented transient R2 platform errors with jittered
 * backoff. Logical errors (bucket lock 10069, precondition, missing keys)
 * pass through on the first attempt. Puts are safe to replay: backup writes
 * are create-only (`etagDoesNotMatch: '*'`) on locked prefixes with
 * deterministic bytes, and the remaining writes overwrite a fixed key with
 * the same body.
 */
export function retryingR2Bucket(
	bucket: R2Bucket,
	options: R2RetryOptions = {},
): R2Bucket {
	const retry = <T>(operation: string, run: () => Promise<T>) =>
		retryR2PlatformErrors(operation, run, options)
	return {
		head: (key) => retry('head', () => bucket.head(key)),
		get: ((key: string, getOptions?: R2GetOptions) =>
			retry('get', () => bucket.get(key, getOptions))) as R2Bucket['get'],
		put: ((key: string, value: R2PutValue, putOptions?: R2PutOptions) =>
			isReplayablePutValue(value)
				? retry('put', () => bucket.put(key, value, putOptions))
				: bucket.put(key, value, putOptions)) as R2Bucket['put'],
		delete: (keys) => retry('delete', () => bucket.delete(keys)),
		list: (listOptions) => retry('list', () => bucket.list(listOptions)),
		createMultipartUpload: (key, multipartOptions) =>
			bucket.createMultipartUpload(key, multipartOptions),
		resumeMultipartUpload: (key, uploadId) =>
			bucket.resumeMultipartUpload(key, uploadId),
	}
}

export function withRetryingBackupBucket(
	env: BackupEnvironment,
): BackupEnvironment {
	return { ...env, BACKUP_BUCKET: retryingR2Bucket(env.BACKUP_BUCKET) }
}
