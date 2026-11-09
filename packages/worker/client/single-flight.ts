export function createSingleFlight() {
	let active: object | null = null
	return async function run<T>(
		action: () => Promise<T>,
	): Promise<T | undefined> {
		if (active) return
		active = {}
		try {
			return await action()
		} finally {
			active = null
		}
	}
}
