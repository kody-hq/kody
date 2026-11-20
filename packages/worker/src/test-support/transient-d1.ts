import * as Sentry from '@sentry/cloudflare'
import { vi } from 'vitest'

/**
 * Fails each attempt of a matching statement (inside a batch too) with the
 * next queued D1 error message; `undefined` or an empty queue lets it through.
 * Counts the attempts it saw.
 */
export function withD1Failures(
	db: D1Database,
	matches: (query: string) => boolean,
	messages: Array<string | undefined>,
) {
	const queued = [...messages]
	const failNext = () => {
		attempts.count++
		const message = queued.shift()
		if (message !== undefined) throw new Error(message)
	}
	const attempts = { count: 0 }
	const originalPrepare = db.prepare.bind(db)
	const wrapped = {
		...db,
		prepare(query: string) {
			const statement = originalPrepare(query)
			if (!matches(query)) return statement
			return {
				...statement,
				bind(...params: Array<unknown>) {
					const bound = statement.bind(...params)
					return {
						...bound,
						async run() {
							failNext()
							return bound.run()
						},
						async all<T>() {
							failNext()
							return bound.all<T>()
						},
						async first<T>() {
							failNext()
							return bound.first<T>()
						},
					}
				},
			}
		},
	} as D1Database
	return { db: wrapped, attempts }
}

const realSetTimeout = globalThis.setTimeout
/** Longest D1 retry backoff; longer timers are D1/outbound timeouts. */
const longestBackoffMs = 400

/**
 * Runs a pass on fake timers so retry backoff never really sleeps. Fake time
 * moves only while a backoff-length (or shorter) timer is pending and real
 * async work (hashing, I/O) has had a turn, so timeouts never fire and
 * `elapsedMs` is exactly the backoff the pass slept.
 */
export async function onFakeClock<T>(now: Date, run: () => Promise<T>) {
	vi.useFakeTimers({ now })
	const fakeSetTimeout = globalThis.setTimeout
	const fakeClearTimeout = globalThis.clearTimeout
	const shortTimers = new Set<unknown>()
	globalThis.setTimeout = ((
		callback: (...args: Array<unknown>) => void,
		ms = 0,
		...args: Array<unknown>
	) => {
		const id = fakeSetTimeout(() => {
			shortTimers.delete(id)
			callback(...args)
		}, ms)
		if (ms <= longestBackoffMs) shortTimers.add(id)
		return id
	}) as typeof setTimeout
	globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
		shortTimers.delete(id)
		fakeClearTimeout(id)
	}) as typeof clearTimeout
	try {
		const startedAt = Date.now()
		let settledAt: number | undefined
		const pass = run().finally(() => {
			settledAt = Date.now()
		})
		for (;;) {
			await new Promise((resolve) => realSetTimeout(resolve, 1))
			if (settledAt !== undefined) break
			if (shortTimers.size > 0) await vi.advanceTimersToNextTimerAsync()
		}
		return { result: await pass, elapsedMs: settledAt - startedAt }
	} finally {
		vi.useRealTimers()
	}
}

export function captureSentryExceptions() {
	vi.spyOn(Sentry, 'isInitialized').mockReturnValue(true)
	vi.spyOn(Sentry, 'getClient').mockReturnValue({
		getOptions: () => ({ dsn: 'https://key@sentry.invalid/1' }),
	} as never)
	return vi.spyOn(Sentry, 'captureException').mockReturnValue('event-id')
}
