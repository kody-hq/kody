import { defineAppHotkeys } from '@tanstack/react-hotkeys'
export const commandHotkeys = defineAppHotkeys({
	'commands.open': {
		hotkey: 'Mod+K',
		meta: { name: 'Search and commands' },
		options: { requireReset: true },
	},
	'nav.overview': { hotkey: null, meta: { name: 'Go to overview' } },
	'nav.repositories': { hotkey: null, meta: { name: 'Go to repositories' } },
	'nav.jobs': { hotkey: null, meta: { name: 'Go to jobs' } },
	'nav.credentials': { hotkey: null, meta: { name: 'Go to credentials' } },
	'nav.memories': { hotkey: null, meta: { name: 'Go to memories' } },
	'nav.activity': { hotkey: null, meta: { name: 'Go to activity' } },
	'nav.waiting': { hotkey: null, meta: { name: 'Go to waiting' } },
	'nav.settings': { hotkey: null, meta: { name: 'Go to account settings' } },
	'nav.docs': { hotkey: null, meta: { name: 'Go to documentation' } },
})
declare module '@tanstack/react-hotkeys' {
	interface Register {
		appHotkeys: typeof commandHotkeys
	}
}
export const navigationHotkeys = [
	['nav.overview', 'Overview'],
	['nav.repositories', 'Repositories'],
	['nav.jobs', 'Jobs'],
	['nav.credentials', 'Credentials'],
	['nav.memories', 'Memories'],
	['nav.activity', 'Activity'],
	['nav.waiting', 'Waiting'],
	['nav.settings', 'Account settings'],
	['nav.docs', 'Documentation'],
] as const
