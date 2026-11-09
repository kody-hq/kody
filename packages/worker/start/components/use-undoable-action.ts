import { useEffect, useState, useSyncExternalStore } from 'react'
import {
	createUndoableActionController,
	type UndoableActionInput,
} from '#client/undoable-action-controller.ts'
export function useUndoableAction(timeoutMs = 8_000) {
	const [controller] = useState(createUndoableActionController)
	const state = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getSnapshot,
	)
	useEffect(() => {
		controller.activate()
		const leave = () => {
			void controller.commit({ silent: true })
		}
		window.addEventListener('pagehide', leave)
		return () => {
			window.removeEventListener('pagehide', leave)
			void controller.dispose()
		}
	}, [controller])
	return {
		pending:
			state.status === 'waiting'
				? {
						message: state.action.message,
						undoLabel: state.action.undoLabel ?? 'Undo',
					}
				: null,
		start: (input: UndoableActionInput) => controller.start(input, timeoutMs),
		undo: controller.undo,
		commit: controller.commit,
	}
}
