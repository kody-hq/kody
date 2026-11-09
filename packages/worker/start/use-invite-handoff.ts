import { type SetStateAction, useState } from 'react'

// A success that settles after navigating away waits here for its own page.
const parkedHandoffs = new Map<string, unknown>()

/** Keep a handoff for `handoffKey` so it shows when that page mounts again. */
export function parkInviteHandoff(handoffKey: string, value: { id: string }) {
	parkedHandoffs.set(handoffKey, value)
}

/** Keep an unrecoverable handoff until a previously observed invite disappears. */
export function useInviteHandoff<T extends { id: string }>(
	pending: ReadonlyArray<{ id: string }> | undefined,
	handoffKey?: string,
) {
	const [created, setCreatedState] = useState<T | null>(() =>
		handoffKey
			? ((parkedHandoffs.get(handoffKey) as T | undefined) ?? null)
			: null,
	)
	const [observedId, setObservedId] = useState<string | null>(null)
	function setCreated(next: SetStateAction<T | null>) {
		setCreatedState((current) => {
			const value = typeof next === 'function' ? next(current) : next
			if (handoffKey) {
				if (value) parkedHandoffs.set(handoffKey, value)
				else parkedHandoffs.delete(handoffKey)
			}
			return value
		})
	}
	if (created && pending !== undefined) {
		if (pending.some((invite) => invite.id === created.id)) {
			if (observedId !== created.id) setObservedId(created.id)
		} else if (observedId === created.id) {
			setCreated(null)
			setObservedId(null)
		}
	}
	return [created, setCreated] as const
}
