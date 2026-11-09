import { createStateMachineStore } from './state-machine-store.ts'
import {
	undoableActionState,
	type UndoableActionStatus,
} from './routes/undoable-action-state.ts'
export type UndoableActionInput = {
	message: string
	undoLabel?: string
	onCommit: () => void | Promise<void>
	onUndo?: () => void | Promise<void>
}
type State =
	| { status: 'idle' }
	| { status: 'waiting'; action: UndoableActionInput }
	| {
			status: Exclude<UndoableActionStatus, 'idle' | 'waiting'>
			promise: Promise<void>
	  }
export function createUndoableActionController() {
	const store = createStateMachineStore<State>(undoableActionState, {
		status: 'idle',
	})
	let timer: ReturnType<typeof setTimeout> | null = null
	let tail = Promise.resolve()
	let disposed = false
	function clear() {
		if (timer !== null) clearTimeout(timer)
		timer = null
	}
	function settle(
		status: Exclude<UndoableActionStatus, 'idle' | 'waiting'>,
	): Promise<void> {
		const current = store.getSnapshot()
		if (current.status === 'idle') return Promise.resolve()
		if (current.status !== 'waiting') return current.promise
		clear()
		const promise = Promise.resolve()
			.then(() =>
				status === 'committing'
					? current.action.onCommit()
					: current.action.onUndo?.(),
			)
			.finally(() => {
				const active = store.getSnapshot()
				if ('promise' in active && active.promise === promise)
					store.transition({ status: 'idle' })
			})
		store.transition({ status, promise })
		return promise
	}
	const commit = (_options?: { silent?: boolean }) => settle('committing')
	const undo = () => settle('undoing')
	function start(action: UndoableActionInput, timeoutMs = 8_000) {
		const next = tail.then(async () => {
			await commit()
			store.transition({ status: 'waiting', action })
			if (disposed) await commit()
			else
				timer = setTimeout(() => {
					void commit()
				}, timeoutMs)
		})
		tail = next.catch(() => undefined)
		return next
	}
	async function dispose() {
		disposed = true
		clear()
		await commit()
		await tail
	}
	return {
		...store,
		start,
		undo,
		commit,
		dispose,
		activate: () => {
			disposed = false
		},
	}
}
