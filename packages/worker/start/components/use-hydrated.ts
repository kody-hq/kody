import { useSyncExternalStore } from 'react'

const subscribe = () => () => {}
const clientSnapshot = () => true
const serverSnapshot = () => false

/** Keep security controls disabled in SSR until React attaches their handlers. */
export function useHydrated() {
	return useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot)
}
