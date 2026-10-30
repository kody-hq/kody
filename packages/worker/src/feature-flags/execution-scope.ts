import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Feature-flag reads shared by one execution's fetch gateway calls (KODY-CS).
 * Each `KodyFetchGateway` call gets freshly deserialized props, so the
 * request-keyed memos never hit across an execution's fetches. The host mints
 * one `executionId` per run; gateway calls in this isolate that carry it reuse
 * flag results, and the next execution gets a new id and reads D1 again.
 * Scopes idle past the TTL (or beyond the cap) are dropped.
 */
const executionIdleTtlMs = 5 * 60_000
const maxExecutions = 1_000

type ExecutionReads = Map<string, Promise<unknown>>

const readsByExecution = new Map<
	string,
	{ reads: ExecutionReads; expiresAtMs: number }
>()
const executionReadsStorage = new AsyncLocalStorage<ExecutionReads>()

export function runInFeatureFlagExecution<Result>(
	executionId: string | null | undefined,
	run: () => Result,
): Result {
	if (!executionId) return run()
	const nowMs = Date.now()
	const existing = readsByExecution.get(executionId)
	const reads =
		existing && existing.expiresAtMs > nowMs ? existing.reads : new Map()
	// Re-insert so iteration order is least recently used first.
	readsByExecution.delete(executionId)
	readsByExecution.set(executionId, {
		reads,
		expiresAtMs: nowMs + executionIdleTtlMs,
	})
	for (const [id, entry] of readsByExecution) {
		if (readsByExecution.size <= maxExecutions && entry.expiresAtMs > nowMs) {
			break
		}
		readsByExecution.delete(id)
	}
	return executionReadsStorage.run(reads, run)
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
	const reads = executionReadsStorage.getStore()
	if (!reads) return load()
	const existing = reads.get(key) as Promise<Value> | undefined
	if (existing) return existing
	const value = load()
	reads.set(key, value)
	value.catch(() => {
		if (reads.get(key) === value) reads.delete(key)
	})
	return value
}
