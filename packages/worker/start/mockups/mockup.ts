import type { ReactNode } from 'react'
import type { PageNavigation } from '../page-navigation.ts'

/**
 * Where a mockup renders.
 * - `bare`: page background only, for a single component or dialog.
 * - `marketing`: the real site header, page gutters, and footer.
 * - `focused`: the real site header and page gutters, no footer.
 * - `workspace`: the real signed-in workspace rail (needs a session).
 */
export type MockupShell = 'bare' | 'marketing' | 'focused' | 'workspace'

export type Mockup = {
	title: string
	/** One line for the index: what the mockup proposes. */
	description?: string
	shell?: MockupShell
	/** Workspace shell only: the rail item to highlight. Defaults to `overview`. */
	rail?: PageNavigation['item']
	/** Named states, rendered at `/dev/mockups/<name>?state=<key>`. The first is the default. */
	states: Record<string, () => ReactNode>
}

/** Mockup files are `*.mockup.tsx` under this folder; `local/` is git-ignored for one-offs. */
export function loadMockupModules() {
	// Dev server only: production builds drop the glob, so no mockup code ships.
	if (!import.meta.env.DEV) return {}
	return import.meta.glob<{ default: Mockup }>('./**/*.mockup.tsx')
}

export function mockupName(modulePath: string) {
	return modulePath.replace(/^\.\//, '').replace(/\.mockup\.tsx$/, '')
}
