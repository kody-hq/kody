/**
 * R2 rejects any put targeting an existing object under a bucket-lock rule
 * with `put: The object is locked by the bucket policy. (10069)` before
 * evaluating conditional headers, so the `onlyIf: { etagDoesNotMatch: '*' }`
 * create-only pattern throws on locked prefixes instead of returning null.
 * The full seal treats this rejection like a failed create-only condition
 * and compares the existing object instead of retrying the put.
 */
export function isBucketLockPolicyPutError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error)
	return (
		message.includes('locked by the bucket policy') ||
		message.includes('(10069)')
	)
}
