/** @jsxImportSource @emotion/react */
import { createContext, useContext, type ReactNode } from 'react'
import type { AnyRouter } from '@tanstack/react-router'

import {
	parseSidebarPreferences,
	sidebarDefaults,
	cookieName,
	type SidebarPreferences,
} from '#universal/sidebar-preferences.ts'
/** Keep the cookie's viewport fields current while an `/_app` page is open. */
export function syncSidebarViewportWithRouter(router: AnyRouter) {
	const save = () => saveSidebarPreferences({})
	let listening = false
	const sync = () => {
		const inApp = router.state.matches.some(
			(match) => match.routeId === '/_app',
		)
		if (inApp === listening) return
		listening = inApp
		if (inApp) {
			save()
			window.addEventListener('resize', save)
		} else window.removeEventListener('resize', save)
	}
	sync()
	router.subscribe('onResolved', sync)
}

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
	return <SidebarContext value={value}>{children}</SidebarContext>
}
