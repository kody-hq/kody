/**
 * Shared retry schedule for backup R2 calls, both the S3 API client the main
 * worker's DR lanes use and the R2 binding wrapper in the backup control
 * plane. R2 5xx / InternalError bursts routinely last a few seconds (KODY-E0
 * saw HEADs fail for about 1.5 s per key), so the schedule spans roughly 4 to
 * 8 s of backoff before giving up. That keeps a persistent outage bounded to
 * well under the ~45 s DR export tick budget per call.
 */
export const backupR2RetryMaxAttempts = 6

export const backupR2RetryBaseDelayMs = 250

/**
 * Equal-jitter exponential backoff before retry `attempt + 1`: half of the
 * doubling ceiling is fixed and half is random, so concurrent lanes hitting
 * the same R2 burst do not retry in step.
 */
export function backupR2RetryDelayMs(
	attempt: number,
	baseDelayMs: number = backupR2RetryBaseDelayMs,
) {
	const ceiling = baseDelayMs * 2 ** (attempt - 1)
	return ceiling / 2 + Math.random() * (ceiling / 2)
}
