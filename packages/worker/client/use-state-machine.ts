import { useState, useSyncExternalStore } from 'react'
import type { StateMachine } from '@kody-internal/shared/state-machine.ts'
import { createStateMachineStore } from './state-machine-store.ts'

export function useStateMachine<T extends { status: string }>(
	machine: StateMachine<T['status']>,
	initial: T,
) {
	const [store] = useState(() => createStateMachineStore(machine, initial))
	const state = useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		store.getSnapshot,
	)
	return [state, store.transition, store.getSnapshot] as const
}
