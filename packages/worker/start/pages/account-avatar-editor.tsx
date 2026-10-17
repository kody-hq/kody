/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
	clampTransform,
	coverScale,
	cropRectFromTransform,
	initialCoverTransform,
	maxScale,
	panBy,
	resizeTransform,
	zoomAtPoint,
	type AvatarCropBounds,
	type AvatarCropTransform,
} from '#client/avatar-crop.ts'
import {
	decodeAvatarImage,
	prepareDecodedAvatarImage,
	scaleToMaxDimension,
	type AvatarImageBitmap,
} from '#client/prepare-avatar-image.ts'
import {
	userAvatarMaxDimension,
	userAvatarMinDimension,
} from '#universal/user-avatar-limits.ts'
import {
	getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	mq,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { accountFieldNoteCss } from './account-management-components.tsx'
const previewMaxDimension = 1600
const zoomStep = 1.15
const panStep = 16

export function AccountAvatarEditor({
	file,
	onCancel,
	onApply,
	onBusyChange,
}: {
	file: File
	onCancel: () => void
	onApply: (file: File) => void
	onBusyChange: (busy: boolean) => void
}) {
	const dialog = useRef<HTMLDialogElement>(null)
	const stage = useRef<HTMLDivElement>(null)
	const bitmap = useRef<AvatarImageBitmap | null>(null)
	const generation = useRef(0)
	const geometry = useRef<{
		viewportSize: number
		transform: AvatarCropTransform
	}>({ viewportSize: 280, transform: { scale: 1, offsetX: 0, offsetY: 0 } })
	const [transform, setTransform] = useState<AvatarCropTransform>({
		scale: 1,
		offsetX: 0,
		offsetY: 0,
	})
	const [viewportSize, setViewportSize] = useState(280)
	const [imageSize, setImageSize] = useState({ width: 0, height: 0 })
	const [previewUrl, setPreviewUrl] = useState<string | null>(null)
	const [status, setStatus] = useState<
		'idle' | 'decoding' | 'ready' | 'applying'
	>('decoding')
	const [error, setError] = useState<string | null>(null)
	const bounds = useCallback(
		(): AvatarCropBounds | null =>
			bitmap.current
				? {
						imageWidth: bitmap.current.width,
						imageHeight: bitmap.current.height,
						viewportSize: geometry.current.viewportSize,
					}
				: null,
		[],
	)
	const updateTransform = useCallback(
		(next: AvatarCropTransform) => {
			const box = bounds()
			const value = box ? clampTransform(box, next) : next
			geometry.current.transform = value
			setTransform(value)
		},
		[bounds],
	)
	const zoom = useCallback(
		(scale: number) => {
			const box = bounds()
			if (box)
				updateTransform(
					zoomAtPoint(
						box,
						geometry.current.transform,
						scale,
						box.viewportSize / 2,
						box.viewportSize / 2,
					),
				)
		},
		[bounds, updateTransform],
	)
	useEffect(() => {
		const generationRef = generation
		const ownGeneration = ++generationRef.current
		let ownedBitmap: AvatarImageBitmap | null = null
		let ownedUrl: string | null = null
		const oldOverflow = document.body.style.overflow
		document.body.style.overflow = 'hidden'
		dialog.current?.showModal()
		void (async () => {
			try {
				const decoded = await decodeAvatarImage(file)
				ownedBitmap = decoded
				if (ownGeneration !== generationRef.current) {
					decoded.close?.()
					return
				}
				if (
					decoded.width < userAvatarMinDimension ||
					decoded.height < userAvatarMinDimension
				)
					throw new Error(
						`Avatars must be between ${userAvatarMinDimension}px and ${userAvatarMaxDimension}px on each side.`,
					)
				const url = await createPreviewObjectUrl(decoded, file)
				ownedUrl = url
				if (ownGeneration !== generationRef.current) {
					URL.revokeObjectURL(url)
					return
				}
				bitmap.current = decoded
				const viewport = stage.current?.clientWidth || 280
				geometry.current.viewportSize = viewport
				setViewportSize(viewport)
				setImageSize({ width: decoded.width, height: decoded.height })
				updateTransform(
					initialCoverTransform({
						imageWidth: decoded.width,
						imageHeight: decoded.height,
						viewportSize: viewport,
					}),
				)
				setPreviewUrl(url)
				setStatus('ready')
			} catch (caught) {
				if (ownGeneration !== generationRef.current) return
				setError(
					caught instanceof Error
						? caught.message
						: 'Could not read that image in the browser.',
				)
				setStatus('idle')
			}
		})()
		return () => {
			generationRef.current++
			bitmap.current = null
			ownedBitmap?.close?.()
			if (ownedUrl) URL.revokeObjectURL(ownedUrl)
			document.body.style.overflow = oldOverflow
		}
	}, [file, updateTransform])
	useEffect(() => {
		const node = stage.current
		if (!node || status !== 'ready') return
		const pointers = new Map<number, { x: number; y: number }>()
		let distance = 0
		let last = { x: 0, y: 0 }
		const observer = new ResizeObserver(() => {
			const box = bounds()
			const next = node.clientWidth
			if (!box || next <= 0 || next === box.viewportSize) return
			const value = resizeTransform(
				box,
				{ ...box, viewportSize: next },
				geometry.current.transform,
			)
			geometry.current.viewportSize = next
			setViewportSize(next)
			updateTransform(value)
		})
		observer.observe(node)
		const down = (event: PointerEvent) => {
			if (event.button !== 0) return
			event.preventDefault()
			node.setPointerCapture(event.pointerId)
			pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
			last = { x: event.clientX, y: event.clientY }
			if (pointers.size === 2) {
				const [a, b] = [...pointers.values()]
				if (a && b) distance = Math.hypot(a.x - b.x, a.y - b.y)
			}
		}
		const move = (event: PointerEvent) => {
			if (!pointers.has(event.pointerId)) return
			event.preventDefault()
			pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
			const box = bounds()
			if (!box) return
			if (pointers.size >= 2) {
				const [a, b] = [...pointers.values()]
				if (!a || !b || distance <= 0) return
				const next = Math.hypot(a.x - b.x, a.y - b.y)
				const rect = node.getBoundingClientRect()
				updateTransform(
					zoomAtPoint(
						box,
						geometry.current.transform,
						(geometry.current.transform.scale * next) / distance,
						(a.x + b.x) / 2 - rect.left,
						(a.y + b.y) / 2 - rect.top,
					),
				)
				distance = next
			} else {
				updateTransform(
					panBy(
						box,
						geometry.current.transform,
						event.clientX - last.x,
						event.clientY - last.y,
					),
				)
				last = { x: event.clientX, y: event.clientY }
			}
		}
		const up = (event: PointerEvent) => {
			pointers.delete(event.pointerId)
			const remaining = [...pointers.values()][0]
			if (remaining) last = remaining
			if (pointers.size < 2) distance = 0
		}
		const wheel = (event: WheelEvent) => {
			event.preventDefault()
			const box = bounds()
			if (!box) return
			const rect = node.getBoundingClientRect()
			updateTransform(
				zoomAtPoint(
					box,
					geometry.current.transform,
					geometry.current.transform.scale * Math.exp(-event.deltaY * 0.002),
					event.clientX - rect.left,
					event.clientY - rect.top,
				),
			)
		}
		node.addEventListener('pointerdown', down)
		node.addEventListener('pointermove', move)
		node.addEventListener('pointerup', up)
		node.addEventListener('pointercancel', up)
		node.addEventListener('wheel', wheel, { passive: false })
		return () => {
			observer.disconnect()
			node.removeEventListener('pointerdown', down)
			node.removeEventListener('pointermove', move)
			node.removeEventListener('pointerup', up)
			node.removeEventListener('pointercancel', up)
			node.removeEventListener('wheel', wheel)
		}
	}, [status, bounds, updateTransform])
	function close() {
		if (status === 'applying') return
		dialog.current?.close()
		onCancel()
	}
	async function apply() {
		const box = bounds()
		const image = bitmap.current
		if (!file || !box || !image || status !== 'ready') return
		const ownGeneration = generation.current
		setStatus('applying')
		setError(null)
		onBusyChange(true)
		try {
			const prepared = await prepareDecodedAvatarImage(
				file,
				image,
				undefined,
				cropRectFromTransform(box, geometry.current.transform),
			)
			if (ownGeneration !== generation.current) return
			dialog.current?.close()
			onApply(prepared)
		} catch (caught) {
			if (ownGeneration !== generation.current) return
			setError(
				caught instanceof Error
					? caught.message
					: 'Unable to prepare that avatar.',
			)
			setStatus('ready')
			onBusyChange(false)
		}
	}
	const box = imageSize.width
		? {
				imageWidth: imageSize.width,
				imageHeight: imageSize.height,
				viewportSize,
			}
		: null
	const cover = box ? coverScale(box) : 1
	const maximum = box ? maxScale(box) : 1
	const canZoom = maximum - cover > 0.001
	const busy = status === 'decoding' || status === 'applying'
	return (
		<dialog
			ref={dialog}
			aria-labelledby="avatar-editor-title"
			data-testid="account-avatar-editor"
			css={editorDialogCss}
			onCancel={(event) => {
				event.preventDefault()
				close()
			}}
			onKeyDown={(event) => {
				if (
					status !== 'ready' ||
					(event.target instanceof HTMLInputElement &&
						event.target.type === 'range')
				)
					return
				const directions: Record<string, [number, number]> = {
					ArrowLeft: [panStep, 0],
					ArrowRight: [-panStep, 0],
					ArrowUp: [0, panStep],
					ArrowDown: [0, -panStep],
				}
				const delta = directions[event.key]
				const current = bounds()
				if (delta && current) {
					event.preventDefault()
					updateTransform(panBy(current, geometry.current.transform, ...delta))
				} else if (event.key === '+' || event.key === '=') {
					event.preventDefault()
					zoom(transform.scale * zoomStep)
				} else if (event.key === '-' || event.key === '_') {
					event.preventDefault()
					zoom(transform.scale / zoomStep)
				}
			}}
		>
			<div css={editorShellCss}>
				<div css={editorCopyCss}>
					<h3 id="avatar-editor-title" css={editorTitleCss}>
						Crop your avatar
					</h3>
					<p css={accountFieldNoteCss}>
						Drag to reposition. Pinch, scroll, or use the slider to zoom. The
						circle is how your avatar will look.
					</p>
				</div>
				{status === 'decoding' ? (
					<p css={accountFieldNoteCss}>Reading photo…</p>
				) : null}
				{status === 'ready' && previewUrl ? (
					<div
						ref={stage}
						data-testid="account-avatar-editor-stage"
						role="img"
						aria-label="Avatar crop preview"
						css={editorStageCss}
					>
						<img
							src={previewUrl}
							alt=""
							draggable={false}
							css={editorImageCss}
							style={{
								width: imageSize.width * transform.scale,
								height: imageSize.height * transform.scale,
								transform: `translate(${transform.offsetX}px, ${transform.offsetY}px)`,
							}}
						/>
						<div css={editorCircleMaskCss} />
					</div>
				) : null}
				{status === 'ready' ? (
					<div css={editorZoomRowCss}>
						<button
							type="button"
							aria-label="Zoom out"
							disabled={!canZoom || transform.scale <= cover}
							css={editorZoomButtonCss}
							onClick={() => zoom(transform.scale / zoomStep)}
						>
							−
						</button>
						<input
							type="range"
							min={cover}
							max={maximum}
							step="any"
							value={transform.scale}
							disabled={!canZoom}
							aria-label="Zoom"
							data-testid="account-avatar-editor-zoom"
							css={editorZoomSliderCss}
							onChange={(event) => zoom(Number(event.currentTarget.value))}
						/>
						<button
							type="button"
							aria-label="Zoom in"
							disabled={!canZoom || transform.scale >= maximum}
							css={editorZoomButtonCss}
							onClick={() => zoom(transform.scale * zoomStep)}
						>
							+
						</button>
					</div>
				) : null}
				{error ? (
					<p
						role="alert"
						css={{
							margin: 0,
							color: colors.error,
							fontSize: typography.fontSize.sm,
						}}
					>
						{error}
					</p>
				) : null}
				<div css={editorActionsCss}>
					<button
						type="button"
						disabled={status === 'applying'}
						css={editorGhostButtonCss}
						onClick={close}
					>
						Cancel
					</button>
					<button
						type="button"
						disabled={busy || status !== 'ready' || !!error}
						css={editorApplyButtonCss}
						onClick={() => void apply()}
					>
						{status === 'applying' ? 'Preparing…' : 'Use photo'}
					</button>
				</div>
			</div>
		</dialog>
	)
}

async function createPreviewObjectUrl(
	bitmap: AvatarImageBitmap,
	file: File,
): Promise<string> {
	try {
		const scaled = scaleToMaxDimension(
			bitmap.width,
			bitmap.height,
			previewMaxDimension,
		)
		const canvas = document.createElement('canvas')
		canvas.width = scaled.width
		canvas.height = scaled.height
		const context = canvas.getContext('2d')
		if (!context)
			throw new Error('Unable to convert that image in the browser.')
		context.drawImage(
			bitmap as CanvasImageSource,
			0,
			0,
			bitmap.width,
			bitmap.height,
			0,
			0,
			scaled.width,
			scaled.height,
		)
		const blob = await new Promise<Blob | null>((resolve, reject) => {
			try {
				canvas.toBlob(resolve, 'image/jpeg', 0.82)
			} catch (caught) {
				reject(caught)
			}
		})
		if (!blob) throw new Error('Unable to convert that image in the browser.')
		return URL.createObjectURL(blob)
	} catch {
		return URL.createObjectURL(file)
	}
}

const editorDialogCss: CSSObject = {
	width: 'min(28rem, calc(100vw - 1.5rem))',
	maxWidth: '100vw',
	maxHeight: '100dvh',
	margin: 'auto',
	padding: 0,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.lg,
	boxShadow: shadows.md,
	backgroundColor: colors.surface,
	color: colors.text,
	overflow: 'auto',
	overscrollBehavior: 'contain',
	'&::backdrop': {
		backgroundColor: 'oklch(0 0 0 / 0.55)',
	},
	[mq.mobile]: {
		width: '100vw',
		height: '100dvh',
		maxHeight: '100dvh',
		margin: 0,
		border: 'none',
		borderRadius: 0,
	},
}

const editorShellCss: CSSObject = {
	display: 'grid',
	gap: spacing.md,
	minHeight: 0,
	padding: spacing.lg,
	paddingBottom: `max(${spacing.lg}, env(safe-area-inset-bottom))`,
	paddingLeft: `max(${spacing.md}, env(safe-area-inset-left))`,
	paddingRight: `max(${spacing.md}, env(safe-area-inset-right))`,
	[mq.mobile]: {
		minHeight: '100dvh',
		gridTemplateRows: 'auto auto 1fr auto auto',
		alignContent: 'start',
	},
}

const editorCopyCss: CSSObject = {
	display: 'grid',
	gap: spacing.sm,
}

const editorTitleCss: CSSObject = {
	margin: 0,
	fontSize: '1.2rem',
	fontWeight: 720,
	letterSpacing: '-0.014em',
	lineHeight: 1.2,
}

const editorStageCss: CSSObject = {
	position: 'relative' as const,
	width: 'min(22rem, 100%)',
	aspectRatio: '1',
	marginInline: 'auto',
	overflow: 'hidden',
	borderRadius: radius.md,
	backgroundColor: colors.background,
	touchAction: 'none',
	cursor: 'grab',
	userSelect: 'none',
	outline: 'none',
	'&:focus-visible': {
		boxShadow: `0 0 0 3px ${colors.primarySoft}`,
	},
	[mq.mobile]: {
		width: 'min(22rem, calc(100vw - 2rem))',
		maxHeight: 'min(22rem, calc(100dvh - 16rem))',
	},
}

const editorImageCss: CSSObject = {
	position: 'absolute' as const,
	top: 0,
	left: 0,
	maxWidth: 'none',
	maxHeight: 'none',
	pointerEvents: 'none',
	userSelect: 'none',
}

const editorCircleMaskCss: CSSObject = {
	position: 'absolute' as const,
	inset: 0,
	borderRadius: '50%',
	border: `2px solid ${colors.onPrimary}`,
	boxShadow: `0 0 0 999px color-mix(in srgb, ${colors.background} 58%, transparent)`,
	pointerEvents: 'none',
}

const editorZoomRowCss: CSSObject = {
	display: 'grid',
	gridTemplateColumns: 'auto 1fr auto',
	alignItems: 'center',
	gap: spacing.sm,
}

const editorZoomButtonCss = [
	getGhostButtonCss({ size: 'sm' }),
	{
		minWidth: '2.75rem',
		minHeight: '2.75rem',
		padding: 0,
		fontSize: '1.25rem',
		lineHeight: 1,
		touchAction: 'manipulation',
	},
]

const editorZoomSliderCss: CSSObject = {
	width: '100%',
	height: '2.75rem',
	margin: 0,
	accentColor: colors.primary,
	touchAction: 'none',
	'&::-webkit-slider-thumb': {
		width: '1.5rem',
		height: '1.5rem',
	},
	'&::-moz-range-thumb': {
		width: '1.5rem',
		height: '1.5rem',
	},
}

const editorActionsCss: CSSObject = {
	display: 'flex',
	justifyContent: 'flex-end',
	flexWrap: 'wrap' as const,
	gap: spacing.sm,
	[mq.mobile]: {
		display: 'grid',
		gridTemplateColumns: '1fr 1fr',
		position: 'sticky' as const,
		bottom: 0,
		paddingTop: spacing.sm,
		backgroundColor: colors.surface,
	},
}

const editorGhostButtonCss = [
	getGhostButtonCss({ size: 'sm' }),
	{
		touchAction: 'manipulation',
		[mq.mobile]: {
			minHeight: '2.75rem',
			width: '100%',
		},
	},
]

const editorApplyButtonCss = [
	getPillButtonCss({ size: 'sm' }),
	{
		touchAction: 'manipulation',
		[mq.mobile]: {
			minHeight: '2.75rem',
			width: '100%',
		},
	},
]
