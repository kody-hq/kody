/**
 * Hosted MCP clients stop waiting on tools/call after about 60s and surface
 * JSON-RPC -32001 ("Request timed out"). Progress notifications do not reset
 * that clock. Return a follow handle before the client gives up.
 */
export const hostedExecuteTransportBudgetMs = 45_000

/**
 * Open API `/v1/execute` callers (the CLI) are not MCP clients with a 60s
 * tools/call deadline, so they wait out the whole 90s sandbox budget plus
 * setup instead of getting a follow handle for work that would then have to
 * finish inside `waitUntil`.
 */
export const openApiExecuteTransportBudgetMs = 105_000

/**
 * A plain Worker request (stateless MCP lane, Open API) keeps `waitUntil`
 * work alive for about 30s after the response. A run still going at the
 * transport budget is stopped this long after the follow response, while the
 * isolate can still record a timeout, instead of being cut off mid-flight and
 * left `running` until stale reconciliation marks it `platform_interrupted`.
 */
export const detachedExecuteWorkLimitMs = 20_000

const defaultExecuteIdempotencyKeyPrefix = 'execute:'

/** Server-assigned retry token when the caller did not pass one. */
export function createDefaultExecuteIdempotencyKey() {
	return `${defaultExecuteIdempotencyKeyPrefix}${crypto.randomUUID()}`
}

export function remainingTransportBudgetMs(input: {
	startedAtMs: number
	nowMs?: number
	budgetMs?: number
}) {
	const budget = input.budgetMs ?? hostedExecuteTransportBudgetMs
	const elapsed = (input.nowMs ?? performance.now()) - input.startedAtMs
	if (!Number.isFinite(elapsed)) return budget
	return Math.max(0, budget - elapsed)
}

export type DetachableAbortSignal = {
	signal: AbortSignal
	/**
	 * Stop forwarding upstream aborts. Call this before returning a follow
	 * handle so completing the HTTP response does not cancel the sandbox.
	 */
	detach: () => void
	/** Abort the sandbox directly, even after `detach`. */
	abort: (reason: unknown) => void
}

/**
 * Abort `signal` when `upstream` aborts, until `detach`. A caller cancel
 * before the transport budget still stops the sandbox. The abort that follows
 * an intentional early return does not.
 */
export function createDetachableAbortSignal(
	upstream: AbortSignal | undefined,
): DetachableAbortSignal {
	const controller = new AbortController()
	if (!upstream) {
		return {
			signal: controller.signal,
			detach() {},
			abort(reason) {
				if (!controller.signal.aborted) controller.abort(reason)
			},
		}
	}
	let detached = false
	const forward = () => {
		if (detached || controller.signal.aborted) return
		const reason: unknown = upstream.reason
		if (reason === undefined) {
			controller.abort()
			return
		}
		controller.abort(reason)
	}
	if (upstream.aborted) forward()
	else upstream.addEventListener('abort', forward)
	return {
		signal: controller.signal,
		detach() {
			detached = true
			upstream.removeEventListener('abort', forward)
		},
		abort(reason) {
			if (!controller.signal.aborted) controller.abort(reason)
		},
	}
}

export type TransportBudgetRace<T> =
	| { kind: 'settled'; value: T }
	| { kind: 'rejected'; error: unknown }
	| { kind: 'budget' }

/**
 * Settle with the work's outcome, or with `budget` when `budgetMs` elapses
 * first. The work promise is left running either way. Rejections are returned
 * as `rejected` so a budget win cannot leave a later rejection unhandled.
 */
export async function raceWithTransportBudget<T>(
	work: Promise<T>,
	budgetMs: number,
): Promise<TransportBudgetRace<T>> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const tracked = work.then(
		(value) => ({ settled: true as const, value }),
		(error: unknown) => ({ settled: false as const, error }),
	)
	try {
		return await Promise.race([
			tracked.then((outcome) =>
				outcome.settled
					? { kind: 'settled' as const, value: outcome.value }
					: { kind: 'rejected' as const, error: outcome.error },
			),
			new Promise<TransportBudgetRace<T>>((resolve) => {
				timer = setTimeout(
					() => resolve({ kind: 'budget' }),
					Math.max(0, budgetMs),
				)
			}),
		])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

export type TransportWorkPeek<T> =
	| { ok: true; value: T }
	| { ok: false; error: unknown }

/**
 * Race `work` against the budget and remember a same-turn settlement so the
 * caller can prefer a finished module over a follow handle.
 */
export function watchExecuteTransport<T>(work: Promise<T>, budgetMs: number) {
	let latest: TransportWorkPeek<T> | null = null
	void work.then(
		(value) => {
			latest = { ok: true, value }
		},
		(error: unknown) => {
			latest = { ok: false, error }
		},
	)
	return {
		raced: raceWithTransportBudget(work, budgetMs),
		peek() {
			return latest
		},
	}
}
