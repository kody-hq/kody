import { BackupError } from './backup-policy.ts'

/**
 * Cloudflare fails every binding call after a Worker invocation exceeds its
 * subrequest limit (R2, D1, KV, and Durable Object calls all count), with this
 * message and no error code.
 * @see https://developers.cloudflare.com/workers/platform/limits/#subrequests
 */
export function isWorkerSubrequestLimitError(error: unknown): boolean {
	return (
		error instanceof Error &&
		error.message.includes('Too many API requests by single Worker invocation')
	)
}

export type R2CallBudget = {
	bucket: R2Bucket
	used: () => number
}

/**
 * Counts every R2 binding call made through `bucket` and refuses calls past
 * `limit` with `r2-call-budget-exhausted`, so a long scan stops cleanly
 * below the platform limit instead of having every later call fail.
 */
export function createR2CallBudget(
	bucket: R2Bucket,
	limit: number,
): R2CallBudget {
	let used = 0
	const spend = () => {
		if (used >= limit) {
			throw new BackupError(
				'r2-call-budget-exhausted',
				`R2 call budget of ${limit} calls is spent`,
			)
		}
		used += 1
	}
	return {
		used: () => used,
		bucket: {
			head: async (key) => {
				spend()
				return bucket.head(key)
			},
			get: (async (key: string, options?: R2GetOptions) => {
				spend()
				return bucket.get(key, options)
			}) as R2Bucket['get'],
			put: (async (
				key: string,
				value: Parameters<R2Bucket['put']>[1],
				options?: R2PutOptions,
			) => {
				spend()
				return bucket.put(key, value, options)
			}) as R2Bucket['put'],
			delete: async (keys) => {
				spend()
				return bucket.delete(keys)
			},
			list: async (options) => {
				spend()
				return bucket.list(options)
			},
			createMultipartUpload: async (key, options) => {
				spend()
				return bucket.createMultipartUpload(key, options)
			},
			resumeMultipartUpload: (key, uploadId) =>
				bucket.resumeMultipartUpload(key, uploadId),
		},
	}
}
