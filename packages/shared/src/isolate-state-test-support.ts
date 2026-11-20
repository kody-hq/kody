import { isolateStateRegistry } from './isolate-state.ts'

/** Start the next case as if it ran on a fresh isolate. */
export function resetIsolateState(): void {
	for (const slot of isolateStateRegistry()) slot.reset()
}

/** Await fire-and-forget work tracked by `isolateState({ pending })`. */
export async function settleIsolateState(): Promise<void> {
	const pending = [...isolateStateRegistry()].flatMap((slot) => [
		...slot.pending(),
	])
	await Promise.all(pending)
}
