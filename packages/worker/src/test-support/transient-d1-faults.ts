import type { LaneClock } from '#worker/scheduled/transient-d1-retry.ts'

export const transientD1Message = 'D1_ERROR: Network connection lost.'

/** Lane clock whose `sleep` advances `now` instantly and records each delay. */
export function createFakeLaneClock(startMs = 1_000_000) {
	let nowMs = startMs
	const sleeps: Array<number> = []
	const clock: LaneClock = {
		now: () => nowMs,
		sleep: async (ms) => {
			sleeps.push(ms)
			nowMs += ms
		},
	}
	return { clock, sleeps, elapsedMs: () => nowMs - startMs }
}

export type D1Fault = {
	/** Statement query and bound params; a batch faults when any statement matches. */
	match: (query: string, params: ReadonlyArray<unknown>) => boolean
	/** Fault statement calls (`run`/`all`/`first`/`raw`) or whole batches. */
	target: 'statement' | 'batch'
	failures: number
	message?: string
}

/**
 * Wraps a test D1 so matching statements or batches throw before reaching
 * SQLite, `failures` times each. `attempts(fault)` counts every matching call,
 * including the ones that succeeded.
 */
export function withD1Faults(db: D1Database, faults: Array<D1Fault>) {
	const remaining = new Map(faults.map((fault) => [fault, fault.failures]))
	const attemptCounts = new Map(faults.map((fault) => [fault, 0]))
	const originals = new WeakMap<object, D1PreparedStatement>()
	const described = new WeakMap<
		object,
		{ query: string; params: ReadonlyArray<unknown> }
	>()

	function trip(
		target: D1Fault['target'],
		calls: Array<{ query: string; params: ReadonlyArray<unknown> }>,
	) {
		for (const fault of faults) {
			if (fault.target !== target) continue
			if (!calls.some((call) => fault.match(call.query, call.params))) continue
			attemptCounts.set(fault, (attemptCounts.get(fault) ?? 0) + 1)
			const left = remaining.get(fault) ?? 0
			if (left > 0) {
				remaining.set(fault, left - 1)
				throw new Error(fault.message ?? transientD1Message)
			}
		}
	}

	function wrapStatement(
		statement: D1PreparedStatement,
		query: string,
		params: ReadonlyArray<unknown>,
	): D1PreparedStatement {
		const wrapped = new Proxy(statement, {
			get(target, property) {
				const value: unknown = Reflect.get(target, property, target)
				if (typeof value !== 'function') return value
				if (property === 'bind') {
					return (...args: Array<unknown>) =>
						wrapStatement(Reflect.apply(value, target, args), query, args)
				}
				if (['run', 'all', 'first', 'raw'].includes(String(property))) {
					return async (...args: Array<unknown>) => {
						trip('statement', [{ query, params }])
						return Reflect.apply(value, target, args)
					}
				}
				return value.bind(target)
			},
		})
		originals.set(wrapped, statement)
		described.set(wrapped, { query, params })
		return wrapped
	}

	const faulty = new Proxy(db, {
		get(target, property) {
			const value: unknown = Reflect.get(target, property, target)
			if (typeof value !== 'function') return value
			if (property === 'prepare') {
				return (query: string) =>
					wrapStatement(Reflect.apply(value, target, [query]), query, [])
			}
			if (property === 'batch') {
				return async (statements: Array<D1PreparedStatement>) => {
					trip(
						'batch',
						statements.flatMap((statement) => {
							const call = described.get(statement)
							return call ? [call] : []
						}),
					)
					return Reflect.apply(value, target, [
						statements.map(
							(statement) => originals.get(statement) ?? statement,
						),
					])
				}
			}
			return value.bind(target)
		},
	})
	return {
		db: faulty,
		attempts: (fault: D1Fault) => attemptCounts.get(fault) ?? 0,
	}
}
