import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Feature-flag reads shared by one execution's fetch gateway calls (KODY-CS).
 * Each `KodyFetchGateway` call gets freshly deserialized props, so the
 * request-keyed memos never hit across an execution's fetches. The host mints
 * one `executionId` per run; gateway calls in this isolate that carry it reuse
 * flag results, and the next execution gets a new id and reads D1 again.
 * Scopes idle past the TTL (or beyond the cap) are dropped.
 *
 * Only settled values cross gateway calls. Each gateway call is its own
 * Workers request, and a request that awaits a promise another request is
 * still resolving has no I/O of its own, so the runtime cancels it as hung.
 * Concurrent calls each run their own read; one call's reads share in-flight.
 */
const executionIdleTtlMs = 5 * 60_000
const maxExecutions = 1_000

type SettledReads = Map<string, { value: unknown }>

type CallReads = {
	settled: SettledReads
	inFlight: Map<string, Promise<unknown>>
}

const readsByExecution = new Map<
	string,
	{ settled: SettledReads; expiresAtMs: number }
>()
const callReadsStorage = new AsyncLocalStorage<CallReads>()

/** Runs one gateway call in its execution's scope. */
export function runInFeatureFlagExecution<Result>(
	executionId: string | null | undefined,
	run: () => Result,
): Result {
	if (!executionId) return run()
	const nowMs = Date.now()
	const existing = readsByExecution.get(executionId)
	const settled: SettledReads =
		existing && existing.expiresAtMs > nowMs ? existing.settled : new Map()
	// Re-insert so iteration order is least recently used first.
	readsByExecution.delete(executionId)
	readsByExecution.set(executionId, {
		settled,
		expiresAtMs: nowMs + executionIdleTtlMs,
	})
	for (const [id, entry] of readsByExecution) {
		if (readsByExecution.size <= maxExecutions && entry.expiresAtMs > nowMs) {
			break
		}
		readsByExecution.delete(id)
	}
	return callReadsStorage.run({ settled, inFlight: new Map() }, run)
}

/**
 * Reuses `load`'s result for `key` within the current
 * {@link runInFeatureFlagExecution} scope; loads every time outside one.
 * Failures are not kept, so the next call retries.
 */
export function memoizeForFeatureFlagExecution<Value>(
	key: string,
	load: () => Promise<Value>,
): Promise<Value> {
	const reads = callReadsStorage.getStore()
	if (!reads) return load()
	const settled = reads.settled.get(key)
	if (settled) return Promise.resolve(settled.value as Value)
	const pending = reads.inFlight.get(key) as Promise<Value> | undefined
	if (pending) return pending
	const value = load()
	reads.inFlight.set(key, value)
	value.then(
		(result) => {
			reads.settled.set(key, { value: result })
			reads.inFlight.delete(key)
		},
		() => {
			reads.inFlight.delete(key)
		},
	)
	return value
}
