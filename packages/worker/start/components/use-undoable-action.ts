import { useEffect, useRef, useState } from 'react'

type Input = {
	message: string
	undoLabel?: string
	onCommit: () => void | Promise<void>
	onUndo?: () => void | Promise<void>
}

export function useUndoableAction(timeoutMs = 8_000) {
	const [pending, setPending] = useState<{
		message: string
		undoLabel: string
	} | null>(null)
	const current = useRef<Input | null>(null)
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
	function take() {
		const action = current.current
		current.current = null
		if (timer.current !== null) clearTimeout(timer.current)
		timer.current = null
		return action
	}
	async function commit(options?: { silent?: boolean }) {
		const action = take()
		if (!action) return
		if (!options?.silent) setPending(null)
		await action.onCommit()
	}
	async function undo() {
		const action = take()
		if (!action) return
		setPending(null)
		await action.onUndo?.()
	}
	async function start(input: Input) {
		await commit()
		current.current = input
		setPending({ message: input.message, undoLabel: input.undoLabel ?? 'Undo' })
		timer.current = setTimeout(() => {
			void commit()
		}, timeoutMs)
	}
	useEffect(() => {
		const leave = () => {
			void commit({ silent: true })
		}
		window.addEventListener('pagehide', leave)
		return () => {
			window.removeEventListener('pagehide', leave)
			leave()
		}
	}, [])
	return { pending, start, undo, commit }
}
