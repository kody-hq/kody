/**
 * R2 rejects any put targeting an existing object under a bucket-lock rule
 * with `put: The object is locked by the bucket policy. (10069)` before
 * evaluating conditional headers, so the `onlyIf: { etagDoesNotMatch: '*' }`
 * create-only pattern throws on locked prefixes instead of returning null.
 * Verified live 2026-07-28: sealing wedged hourly on the locked `daily/`
 * prefix. Treat the rejection as "object already exists" so retries and
 * replays fall through to byte comparison.
 */
export function isBucketLockPolicyPutError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error)
	return (
		message.includes('locked by the bucket policy') ||
		message.includes('(10069)')
	)
}
