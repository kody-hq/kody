import { useRouter } from '@tanstack/react-router'
import { useCallback, type RefObject } from 'react'

/**
 * Ref callback that runs `close` with the node after each navigation that
 * changes the href (or only the pathname with `on: 'path'`). Attach it to the
 * panel, menu, or drawer that should close. Pass a stable `close` and an
 * optional `ref` that should point at the same node.
 */
export function useCloseOnNavigation<T extends Element>(
	close: (node: T) => void,
	options: { on?: 'href' | 'path'; ref?: RefObject<T | null> } = {},
) {
	const router = useRouter()
	const { on = 'href', ref } = options
	return useCallback(
		(node: T | null) => {
			if (ref) ref.current = node
			if (!node) return
			const unsubscribe = router.subscribe('onResolved', (event) => {
				if (on === 'path' ? event.pathChanged : event.hrefChanged) close(node)
			})
			return () => {
				unsubscribe()
				if (ref) ref.current = null
			}
		},
		[router, on, ref, close],
	)
}

export function closeDetails(details: HTMLDetailsElement) {
	details.open = false
}
