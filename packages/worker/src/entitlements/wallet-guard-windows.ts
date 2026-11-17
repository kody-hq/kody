export type WalletGuardCheck = {
	/** Counter identity: scope, limit key, and window in one string. */
	bucket: string
	windowMs: number
	limit: number
}

export type WalletGuardAdmission =
	| { admitted: true }
	| {
			admitted: false
			bucket: string
			limit: number
			windowMs: number
			retryAfterMs: number
	  }

export type WalletGuardWindowStore = {
	read: (bucket: string) => { windowStart: number; count: number } | null
	write: (bucket: string, windowStart: number, count: number) => void
}

/**
 * `admit` checks and counts in one step. `check` only checks, for callers
 * that count later with `record` once they know the call was real (a git
 * request the upstream accepted, an execute the other brakes admitted).
 */
export type WalletGuardMode = 'admit' | 'check' | 'record'

/**
 * Fixed windows aligned to the UTC clock. A call is admitted only when
 * every check has room, and only an admitted call is counted, so a refused
 * caller that keeps retrying never extends its own lockout.
 */
export function admitWalletGuardInWindows(input: {
	nowMs: number
	checks: ReadonlyArray<WalletGuardCheck>
	store: WalletGuardWindowStore
	mode?: WalletGuardMode
}): WalletGuardAdmission {
	const mode = input.mode ?? 'admit'
	const current = input.checks.map((check) => {
		const windowStart =
			Math.floor(input.nowMs / check.windowMs) * check.windowMs
		const stored = input.store.read(check.bucket)
		const count =
			stored && stored.windowStart === windowStart ? stored.count : 0
		return { check, windowStart, count }
	})
	for (const { check, windowStart, count } of current) {
		if (mode !== 'record' && count >= check.limit) {
			return {
				admitted: false,
				bucket: check.bucket,
				limit: check.limit,
				windowMs: check.windowMs,
				retryAfterMs: Math.max(1, windowStart + check.windowMs - input.nowMs),
			}
		}
	}
	if (mode === 'check') return { admitted: true }
	for (const { check, windowStart, count } of current) {
		input.store.write(check.bucket, windowStart, count + 1)
	}
	return { admitted: true }
}
