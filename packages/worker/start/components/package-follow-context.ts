import { createContext, type ReactNode } from 'react'
export const PackageFollowContext = createContext<{
	open: boolean
	following: boolean
	toggle: () => void
	panel: ReactNode
} | null>(null)
