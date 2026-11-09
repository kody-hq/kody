import type { StateMachine } from '@kody-internal/shared/state-machine.ts'

export type FormFlowState<S extends string> = {
	[K in S]: K extends 'error' | 'success' | 'confirming'
		? { status: K; message: string }
		: { status: K }
}[S]

export function createStateMachineStore<T extends { status: string }>(
	machine: StateMachine<T['status']>,
	initial: T,
) {
	machine.parse(initial.status)
	let state = initial
	const listeners = new Set<() => void>()
	return {
		getSnapshot: () => state,
		subscribe(listener: () => void) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		transition(next: T) {
			if (!machine.can(state.status, next.status)) return false
			state = next
			for (const listener of listeners) listener()
			return true
		},
	}
}
