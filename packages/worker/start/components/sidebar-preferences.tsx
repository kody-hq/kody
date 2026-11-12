/** @jsxImportSource @emotion/react */
import { createContext, useContext, useEffect, type ReactNode } from 'react'

import {
	parseSidebarPreferences,
	sidebarDefaults,
	cookieName,
	type SidebarPreferences,
} from '#universal/sidebar-preferences.ts'
export function saveSidebarPreferences(patch: Partial<SidebarPreferences>) {
	try {
		const value = {
			...parseSidebarPreferences(document.cookie),
			...patch,
			viewport: window.innerWidth,
		}
		document.cookie = `${cookieName}=${encodeURIComponent(JSON.stringify(value))}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`
	} catch {
		/* Storage preferences are optional. */
	}
}
const SidebarContext = createContext(sidebarDefaults)
export const useSidebarPreferences = () => useContext(SidebarContext)
export function SidebarPreferencesProvider({
	value,
	children,
}: {
	value: SidebarPreferences
	children: ReactNode
}) {
	useEffect(() => {
		const save = () => saveSidebarPreferences({})
		save()
		window.addEventListener('resize', save)
		return () => window.removeEventListener('resize', save)
	}, [])
	return <SidebarContext value={value}>{children}</SidebarContext>
}
