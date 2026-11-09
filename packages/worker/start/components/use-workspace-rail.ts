import { useResponsiveSidebar } from './use-responsive-sidebar.ts'
import { parseSidebarPreferences } from '#universal/sidebar-preferences.ts'
import {
	useSidebarPreferences,
	saveSidebarPreferences,
} from './sidebar-preferences.tsx'
import {
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type FocusEvent,
	type PointerEvent,
	type KeyboardEvent,
} from 'react'
type SidebarMode = 'compact' | 'auto' | 'show'
const key = 'kody.workspace.rail.mode'
const listeners = new Set<() => void>()
let modeValue: SidebarMode = 'auto'
let storedValue: string | null | undefined
function read() {
	try {
		if (typeof window !== 'undefined') {
			const value = localStorage.getItem(key)
			if (value !== storedValue) {
				storedValue = value
				modeValue =
					value === 'compact' || value === 'show'
						? value
						: value === null &&
							  localStorage.getItem('kody.workspace.rail.compact') === 'true'
							? 'compact'
							: value === null
								? parseSidebarPreferences(document.cookie).mode
								: 'auto'
			}
		}
	} catch {
		/* Keep the in-memory preference. */
	}
	return modeValue
}
function subscribe(listener: () => void) {
	listeners.add(listener)
	const storage = (event: StorageEvent) => {
		if (event.key === key) listener()
	}
	window.addEventListener('storage', storage)
	return () => {
		listeners.delete(listener)
		window.removeEventListener('storage', storage)
	}
}
export function useWorkspaceRail() {
	const initial = useSidebarPreferences()
	const mode = useSyncExternalStore(subscribe, read, () => initial.mode)
	useEffect(() => saveSidebarPreferences({ mode }), [mode])
	const responsive = useResponsiveSidebar(
		mode === 'compact',
		mode === 'show' ? '(max-width: 599px)' : '(max-width: 1200px)',
	)
	const compact = responsive.collapsed
	const [preview, setPreview] = useState(false)
	const element = useRef<HTMLElement>(null),
		toggle = useRef<HTMLButtonElement>(null)
	const entering = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
		leaving = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const pointerInside = useRef(false),
		pointerFocus = useRef(false),
		skipFocus = useRef(false)
	function cancel() {
		clearTimeout(entering.current)
		clearTimeout(leaving.current)
	}
	function closeLater() {
		clearTimeout(entering.current)
		clearTimeout(leaving.current)
		leaving.current = setTimeout(() => {
			const active = document.activeElement
			if (
				pointerInside.current ||
				(!pointerFocus.current && element.current?.contains(active)) ||
				active?.closest('[role="menu"], [popover]:popover-open')
			)
				return
			setPreview(false)
		}, 300)
	}
	useEffect(() => {
		const keyboard = () => {
			pointerFocus.current = false
		}
		const pointer = () => {
			pointerFocus.current = true
		}
		document.addEventListener('keydown', keyboard, true)
		document.addEventListener('pointerdown', pointer, true)
		return () => {
			cancel()
			document.removeEventListener('keydown', keyboard, true)
			document.removeEventListener('pointerdown', pointer, true)
		}
	}, [])
	useEffect(() => {
		if (!compact) return
		const outside = () => {
			if (!pointerInside.current) closeLater()
		}
		document.addEventListener('focusin', outside)
		document.addEventListener('toggle', outside, true)
		return () => {
			document.removeEventListener('focusin', outside)
			document.removeEventListener('toggle', outside, true)
		}
	}, [compact])
	return {
		compact,
		expanded: !compact || preview,
		element,
		toggle,
		mode,
		setMode: (value: SidebarMode) => {
			cancel()
			modeValue = value
			saveSidebarPreferences({ mode: value })
			try {
				localStorage.setItem(key, value)
				storedValue = value
			} catch {
				/* Keep the in-memory preference. */
			}
			for (const listener of listeners) listener()
			setPreview(false)
		},
		behavior: {
			onPointerEnter: (event: PointerEvent<HTMLElement>) => {
				if (event.pointerType === 'touch') return
				pointerInside.current = true
				cancel()
				if (compact) entering.current = setTimeout(() => setPreview(true), 150)
			},
			onPointerLeave: () => {
				pointerInside.current = false
				if (compact) closeLater()
			},
			onPointerDownCapture: () => {
				pointerFocus.current = true
			},
			onFocusCapture: (_event: FocusEvent<HTMLElement>) => {
				if (skipFocus.current) return
				if (compact && !pointerFocus.current) {
					cancel()
					setPreview(true)
				}
			},
			onBlurCapture: (event: FocusEvent<HTMLElement>) => {
				if (
					compact &&
					!event.currentTarget.contains(event.relatedTarget as Node | null)
				)
					closeLater()
			},
			onKeyDownCapture: (event: KeyboardEvent<HTMLElement>) => {
				pointerFocus.current = false
				if (
					event.key === 'Escape' &&
					compact &&
					!event.defaultPrevented &&
					!(event.target as Element).closest(
						'[role=menu], [popover]:popover-open',
					)
				) {
					cancel()
					setPreview(false)
					skipFocus.current = true
					element.current?.focus()
					queueMicrotask(() => {
						skipFocus.current = false
					})
				}
			},
		},
	}
}
