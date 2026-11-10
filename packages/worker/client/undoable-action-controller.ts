import { uiState, uiContext, sendUiEvent } from '#client/ui-actor.ts'
import { createActor } from 'xstate'
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
	const store = createActor(undoableActionState, {
		snapshot: (() => {
			const initialView = {
				status: 'idle',
			}
			return undoableActionState.resolveState({
				value: initialView.status,
				context: uiContext(initialView),
			})
		})(),
	}).start()
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
		const current = uiState<State>(store.getSnapshot())
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
				const active = uiState<State>(store.getSnapshot())
				if ('promise' in active && active.promise === promise)
					sendUiEvent(store, {
						type: 'SETTLED',
						data: uiContext({ status: 'idle' }).data,
					} as Parameters<typeof store.send>[0])
			})
		store.send({
			type: status === 'committing' ? 'COMMIT' : 'UNDO',
			data: { promise },
		})
		return promise
	}
	const commit = (_options?: { silent?: boolean }) => settle('committing')
	const undo = () => settle('undoing')
	function start(action: UndoableActionInput, timeoutMs = 8_000) {
		const next = tail.then(async () => {
			await commit()
			sendUiEvent(store, {
				type: 'SCHEDULE',
				data: uiContext({ status: 'waiting', action }).data,
			} as Parameters<typeof store.send>[0])
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
		actor: store,
		getSnapshot: () => uiState<State>(store.getSnapshot()),
		start,
		undo,
		commit,
		dispose,
		activate: () => {
			disposed = false
		},
	}
}
