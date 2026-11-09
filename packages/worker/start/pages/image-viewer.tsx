/** @jsxImportSource @emotion/react */
import { ContextMenuSurface } from '../components/context-menu-surface.tsx'
import { createPortal } from 'react-dom'
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { FileAnchorContext } from './file-anchor-context.ts'
import { FileAnchorMarker } from './file-anchor-markers.tsx'
import { colors, typography } from '#universal/styles/tokens.ts'

const control = {
	display: 'inline-grid',
	placeItems: 'center',
	minWidth: 28,
	height: 28,
	border: 0,
	borderRadius: 5,
	background: 'transparent',
	color: colors.text,
	font: 'inherit',
	cursor: 'pointer',
	padding: '0 7px',
	'&:hover': {
		background: `color-mix(in srgb, ${colors.text} 8%, transparent)`,
	},
	'&:disabled': { opacity: 0.4, cursor: 'default' },
}
const clamp = (value: number) => Math.min(16, Math.max(0.02, value))

export function ImageViewer({ src, name }: { src: string; name: string }) {
	const comments = useContext(FileAnchorContext)
	const [showMarkers, setShowMarkers] = useState(true)
	const pins = new Map<string, { x: number; y: number }>()
	for (const thread of comments?.threads ?? []) {
		if (thread.anchor.kind === 'image' && !thread.outdated)
			pins.set(`${thread.anchor.x},${thread.anchor.y}`, thread.anchor)
	}

	const dialog = useRef<HTMLDialogElement>(null)
	const viewport = useRef<HTMLDivElement>(null)
	const image = useRef<HTMLImageElement>(null)
	const [size, setSize] = useState({ width: 0, height: 0 })
	const [bounds, setBounds] = useState({ width: 0, height: 0 })
	const [mode, setMode] = useState<'fit' | 'manual'>('fit')
	const [manualScale, setManualScale] = useState(1)
	const [fullscreen, setFullscreen] = useState(false)
	const [error, setError] = useState('')
	const points = useRef(new Map<number, { x: number; y: number }>())
	const anchor = useRef<{
		x: number
		y: number
		imageX: number
		imageY: number
	} | null>(null)
	const fit =
		size.width && size.height && bounds.width && bounds.height
			? Math.min(
					1,
					Math.max(1, bounds.width - 48) / size.width,
					Math.max(1, bounds.height - 48) / size.height,
				)
			: 1
	const scale = mode === 'fit' ? fit : manualScale
	const scaleRef = useRef(scale)
	scaleRef.current = scale

	useEffect(() => {
		const img = image.current
		if (img?.complete && img.naturalWidth) {
			setSize({ width: img.naturalWidth, height: img.naturalHeight })
		}
	}, [src, fullscreen])

	useEffect(() => {
		const element = viewport.current
		if (!element) return
		const observer = new ResizeObserver(([entry]) => {
			if (entry)
				setBounds({
					width: entry.contentRect.width,
					height: entry.contentRect.height,
				})
		})
		observer.observe(element)
		return () => observer.disconnect()
	}, [fullscreen])

	function zoom(value: number, clientX?: number, clientY?: number) {
		const element = viewport.current
		const img = image.current
		if (!element || !img || !size.width) return
		const box = element.getBoundingClientRect()
		const imageBox = img.getBoundingClientRect()
		const x = clientX ?? box.left + element.clientWidth / 2
		const y = clientY ?? box.top + element.clientHeight / 2
		anchor.current = {
			x: x - box.left,
			y: y - box.top,
			imageX: (x - imageBox.left) / scaleRef.current,
			imageY: (y - imageBox.top) / scaleRef.current,
		}
		const next = clamp(value)
		scaleRef.current = next
		setManualScale(next)
		setMode('manual')
	}

	useLayoutEffect(() => {
		const element = viewport.current
		const img = image.current
		const point = anchor.current
		if (!element || !img || !point) return
		anchor.current = null
		const box = element.getBoundingClientRect()
		const imageBox = img.getBoundingClientRect()
		element.scrollLeft +=
			imageBox.left - box.left + point.imageX * scale - point.x
		element.scrollTop += imageBox.top - box.top + point.imageY * scale - point.y
	}, [scale, mode])

	useEffect(() => {
		const element = viewport.current
		if (!element) return
		function wheel(event: WheelEvent) {
			if (!event.ctrlKey && !event.metaKey) return
			event.preventDefault()
			zoom(
				scaleRef.current * Math.exp(-event.deltaY * 0.01),
				event.clientX,
				event.clientY,
			)
		}
		element.addEventListener('wheel', wheel, { passive: false })
		return () => element.removeEventListener('wheel', wheel)
	})

	useLayoutEffect(() => {
		const element = dialog.current
		if (fullscreen && element && !element.open) element.showModal()
		if (!fullscreen && element?.open) element.close()
	}, [fullscreen])

	function toggleFullscreen() {
		anchor.current = null
		points.current.clear()
		setFullscreen((value) => !value)
	}

	function resetFit() {
		anchor.current = null
		setMode('fit')
		viewport.current?.scrollTo(0, 0)
	}

	const viewer = (
		<ContextMenuSurface
			resolve={(target, point) => {
				const img = image.current
				if (
					!comments?.onComment ||
					!img ||
					!size.width ||
					(target !== img && (point || target !== viewport.current))
				)
					return
				const rect = img.getBoundingClientRect()
				const x = point ? (point.x - rect.left) / rect.width : 0.5
				const y = point ? (point.y - rect.top) / rect.height : 0.5
				return [
					{
						id: 'comment-image',
						label: 'Comment here',
						run: () => {
							setFullscreen(false)
							setShowMarkers(true)
							comments.onComment?.({
								kind: 'image',
								x: Math.max(0, Math.min(1, x)),
								y: Math.max(0, Math.min(1, y)),
								revisionId: comments.revisionId,
							})
						},
					},
				]
			}}
		>
			<div
				onKeyDown={(event) => {
					if (event.ctrlKey || event.metaKey || event.altKey) return
					if (event.key === '+' || event.key === '=') zoom(scale * 1.25)
					else if (event.key === '-') zoom(scale / 1.25)
					else if (event.key === '0') resetFit()
					else if (event.key === '1') zoom(1)
					else if (event.key.toLowerCase() === 'f') void toggleFullscreen()
					else return
					event.preventDefault()
				}}
				css={{
					flex: 1,
					minHeight: 0,
					display: 'flex',
					flexDirection: 'column',
					background: colors.background,
					height: '100%',
				}}
			>
				<div
					css={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						flexWrap: 'wrap',
						gap: 3,
						padding: '5px 10px',
						fontSize: typography.fontSize.xs,
						borderBottom: `1px solid ${colors.borderSubtle}`,
						flexShrink: 0,
					}}
				>
					{pins.size > 0 && (
						<button
							type="button"
							css={control}
							onClick={() => setShowMarkers((value) => !value)}
						>
							{showMarkers ? 'Hide markers' : 'Show markers'}
						</button>
					)}
					<button
						css={control}
						aria-label="Zoom out"
						title="Zoom out (−)"
						disabled={!size.width || scale <= 0.02}
						onClick={() => zoom(scale / 1.25)}
					>
						−
					</button>
					<output
						aria-label="Zoom level"
						css={{
							minWidth: 47,
							textAlign: 'center',
							fontVariantNumeric: 'tabular-nums',
							color: colors.textMuted,
						}}
					>
						{Math.round(scale * 100)}%
					</output>
					<button
						css={control}
						aria-label="Zoom in"
						title="Zoom in (+)"
						disabled={!size.width || scale >= 16}
						onClick={() => zoom(scale * 1.25)}
					>
						+
					</button>
					<button
						css={control}
						aria-pressed={mode === 'fit'}
						onClick={resetFit}
						title="Fit to panel (0)"
					>
						Fit
					</button>
					<button
						css={control}
						aria-label="Actual size"
						title="Actual size (1)"
						onClick={() => zoom(1)}
					>
						1:1
					</button>
					<button
						css={control}
						aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
						title={fullscreen ? 'Exit fullscreen' : 'Fullscreen (F)'}
						onClick={() => void toggleFullscreen()}
					>
						<svg
							aria-hidden="true"
							width="16"
							height="16"
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.3"
						>
							<path
								d={
									fullscreen
										? 'M2 6h4V2m4 0v4h4M2 10h4v4m4 0v-4h4'
										: 'M6 2H2v4m8-4h4v4M2 10v4h4m4 0h4v-4'
								}
							/>
						</svg>
					</button>
				</div>
				{error && (
					<p role="status" css={{ margin: 8 }}>
						{error}
					</p>
				)}
				<div
					ref={viewport}
					role="region"
					aria-label="Image viewer"
					tabIndex={-1}
					css={{
						flex: 1,
						minHeight: 0,
						overflow: 'auto',
						touchAction: 'none',
						overscrollBehavior: 'contain',
						cursor: 'grab',
						'&:active': { cursor: 'grabbing' },
						userSelect: 'none',
					}}
					onDoubleClick={(event) => {
						if (mode === 'fit') zoom(1, event.clientX, event.clientY)
						else resetFit()
					}}
					onPointerDown={(event) => {
						if (
							event.button !== 0 ||
							(event.target instanceof Element &&
								event.target.closest('button'))
						)
							return
						points.current.set(event.pointerId, {
							x: event.clientX,
							y: event.clientY,
						})
						event.currentTarget.setPointerCapture(event.pointerId)
						event.currentTarget.focus({ preventScroll: true })
					}}
					onPointerMove={(event) => {
						const old = points.current.get(event.pointerId)
						if (!old) return
						const previous = [...points.current.values()]
						points.current.set(event.pointerId, {
							x: event.clientX,
							y: event.clientY,
						})
						const next = [...points.current.values()]
						const first = previous[0],
							second = previous[1],
							a = next[0],
							b = next[1]
						if (first && second && a && b) {
							const distance = Math.hypot(
								first.x - second.x,
								first.y - second.y,
							)
							if (distance > 0)
								zoom(
									(scaleRef.current * Math.hypot(a.x - b.x, a.y - b.y)) /
										distance,
									(a.x + b.x) / 2,
									(a.y + b.y) / 2,
								)
						} else {
							event.currentTarget.scrollLeft -= event.clientX - old.x
							event.currentTarget.scrollTop -= event.clientY - old.y
						}
					}}
					onPointerUp={(event) => points.current.delete(event.pointerId)}
					onPointerCancel={(event) => points.current.delete(event.pointerId)}
					onLostPointerCapture={(event) =>
						points.current.delete(event.pointerId)
					}
				>
					<div
						css={{
							display: 'grid',
							placeItems: 'center',
							width: `max(100%, ${size.width * scale + 48}px)`,
							height: `max(100%, ${size.height * scale + 48}px)`,
						}}
					>
						<div css={{ position: 'relative' }}>
							<img
								ref={image}
								src={src}
								alt={name}
								draggable={false}
								onError={() =>
									setError(
										'This image could not be opened. You can download the original file.',
									)
								}
								onLoad={(event) =>
									setSize({
										width: event.currentTarget.naturalWidth,
										height: event.currentTarget.naturalHeight,
									})
								}
								css={{
									display: 'block',
									width: size.width ? size.width * scale : undefined,
									height: size.height ? size.height * scale : undefined,
									maxWidth: 'none',
									objectFit: 'contain',
									WebkitTouchCallout: 'none',
									boxShadow: '0 2px 14px #0001',
								}}
							/>
							{showMarkers &&
								size.width > 0 &&
								Array.from(pins, ([key, pin]) => (
									<span
										key={key}
										css={{
											position: 'absolute',
											left: `${pin.x * 100}%`,
											top: `${pin.y * 100}%`,
											// Align the bubble’s tip at (5, 22) with the image point.
											transform: 'translate(-5px, -22px)',
											lineHeight: 0,
										}}
									>
										<FileAnchorMarker
											imagePin
											label="Open image comment"
											onOpen={() => setFullscreen(false)}
											matches={(anchor) =>
												anchor.kind === 'image' &&
												anchor.x === pin.x &&
												anchor.y === pin.y
											}
										/>
									</span>
								))}
						</div>
					</div>
				</div>
			</div>
		</ContextMenuSurface>
	)
	return (
		<>
			<dialog
				ref={dialog}
				aria-label={`Image viewer: ${name}`}
				onCancel={() => setFullscreen(false)}
				onClose={() => setFullscreen(false)}
				css={{
					width: '100vw',
					height: '100dvh',
					maxWidth: '100vw',
					maxHeight: '100dvh',
					margin: 0,
					padding: 0,
					border: 0,
					color: colors.text,
					background: colors.background,
					'&::backdrop': { background: colors.background },
				}}
			/>
			{fullscreen && dialog.current
				? createPortal(viewer, dialog.current)
				: viewer}
		</>
	)
}
