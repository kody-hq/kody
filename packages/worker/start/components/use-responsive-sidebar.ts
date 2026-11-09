import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useSidebarPreferences } from './sidebar-preferences.tsx'

/** Responsive collapse never overwrites the user's wide-window preference. */
export function useResponsiveSidebar(preferred: boolean, query: string) {
	const initial = useSidebarPreferences()
	const matches = useSyncExternalStore(
		useCallback(
			(listener: () => void) => {
				const media = window.matchMedia(query)
				media.addEventListener('change', listener)
				return () => media.removeEventListener('change', listener)
			},
			[query],
		),
		useCallback(() => window.matchMedia(query).matches, [query]),
		() =>
			initial.viewport <=
			Number(query.match(/max-width:\s*(\d+)px/)?.[1] ?? -1),
	)
	const [override, setOverride] = useState<boolean | null>(null)
	useEffect(() => setOverride(null), [matches])
	return {
		collapsed: matches ? (override ?? true) : preferred,
		setCollapsed(value: boolean, persist: (value: boolean) => void) {
			if (matches) setOverride(value)
			else persist(value)
		},
	}
}
