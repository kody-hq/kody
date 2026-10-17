import { useState } from 'react'

/** Keep an unrecoverable handoff until a previously observed invite disappears. */
export function useInviteHandoff<T extends { id: string }>(
	pending: ReadonlyArray<{ id: string }> | undefined,
) {
	const [created, setCreated] = useState<T | null>(null)
	const [observedId, setObservedId] = useState<string | null>(null)
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
