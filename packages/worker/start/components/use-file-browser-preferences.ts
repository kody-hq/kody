import { useEffect, useSyncExternalStore } from 'react'
import {
	parseSidebarPreferences,
	type SidebarPreferences,
} from '#universal/sidebar-preferences.ts'
import {
	saveSidebarPreferences,
	useSidebarPreferences,
} from './sidebar-preferences.tsx'

type Preferences = NonNullable<SidebarPreferences['files']>
const defaults: Preferences = { view: 'columns', thumbnailSize: 132 }
const viewKey = 'kody.files.view',
	sizeKey = 'kody.files.thumbnailSize'
const listeners = new Set<() => void>()
let snapshot: Preferences | undefined
let storageAvailable = true
function read(): Preferences {
	if (!storageAvailable) return snapshot ?? defaults
	try {
		const fallback = parseSidebarPreferences(document.cookie).files ?? defaults
		const saved = localStorage.getItem(viewKey),
			size = Number(localStorage.getItem(sizeKey))
		const view =
			saved === 'columns' ||
			saved === 'icons' ||
			saved === 'list' ||
			saved === 'gallery'
				? saved
				: fallback.view
		const thumbnailSize =
			Number.isFinite(size) && size >= 84 && size <= 220
				? size
				: fallback.thumbnailSize
		if (
			!snapshot ||
			snapshot.view !== view ||
			snapshot.thumbnailSize !== thumbnailSize
		)
			snapshot = { view, thumbnailSize }
	} catch {
		storageAvailable = false
	}
	return (snapshot ??= defaults)
}
function subscribe(listener: () => void) {
	listeners.add(listener)
	const storage = (event: StorageEvent) => {
		if (event.key === null || event.key === viewKey || event.key === sizeKey)
			listener()
	}
	window.addEventListener('storage', storage)
	return () => {
		listeners.delete(listener)
		window.removeEventListener('storage', storage)
	}
}
function update(patch: Partial<Preferences>) {
	snapshot = { ...read(), ...patch }
	try {
		localStorage.setItem(viewKey, snapshot.view)
		localStorage.setItem(sizeKey, String(snapshot.thumbnailSize))
	} catch {
		storageAvailable = false
	}
	saveSidebarPreferences({ files: snapshot })
	for (const listener of listeners) listener()
}
export function useFileBrowserPreferences() {
	const initial = useSidebarPreferences()
	// No cookie means an older local-storage preference may still need migration.
	// Render a neutral pending state rather than briefly showing the wrong view.
	const preferences = useSyncExternalStore(
		subscribe,
		read,
		() => initial.files ?? null,
	)
	useEffect(() => {
		if (preferences) saveSidebarPreferences({ files: preferences })
	}, [preferences])
	return {
		ready: preferences !== null,
		view: preferences?.view ?? defaults.view,
		thumbnailSize: preferences?.thumbnailSize ?? defaults.thumbnailSize,
		changeView: (view: Preferences['view']) => update({ view }),
		resizeThumbnails: (thumbnailSize: number) => update({ thumbnailSize }),
	}
}
