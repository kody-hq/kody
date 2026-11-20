import type { Clock } from '#worker/scheduled/retention/clock.ts'

type Timer = { at: number; seq: number; callback: () => void }

export type ManualClock = Clock & {
	/** Advances time, firing due timers in order and flushing microtasks. */
	advance(ms: number): Promise<void>
	pendingTimers(): number
}

export function createManualClock(start: Date | string): ManualClock {
	let nowMs = new Date(start).getTime()
	let seq = 0
	let timers: Array<Timer> = []
	const flush = async () => {
		for (let i = 0; i < 10; i++) await Promise.resolve()
	}
	return {
		now: () => new Date(nowMs),
		nowMs: () => nowMs,
		setTimer(ms, callback) {
			const timer = { at: nowMs + Math.max(0, ms), seq: seq++, callback }
			timers.push(timer)
			return () => {
				timers = timers.filter((entry) => entry !== timer)
			}
		},
		async advance(ms) {
			const target = nowMs + ms
			await flush()
			for (;;) {
				const next = timers
					.filter((timer) => timer.at <= target)
					.sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
				if (!next) break
				timers = timers.filter((timer) => timer !== next)
				nowMs = next.at
				next.callback()
				await flush()
			}
			nowMs = target
			await flush()
		},
		pendingTimers: () => timers.length,
	}
}
