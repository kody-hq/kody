/**
 * Module state that lives for one Worker isolate (or one browser page).
 * Use it for caches, dedupe sets, and in-flight work instead of bare
 * module-level `let`/`Map`, so tests reset every slot through
 * `isolate-state-test-support.ts` without per-module reset exports.
 */
export type IsolateState<T> = { current: T }

type IsolateSlot = {
	reset(): void
	pending(): Iterable<Promise<unknown>>
}

const registryKey = Symbol.for('kody.isolate-state')

export function isolateStateRegistry(): Set<IsolateSlot> {
	const scope = globalThis as { [registryKey]?: Set<IsolateSlot> }
	scope[registryKey] ??= new Set()
	return scope[registryKey]
}

export function isolateState<T>(
	create: () => T,
	options?: { pending?: (value: T) => Iterable<Promise<unknown>> },
): IsolateState<T> {
	const state: IsolateState<T> = { current: create() }
	isolateStateRegistry().add({
		reset() {
			state.current = create()
		},
		pending() {
			return options?.pending?.(state.current) ?? []
		},
	})
	return state
}

/** Register a Map or Set so it is cleared with the rest of isolate state. */
export function isolateCollection<T extends { clear(): void }>(
	collection: T,
	options?: { pending?: (value: T) => Iterable<Promise<unknown>> },
): T {
	isolateStateRegistry().add({
		reset() {
			collection.clear()
		},
		pending() {
			return options?.pending?.(collection) ?? []
		},
	})
	return collection
}
