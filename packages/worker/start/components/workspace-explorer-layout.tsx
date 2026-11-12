/** @jsxImportSource @emotion/react */
import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from 'react'
import { useResponsiveSidebar } from './use-responsive-sidebar.ts'
import { parseSidebarPreferences } from '#universal/sidebar-preferences.ts'
import {
	useSidebarPreferences,
	saveSidebarPreferences,
} from './sidebar-preferences.tsx'
import { colors } from '#universal/styles/tokens.ts'

const key = 'kody.files.explorer'
const defaults = { width: 232, hidden: false }
let snapshot = defaults,
	serialized: string | null | undefined
const listeners = new Set<() => void>()
function read() {
	if (typeof window === 'undefined') return defaults
	try {
		const value = localStorage.getItem(key)
		if (value !== serialized) {
			serialized = value
			const parsed = value
				? JSON.parse(value)
				: parseSidebarPreferences(document.cookie).explorer
			snapshot = {
				width:
					typeof parsed.width === 'number' && Number.isFinite(parsed.width)
						? Math.max(180, Math.min(360, parsed.width))
						: 232,
				hidden: parsed.hidden === true,
			}
		}
	} catch {
		/* Preferences remain usable when browser storage is unavailable. */
	}
	return snapshot
}
function subscribe(listener: () => void) {
	listeners.add(listener)
	const storage = (event: StorageEvent) => {
		if (event.key === key) {
			read()
			listener()
		}
	}
	window.addEventListener('storage', storage)
	return () => {
		listeners.delete(listener)
		window.removeEventListener('storage', storage)
	}
}
function update(changes: Partial<typeof defaults>) {
	snapshot = { ...read(), ...changes }
	saveSidebarPreferences({ explorer: snapshot })
	try {
		const value = JSON.stringify(snapshot)
		localStorage.setItem(key, value)
		serialized = value
	} catch {
		/* Keep the in-memory preference. */
	}
	for (const listener of listeners) listener()
}
const control = {
	display: 'grid',
	placeItems: 'center',
	width: 28,
	height: 28,
	padding: 0,
	border: 0,
	borderRadius: 4,
	background: 'transparent',
	color: colors.textMuted,
	cursor: 'pointer',
	'&:hover': {
		background: `color-mix(in srgb, ${colors.text} 8%, transparent)`,
	},
}
function PanelIcon({ open }: { open: boolean }) {
	return (
		<svg
			aria-hidden="true"
			width="16"
			height="16"
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.2"
		>
			<rect x="1.5" y="2" width="13" height="12" rx="2" />
			<path d="M6 2v12" />
			<path d={open ? 'm10 5-3 3 3 3' : 'm8 5 3 3-3 3'} />
		</svg>
	)
}
export function WorkspaceExplorerLayout({
	sidebar,
	children,
	onVisibilityChange,
	browsing = false,
}: {
	browsing?: boolean
	sidebar: ReactNode
	children: (explorerToggle: ReactNode) => ReactNode
	onVisibilityChange?: (visible: boolean) => void
}) {
	const initial = useSidebarPreferences()
	const preferences = useSyncExternalStore(
		subscribe,
		read,
		() => initial.explorer,
	)
	useEffect(
		() => saveSidebarPreferences({ explorer: preferences }),
		[preferences],
	)
	const responsive = useResponsiveSidebar(
		preferences.hidden,
		'(max-width: 1000px)',
	)
	const hidden = browsing || responsive.collapsed
	const [flyout, setFlyout] = useState(false),
		[available, setAvailable] = useState(800),
		[dragWidth, setDragWidth] = useState<number | null>(null)
	const root = useRef<HTMLDivElement>(null),
		panel = useRef<HTMLElement>(null),
		trigger = useRef<HTMLButtonElement>(null)
	const opening = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
		closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const drag = useRef<{
		id: number
		x: number
		start: number
		width: number
	} | null>(null)
	const maximum = Math.max(180, Math.min(360, Math.floor(available * 0.45)))
	const width = Math.max(180, Math.min(maximum, dragWidth ?? preferences.width))
	const visible = !browsing && (!hidden || flyout)
	useLayoutEffect(() => {
		const element = root.current
		if (!element) return
		const observer = new ResizeObserver(() =>
			setAvailable(element.getBoundingClientRect().width),
		)
		observer.observe(element)
		return () => observer.disconnect()
	}, [])
	useEffect(() => {
		onVisibilityChange?.(visible)
	}, [visible, onVisibilityChange])
	useEffect(
		() => () => {
			clearTimeout(opening.current)
			clearTimeout(closing.current)
		},
		[],
	)
	function reveal(intent = false) {
		clearTimeout(closing.current)
		clearTimeout(opening.current)
		if (intent) opening.current = setTimeout(() => setFlyout(true), 150)
		else setFlyout(true)
	}
	function dismiss() {
		clearTimeout(opening.current)
		clearTimeout(closing.current)
		closing.current = setTimeout(() => {
			if (
				panel.current?.contains(document.activeElement) ||
				document.activeElement?.closest('[role="menu"]')
			)
				return
			setFlyout(false)
		}, 300)
	}
	return (
		<div
			ref={root}
			data-explorer-hidden={hidden || undefined}
			data-explorer-browsing={browsing || undefined}
			css={{
				position: 'relative',
				'--workspace-panel-gutter': 'clamp(18px, 3vw, 32px)',
				'&:has(> [data-workspace-media])': {
					'--workspace-panel-gutter': '12px',
				},
				display: 'grid',
				gridTemplateColumns: `${hidden ? 0 : width}px minmax(0,1fr)`,
				transition: 'grid-template-columns 240ms cubic-bezier(.22,1,.36,1)',
				'@media(prefers-reduced-motion:reduce)': { transition: 'none' },
				'& > [aria-label=Document], & > [data-workspace-background]': {
					gridColumn: 2,
				},
				flex: 1,
				minHeight: 0,
				minWidth: 0,
				overflow: 'hidden',
				userSelect: dragWidth === null ? undefined : 'none',
				'& [data-workspace-toolbar]': {
					position: 'relative',
					marginInline: 'calc(-1 * var(--workspace-panel-gutter, 0px))',
					width: 'calc(100% + 2 * var(--workspace-panel-gutter, 0px))',
					paddingInline: 12,
					borderBottom: 0,
					'&::after': {
						content: '""',
						position: 'absolute',
						bottom: 0,
						left: 0,
						right: 0,
						height: 1,
						background: colors.border,
						pointerEvents: 'none',
					},
				},
				'@media(max-width:600px)': {
					gridTemplateColumns: 'minmax(0,1fr)',
					'& > [aria-label=Document], & > [data-workspace-background]': {
						gridColumn: 1,
					},
				},
			}}
			onKeyDown={(event) => {
				if (
					event.key === 'Escape' &&
					hidden &&
					flyout &&
					!event.defaultPrevented
				) {
					event.preventDefault()
					setFlyout(false)
					trigger.current?.focus()
				}
			}}
		>
			{hidden && !browsing && (
				<>
					<div
						aria-hidden="true"
						onPointerEnter={(event) => {
							if (event.pointerType !== 'touch') reveal(true)
						}}
						onPointerLeave={dismiss}
						css={{
							position: 'absolute',
							left: 0,
							top: 0,
							bottom: 0,
							width: 8,
							zIndex: 11,
						}}
					/>
				</>
			)}
			<aside
				ref={panel}
				aria-label="File explorer"
				inert={!visible}
				onPointerEnter={() => {
					clearTimeout(closing.current)
					clearTimeout(opening.current)
				}}
				onPointerLeave={dismiss}
				onBlurCapture={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null))
						dismiss()
				}}
				css={{
					position: hidden ? 'absolute' : 'relative',
					width,
					minWidth: 0,
					minHeight: 0,
					background: colors.background,
					borderInlineEnd: `1px solid ${colors.border}`,
					zIndex: hidden ? 20 : 1,
					...(hidden
						? {
								left: 0,
								top: 0,
								bottom: 0,
								width,
								maxWidth: 'calc(100% - 8px)',
								borderInlineEnd: `1px solid ${colors.border}`,
								borderRadius: '0 8px 8px 0',
								boxShadow: flyout ? '4px 0 16px #0000000d' : '4px 0 16px #0000',
								'@media (prefers-color-scheme: dark)': {
									boxShadow: flyout ? '12px 0 36px #0003' : '12px 0 36px #0000',
								},
								visibility: !browsing && flyout ? 'visible' : 'hidden',
								pointerEvents: !browsing && flyout ? 'auto' : 'none',
								transform: flyout
									? 'translateX(0)'
									: 'translateX(calc(-100% - 8px))',
								transition: `transform 240ms cubic-bezier(.22,1,.36,1), box-shadow 140ms ease, visibility 0s linear ${flyout ? 0 : 240}ms`,
								'@media(prefers-reduced-motion:reduce)': { transition: 'none' },
							}
						: {}),
					'@media(max-width:600px)': hidden
						? {}
						: {
								width: '100%',
								borderInlineEnd: 0,
								borderBottom: `1px solid ${colors.border}`,
								maxHeight: '40dvh',
							},
				}}
			>
				<div
					css={{
						height: '100%',
						boxSizing: 'border-box',
						display: 'flex',
						flexDirection: 'column',
						overflow: 'auto',
						padding: 8,
						'& > div:first-of-type': { marginInlineEnd: 24 },
					}}
				>
					{sidebar}
				</div>
				<button
					css={{
						...control,
						position: 'absolute',
						right: 7,
						top: 10,
						zIndex: 1,
					}}
					aria-label={hidden ? 'Keep file explorer open' : 'Hide file explorer'}
					title={hidden ? 'Keep file explorer open' : 'Hide file explorer'}
					onClick={() => {
						responsive.setCollapsed(!hidden, (value) =>
							update({ hidden: value }),
						)
						setFlyout(false)
					}}
				>
					<PanelIcon open={!hidden} />
				</button>
				<div
					role="separator"
					aria-label="Resize file explorer"
					aria-orientation="vertical"
					aria-valuemin={180}
					aria-valuemax={maximum}
					aria-valuenow={width}
					tabIndex={0}
					css={{
						position: 'absolute',
						right: -3,
						top: 0,
						bottom: 0,
						width: 6,
						cursor: 'col-resize',
						touchAction: 'none',
						'&:hover, &:focus-visible': {
							background: `color-mix(in srgb, ${colors.text} 20%, transparent)`,
						},
						'@media(max-width:600px)': { display: 'none' },
					}}
					onDoubleClick={() => update({ width: 232 })}
					onKeyDown={(event) => {
						const next =
							event.key === 'ArrowLeft'
								? width - 16
								: event.key === 'ArrowRight'
									? width + 16
									: event.key === 'Home'
										? 180
										: event.key === 'End'
											? maximum
											: null
						if (next !== null) {
							event.preventDefault()
							update({ width: Math.max(180, Math.min(maximum, next)) })
						}
					}}
					onPointerDown={(event) => {
						if (event.button !== 0) return
						event.preventDefault()
						event.currentTarget.focus()
						event.currentTarget.setPointerCapture(event.pointerId)
						drag.current = {
							id: event.pointerId,
							x: event.clientX,
							start: width,
							width,
						}
						setDragWidth(width)
					}}
					onPointerMove={(event) => {
						if (drag.current?.id !== event.pointerId) return
						const value = Math.max(
							180,
							Math.min(
								maximum,
								drag.current.start + event.clientX - drag.current.x,
							),
						)
						drag.current.width = value
						setDragWidth(value)
					}}
					onPointerUp={(event) => {
						if (drag.current?.id !== event.pointerId) return
						update({ width: drag.current.width })
						drag.current = null
						setDragWidth(null)
						if (event.currentTarget.hasPointerCapture(event.pointerId))
							event.currentTarget.releasePointerCapture(event.pointerId)
					}}
					onPointerCancel={() => {
						drag.current = null
						setDragWidth(null)
					}}
					onLostPointerCapture={() => {
						drag.current = null
						setDragWidth(null)
					}}
				/>
			</aside>
			{children(
				hidden && !browsing ? (
					<button
						ref={trigger}
						css={{
							...control,
							flexShrink: 0,
							background: colors.background,
						}}
						aria-label="Show file explorer"
						title="Show file explorer"
						aria-expanded={flyout}
						onPointerEnter={(event) => {
							if (event.pointerType !== 'touch') reveal(true)
						}}
						onPointerLeave={dismiss}
						onFocus={(event) => {
							if (!panel.current?.contains(event.relatedTarget as Node | null))
								reveal()
						}}
						onClick={() => reveal()}
					>
						<svg
							aria-hidden="true"
							width="16"
							height="16"
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.35"
							strokeLinecap="round"
						>
							<path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
						</svg>
					</button>
				) : null,
			)}
		</div>
	)
}
