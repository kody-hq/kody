/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
} from 'react'
import { useNavigate } from '@tanstack/react-router'
import { toast } from '#client/toast.ts'
import { publicAsset } from '../public-assets.ts'
import { kodyBrandAssets, kodyMarkSvgMarkup } from '../brand/kody-mark-path.ts'
import { colors, shadows, transitions } from '#universal/styles/tokens.ts'
import { hoverMq } from '#universal/styles/style-primitives.ts'

type BrandContextMenuProps = {
	children: ReactNode
}

type MenuItem =
	| {
			kind: 'action'
			id: string
			label: string
			run: () => void | Promise<void>
	  }
	| { kind: 'link'; id: string; label: string; href: string }

/**
 * TanStack-style brand context menu: right-click (or the context-menu key)
 * opens a small popover with copy/download actions and a link to the brand
 * guide. Left click on the child still navigates home.
 */
export function BrandContextMenu({ children }: BrandContextMenuProps) {
	const navigate = useNavigate()
	const menuId = useId()
	const rootRef = useRef<HTMLDivElement>(null)
	const menuRef = useRef<HTMLDivElement>(null)
	const [open, setOpen] = useState(false)
	const [coords, setCoords] = useState({ x: 0, y: 0 })
	const [activeIndex, setActiveIndex] = useState(0)

	const close = useCallback((options?: { restoreFocus?: boolean }) => {
		setOpen(false)
		setActiveIndex(0)
		if (options?.restoreFocus) {
			const focusTarget = rootRef.current?.querySelector<HTMLElement>(
				'a, button, [tabindex]:not([tabindex="-1"])',
			)
			focusTarget?.focus()
		}
	}, [])

	const copySvg = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(kodyMarkSvgMarkup('#000000'))
			toast.success('Copied SVG to clipboard', {
				id: 'kody-mark-svg-copied',
				description: 'Black mark markup is ready to paste.',
			})
		} catch {
			toast.error('Could not copy SVG', {
				id: 'kody-mark-svg-copy-failed',
				description: 'Download it from the brand guide instead.',
			})
		}
	}, [])

	const download = useCallback((href: string, filename: string) => {
		const anchor = document.createElement('a')
		anchor.href = publicAsset(href)
		anchor.download = filename
		anchor.rel = 'noopener'
		document.body.append(anchor)
		anchor.click()
		anchor.remove()
	}, [])

	const items: Array<MenuItem> = useMemo(
		() => [
			{
				kind: 'action',
				id: 'copy-svg',
				label: 'Copy logo as SVG',
				run: copySvg,
			},
			{
				kind: 'action',
				id: 'download-svg',
				label: 'Download SVG',
				run: () => download(kodyBrandAssets.svg, 'kody-mark.svg'),
			},
			{
				kind: 'action',
				id: 'download-png',
				label: 'Download PNG',
				run: () =>
					download(kodyBrandAssets.pngSolidLight, 'kody-mark-solid-light.png'),
			},
			{
				kind: 'link',
				id: 'brand-guide',
				label: 'Go to brand guide',
				href: kodyBrandAssets.guide,
			},
		],
		[copySvg, download],
	)

	const activate = useCallback(
		async (item: MenuItem) => {
			close({ restoreFocus: true })
			if (item.kind === 'link') {
				await navigate({ to: item.href })
				return
			}
			await item.run()
		},
		[close, navigate],
	)

	function openAt(clientX: number, clientY: number) {
		setCoords({ x: clientX, y: clientY })
		setActiveIndex(0)
		setOpen(true)
	}

	function onContextMenu(event: ReactMouseEvent) {
		event.preventDefault()
		event.stopPropagation()
		openAt(event.clientX, event.clientY)
	}

	function onKeyDown(event: ReactKeyboardEvent) {
		if (
			event.key === 'ContextMenu' ||
			(event.shiftKey && event.key === 'F10')
		) {
			event.preventDefault()
			const rect = rootRef.current?.getBoundingClientRect()
			if (!rect) return
			openAt(rect.left + rect.width / 2, rect.bottom)
		}
	}

	useEffect(() => {
		if (!open) return

		function onPointerDown(event: PointerEvent) {
			const target = event.target as Node | null
			if (!target) return
			if (menuRef.current?.contains(target)) return
			if (rootRef.current?.contains(target) && event.button === 2) return
			close()
		}

		function onKey(event: KeyboardEvent) {
			if (event.key === 'Escape') {
				event.preventDefault()
				close({ restoreFocus: true })
				return
			}
			const target = event.target
			const focusInsideMenu =
				target instanceof Node && Boolean(menuRef.current?.contains(target))
			if (!focusInsideMenu) {
				// Focus already left (for example after Tab): drop the menu so
				// the document listener stops intercepting page controls.
				close()
				return
			}
			if (event.key === 'Tab') {
				// Let Tab move focus, then close so later keys are not stolen.
				close()
				return
			}
			if (event.key === 'ArrowDown') {
				event.preventDefault()
				setActiveIndex((index) => (index + 1) % items.length)
				return
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault()
				setActiveIndex((index) => (index - 1 + items.length) % items.length)
				return
			}
			if (event.key === 'Home') {
				event.preventDefault()
				setActiveIndex(0)
				return
			}
			if (event.key === 'End') {
				event.preventDefault()
				setActiveIndex(items.length - 1)
				return
			}
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault()
				const item = items[activeIndex]
				if (!item) return
				void activate(item)
			}
		}

		function onFocusOut(event: FocusEvent) {
			const next = event.relatedTarget
			if (next instanceof Node && menuRef.current?.contains(next)) return
			close()
		}

		document.addEventListener('pointerdown', onPointerDown, true)
		document.addEventListener('keydown', onKey, true)
		menuRef.current?.addEventListener('focusout', onFocusOut)
		const menuNode = menuRef.current
		return () => {
			document.removeEventListener('pointerdown', onPointerDown, true)
			document.removeEventListener('keydown', onKey, true)
			menuNode?.removeEventListener('focusout', onFocusOut)
		}
	}, [open, activeIndex, close, items, activate])

	useEffect(() => {
		if (!open) return
		const active = menuRef.current?.querySelector<HTMLElement>(
			`[data-menu-index="${activeIndex}"]`,
		)
		active?.focus()
	}, [open, activeIndex])

	return (
		<div
			ref={rootRef}
			onContextMenu={onContextMenu}
			onKeyDown={onKeyDown}
			css={{ display: 'inline-flex' }}
		>
			{children}
			{open ? (
				<div
					ref={menuRef}
					id={menuId}
					role="menu"
					aria-label="Kody brand"
					css={menuCss}
					style={{ left: coords.x, top: coords.y }}
				>
					{items.map((item, index) => (
						<button
							key={item.id}
							type="button"
							role="menuitem"
							data-menu-index={index}
							tabIndex={index === activeIndex ? 0 : -1}
							css={itemCss}
							data-active={index === activeIndex ? '' : undefined}
							onMouseEnter={() => setActiveIndex(index)}
							onClick={() => void activate(item)}
						>
							{item.label}
						</button>
					))}
				</div>
			) : null}
		</div>
	)
}

const menuCss: CSSObject = {
	position: 'fixed',
	zIndex: 1000,
	minWidth: '13.5rem',
	margin: 0,
	padding: '0.35rem',
	display: 'grid',
	gap: '0.1rem',
	border: `1.5px solid ${colors.border}`,
	borderRadius: '12px',
	backgroundColor: colors.surface,
	boxShadow: shadows.md,
	color: colors.text,
	transform: 'translate(0, 0.25rem)',
}

const itemCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	minHeight: '2.25rem',
	padding: '0 0.75rem',
	border: 0,
	borderRadius: '8px',
	background: 'transparent',
	color: colors.text,
	font: 'inherit',
	fontSize: '0.92rem',
	fontWeight: 550,
	textAlign: 'left' as const,
	cursor: 'pointer',
	transition: `background-color ${transitions.fast}`,
	'&[data-active], &:focus-visible': {
		backgroundColor: colors.primarySoftest,
		outline: 'none',
	},
	[hoverMq]: {
		'&:hover': { backgroundColor: colors.primarySoftest },
	},
}
