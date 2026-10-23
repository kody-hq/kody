/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
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
import {
	kodyBrandAssets,
	kodyMarkOutlinedSvgMarkup,
} from '../brand/kody-mark-path.ts'
import { kodyLogoOutlinedSvgMarkup } from '../brand/kody-logo.ts'
import { colors, shadows, transitions } from '#universal/styles/tokens.ts'
import { hoverMq } from '#universal/styles/style-primitives.ts'

type BrandContextMenuProps = {
	children: ReactNode
}

type PlateTone = 'light' | 'dark'

type BrandFile = { href: string; filename: string }

/** One downloadable treatment: a preview, its SVG, and an optional PNG. */
type BrandVariant = {
	id: string
	label: string
	tone: PlateTone
	shape: 'logo' | 'mark' | 'tile'
	preview: string
	svg?: BrandFile
	png: BrandFile
}

type MenuItem =
	| {
			kind: 'action'
			id: string
			label: string
			run: () => void | Promise<void>
	  }
	| { kind: 'link'; id: string; label: string; href: string }

const brandVariants: Array<BrandVariant> = [
	{
		id: 'logo-light',
		label: 'Logo (light)',
		tone: 'light',
		shape: 'logo',
		preview: kodyBrandAssets.logoSvgOutlined,
		svg: {
			href: kodyBrandAssets.logoSvgOutlined,
			filename: 'kody-logo-outlined.svg',
		},
		png: {
			href: kodyBrandAssets.logoPngOutlined,
			filename: 'kody-logo-outlined.png',
		},
	},
	{
		id: 'logo-dark',
		label: 'Logo (dark)',
		tone: 'dark',
		shape: 'logo',
		preview: kodyBrandAssets.logoSvgWhite,
		svg: {
			href: kodyBrandAssets.logoSvgWhite,
			filename: 'kody-logo-white.svg',
		},
		png: {
			href: kodyBrandAssets.logoPngWhite,
			filename: 'kody-logo-white.png',
		},
	},
	{
		id: 'mark-light',
		label: 'Mark (light)',
		tone: 'light',
		shape: 'mark',
		preview: kodyBrandAssets.svgOutlined,
		svg: {
			href: kodyBrandAssets.svgOutlined,
			filename: 'kody-mark-outlined.svg',
		},
		png: {
			href: kodyBrandAssets.pngOutlined,
			filename: 'kody-mark-outlined.png',
		},
	},
	{
		id: 'mark-dark',
		label: 'Mark (dark)',
		tone: 'dark',
		shape: 'mark',
		preview: kodyBrandAssets.svgWhite,
		svg: { href: kodyBrandAssets.svgWhite, filename: 'kody-mark-white.svg' },
		png: { href: kodyBrandAssets.pngWhite, filename: 'kody-mark-white.png' },
	},
	{
		id: 'tile-light',
		label: 'App icon (light)',
		tone: 'light',
		shape: 'tile',
		preview: kodyBrandAssets.svgOutlined,
		png: {
			href: kodyBrandAssets.pngOutlinedSolidLight,
			filename: 'kody-mark-outlined-solid-light.png',
		},
	},
	{
		id: 'tile-dark',
		label: 'App icon (dark)',
		tone: 'dark',
		shape: 'tile',
		preview: kodyBrandAssets.svgWhite,
		png: {
			href: kodyBrandAssets.pngSolidDark,
			filename: 'kody-mark-solid-dark.png',
		},
	},
]

const guideItem: MenuItem = {
	kind: 'link',
	id: 'brand-guide',
	label: 'All brand assets',
	href: kodyBrandAssets.guide,
}

/**
 * TanStack-style brand context menu: right-click (or the context-menu key)
 * on the mark or the wordmark opens a popover that previews every logo, mark,
 * and app-icon variant. A row downloads its SVG (or the PNG when that is the
 * only format); the trailing chip downloads the PNG. Left click on the child
 * still navigates home.
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

	const copySvg = useCallback(async (markup: string, what: string) => {
		try {
			await navigator.clipboard.writeText(markup)
			toast.success('Copied SVG to clipboard', {
				id: 'kody-brand-svg-copied',
				description: `Outlined light-mode ${what} markup is ready to paste.`,
			})
		} catch {
			toast.error('Could not copy SVG', {
				id: 'kody-brand-svg-copy-failed',
				description: 'Download it from the brand guide instead.',
			})
		}
	}, [])

	const download = useCallback((file: BrandFile) => {
		const anchor = document.createElement('a')
		anchor.href = publicAsset(file.href)
		anchor.download = file.filename
		anchor.rel = 'noopener'
		document.body.append(anchor)
		anchor.click()
		anchor.remove()
	}, [])

	const copyItems: Array<MenuItem> = useMemo(
		() => [
			{
				kind: 'action',
				id: 'copy-logo-svg',
				label: 'Copy logo as SVG',
				run: () => copySvg(kodyLogoOutlinedSvgMarkup('#000000'), 'logo'),
			},
			{
				kind: 'action',
				id: 'copy-mark-svg',
				label: 'Copy mark as SVG',
				run: () => copySvg(kodyMarkOutlinedSvgMarkup('#000000'), 'mark'),
			},
		],
		[copySvg],
	)

	// Each variant contributes its row item, then its PNG chip when the row
	// itself downloads the SVG, so arrow keys walk them in reading order.
	const variantItems = useMemo(
		() =>
			brandVariants.map((variant) => {
				const primary = variant.svg ?? variant.png
				const format = variant.svg ? 'SVG' : 'PNG'
				const row: MenuItem = {
					kind: 'action',
					id: variant.id,
					label: `Download ${variant.label} ${format}`,
					run: () => download(primary),
				}
				const chip: MenuItem | null = variant.svg
					? {
							kind: 'action',
							id: `${variant.id}-png`,
							label: `Download ${variant.label} PNG`,
							run: () => download(variant.png),
						}
					: null
				return { variant, format, row, chip }
			}),
		[download],
	)

	const items = useMemo(
		() => [
			...copyItems,
			...variantItems.flatMap(({ row, chip }) => (chip ? [row, chip] : [row])),
			guideItem,
		],
		[copyItems, variantItems],
	)

	function itemProps(item: MenuItem) {
		const index = items.indexOf(item)
		return {
			type: 'button' as const,
			role: 'menuitem',
			'data-menu-index': index,
			tabIndex: index === activeIndex ? 0 : -1,
			'data-active': index === activeIndex ? '' : undefined,
			onMouseEnter: () => setActiveIndex(index),
			onClick: () => void activate(item),
		}
	}

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

	// The menu is wider than the old text-only list; keep it inside the
	// viewport when the pointer is near the right or bottom edge.
	useLayoutEffect(() => {
		if (!open) return
		const menu = menuRef.current
		if (!menu) return
		const rect = menu.getBoundingClientRect()
		const margin = 8
		const x = Math.max(
			margin,
			Math.min(coords.x, window.innerWidth - rect.width - margin),
		)
		const y = Math.max(
			margin,
			Math.min(coords.y, window.innerHeight - rect.height - margin),
		)
		if (x !== coords.x || y !== coords.y) setCoords({ x, y })
	}, [open, coords])

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
			if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
				event.preventDefault()
				setActiveIndex((index) => (index + 1) % items.length)
				return
			}
			if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
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
					{copyItems.map((item) => (
						<button key={item.id} {...itemProps(item)} css={textItemCss}>
							{item.label}
						</button>
					))}
					<div role="separator" css={separatorCss} />
					{variantItems.map(({ variant, format, row, chip }) => (
						<div key={variant.id} css={variantRowCss}>
							<button
								{...itemProps(row)}
								aria-label={row.label}
								css={variantItemCss}
							>
								<span css={variantLabelCss}>
									{variant.label}
									<span>{format}</span>
								</span>
								<span
									css={[plateCss, plateShapeCss[variant.shape]]}
									data-tone={variant.tone}
								>
									<img src={publicAsset(variant.preview)} alt="" />
								</span>
							</button>
							{chip ? (
								<button
									{...itemProps(chip)}
									aria-label={chip.label}
									css={chipCss}
								>
									PNG
								</button>
							) : (
								<span css={chipSpacerCss} />
							)}
						</div>
					))}
					<div role="separator" css={separatorCss} />
					<button {...itemProps(guideItem)} css={textItemCss}>
						{guideItem.label}
					</button>
				</div>
			) : null}
		</div>
	)
}

const menuCss: CSSObject = {
	position: 'fixed',
	zIndex: 1000,
	width: 'min(21rem, calc(100vw - 1rem))',
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

const activeItemCss: CSSObject = {
	'&[data-active], &:focus-visible': {
		backgroundColor: colors.primarySoftest,
		outline: 'none',
	},
	[hoverMq]: {
		'&:hover': { backgroundColor: colors.primarySoftest },
	},
}

const baseItemCss: CSSObject = {
	border: 0,
	borderRadius: '8px',
	background: 'transparent',
	color: colors.text,
	font: 'inherit',
	fontSize: '0.92rem',
	fontWeight: 550,
	textAlign: 'left',
	cursor: 'pointer',
	transition: `background-color ${transitions.fast}`,
	...activeItemCss,
}

const textItemCss: CSSObject = {
	...baseItemCss,
	display: 'flex',
	alignItems: 'center',
	minHeight: '2.25rem',
	padding: '0 0.75rem',
}

const separatorCss: CSSObject = {
	height: '1px',
	margin: '0.3rem 0.5rem',
	backgroundColor: colors.border,
}

const variantRowCss: CSSObject = {
	display: 'grid',
	gridTemplateColumns: 'minmax(0, 1fr) auto',
	alignItems: 'center',
	gap: '0.25rem',
}

const variantItemCss: CSSObject = {
	...baseItemCss,
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: '0.75rem',
	minHeight: '3rem',
	padding: '0.35rem 0.5rem 0.35rem 0.75rem',
}

const variantLabelCss: CSSObject = {
	display: 'grid',
	gap: '0.1rem',
	'& > span': {
		font: '600 0.68rem/1 ui-monospace, "SF Mono", Menlo, monospace',
		letterSpacing: '0.06em',
		color: colors.textMuted,
	},
}

const plateCss: CSSObject = {
	flex: 'none',
	display: 'grid',
	placeItems: 'center',
	height: '2.25rem',
	boxShadow: `0 0 0 1px ${colors.border}`,
	'&[data-tone="light"]': { backgroundColor: '#ffffff' },
	'&[data-tone="dark"]': { backgroundColor: '#000000' },
	'& img': { display: 'block', height: '1.35rem', width: 'auto' },
}

const plateShapeCss: Record<BrandVariant['shape'], CSSObject> = {
	logo: { padding: '0 0.85rem', borderRadius: '999px' },
	mark: { padding: '0 0.7rem', borderRadius: '999px' },
	tile: {
		width: '2.25rem',
		borderRadius: '9px',
		'& img': { height: 'auto', width: '1.55rem' },
	},
}

const chipCss: CSSObject = {
	...baseItemCss,
	minWidth: '2.75rem',
	height: '2rem',
	padding: '0 0.5rem',
	textAlign: 'center',
	font: '600 0.7rem/1 ui-monospace, "SF Mono", Menlo, monospace',
	letterSpacing: '0.06em',
	color: colors.textMuted,
	boxShadow: `inset 0 0 0 1px ${colors.border}`,
}

const chipSpacerCss: CSSObject = {
	minWidth: '2.75rem',
}
