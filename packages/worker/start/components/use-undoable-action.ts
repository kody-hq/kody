import { useEffect, useState } from 'react'
import { useSelector } from '@xstate/react'
import { uiState } from '#client/ui-actor.ts'
import type { UndoableActionView } from '#client/routes/undoable-action-state.ts'
import {
	createUndoableActionController,
	type UndoableActionInput,
} from '#client/undoable-action-controller.ts'
export function useUndoableAction(timeoutMs = 8_000) {
	const [controller] = useState(createUndoableActionController)
	const snapshot = useSelector(controller.actor, (value) => value)
	const state = uiState<UndoableActionView>(snapshot)
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
