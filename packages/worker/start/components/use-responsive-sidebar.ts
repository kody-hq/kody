import { useCallback, useState, useSyncExternalStore } from 'react'
import { useSidebarPreferences } from './sidebar-preferences.tsx'

/** Responsive collapse never overwrites the user's wide-window preference. */
export function useResponsiveSidebar(preferred: boolean, query: string) {
	const initial = useSidebarPreferences()
	const [override, setOverride] = useState<boolean | null>(null)
	const matches = useSyncExternalStore(
		useCallback(
			(listener: () => void) => {
				const media = window.matchMedia(query)
				const change = () => {
					setOverride(null)
					listener()
				}
				media.addEventListener('change', change)
				return () => media.removeEventListener('change', change)
			},
			[query],
		),
		useCallback(() => window.matchMedia(query).matches, [query]),
		() =>
			initial.viewport <=
			Number(query.match(/max-width:\s*(\d+)px/)?.[1] ?? -1),
	)
	return {
		collapsed: matches ? (override ?? true) : preferred,
		setCollapsed(value: boolean, persist: (value: boolean) => void) {
			if (matches) setOverride(value)
			else persist(value)
		},
	}
}
