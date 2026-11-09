import { createIsomorphicFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { getStartContext } from '@tanstack/start-storage-context'
import {
	parseSidebarPreferences,
	sidebarDefaults,
} from '#universal/sidebar-preferences.ts'

export const readSidebarPreferences = createIsomorphicFn()
	.client(() => sidebarDefaults)
	.server(() =>
		getStartContext({ throwIfNotFound: false })
			? parseSidebarPreferences(getRequest().headers.get('cookie') ?? '')
			: sidebarDefaults,
	)
