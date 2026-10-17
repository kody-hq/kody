/** Fence delivery reads against resend, timeout, and leaving the page. */
export function createVerificationDeliveryPoll() {
	let generation = 0
	let active: AbortController | undefined
	return {
		invalidate() {
			generation += 1
			active?.abort()
			active = undefined
		},
		async read<T>(
			fetch: (signal: AbortSignal) => Promise<T>,
		): Promise<{ current: true; value: T } | { current: false }> {
			active?.abort()
			const controller = new AbortController()
			active = controller
			const started = ++generation
			const timeout = setTimeout(() => controller.abort(), 10_000)
			try {
				const value = await fetch(controller.signal)
				return !controller.signal.aborted && started === generation
					? { current: true, value }
					: { current: false }
			} finally {
				clearTimeout(timeout)
				if (active === controller) active = undefined
			}
		},
	}
}
