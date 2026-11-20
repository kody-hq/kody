import { useMemo, useSyncExternalStore } from 'react'

/** Re-render every `intervalMs` with the current time. */
export function useNow(intervalMs: number) {
	const clock = useMemo(() => createClock(intervalMs), [intervalMs])
	return useSyncExternalStore(clock.subscribe, clock.read, clock.read)
}

function createClock(intervalMs: number) {
	let now = Date.now()
	return {
		read: () => now,
		subscribe(notify: () => void) {
			const id = setInterval(() => {
				now = Date.now()
				notify()
			}, intervalMs)
			return () => clearInterval(id)
		},
	}
}
