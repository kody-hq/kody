import type { PointerIntent, FlickSample } from './landing-pointer-state.ts'
export type { PointerIntent, FlickSample } from './landing-pointer-state.ts'

/** Slow walk of one lap around the real card set. */
export const TESTIMONIALS_LAP_MS = 45_000

const DRAG_THRESHOLD_PX = 8

/** Keep only recent pointer samples so a flick velocity is not diluted. */
const FLICK_SAMPLE_WINDOW_MS = 80

/**
 * Minimum release speed to coast. ~0.45px/ms is a quick swipe, not a
 * slow drag that should just stop.
 */
const FLICK_MIN_VELOCITY_PX_PER_MS = 0.45

/** Drop residual coast once it is slower than a crawl. */
const FLICK_STOP_VELOCITY_PX_PER_MS = 0.04

/** Exponential decay per millisecond. A hard flick travels about 1–2 cards. */
const FLICK_FRICTION_PER_MS = 0.003

/** Cap so a wild sample cannot sling the lane a full lap. */
const FLICK_MAX_VELOCITY_PX_PER_MS = 3

export function classifyPointerIntent(input: {
	dx: number
	dy: number
	thresholdPx?: number
}): PointerIntent {
	const threshold = input.thresholdPx ?? DRAG_THRESHOLD_PX
	const adx = Math.abs(input.dx)
	const ady = Math.abs(input.dy)
	if (adx < threshold && ady < threshold) return 'pending'
	if (ady >= adx) return 'scroll'
	return 'drag'
}

export function appendFlickSample(
	samples: ReadonlyArray<FlickSample>,
	sample: FlickSample,
	windowMs = FLICK_SAMPLE_WINDOW_MS,
): Array<FlickSample> {
	const oldest = sample.t - windowMs
	const next: Array<FlickSample> = []
	for (const entry of samples) {
		if (entry.t >= oldest) next.push(entry)
	}
	next.push(sample)
	return next
}

export function flickVelocityPxPerMs(samples: ReadonlyArray<FlickSample>) {
	const first = samples[0]
	const last = samples.at(-1)
	if (first == null || last == null) return 0
	const dt = last.t - first.t
	if (dt <= 0) return 0
	return (first.x - last.x) / dt
}

/**
 * Recent samples estimate release speed. A coalesced down/up pair, or a
 * jump after an early move, can sit farther apart than the window. Pair
 * the last prior sample with the release so velocity is that final hop.
 * A pause then release has last.x near end.x, so velocity stays zero.
 */
export function samplesForFlickVelocity(
	samples: ReadonlyArray<FlickSample>,
	end: FlickSample,
	windowMs = FLICK_SAMPLE_WINDOW_MS,
): Array<FlickSample> {
	const windowed = appendFlickSample(samples, end, windowMs)
	if (windowed.length >= 2) return windowed
	const last = samples.at(-1)
	if (last == null) return windowed
	return [last, end]
}

function clampFlickVelocity(
	velocity: number,
	maxAbs = FLICK_MAX_VELOCITY_PX_PER_MS,
) {
	return Math.max(-maxAbs, Math.min(maxAbs, velocity))
}

export function shouldCoastFlick(
	velocity: number,
	minAbs = FLICK_MIN_VELOCITY_PX_PER_MS,
) {
	return Math.abs(velocity) >= minAbs
}

export function stepFlickCoast(input: {
	offset: number
	velocity: number
	dt: number
}): { offset: number; velocity: number; done: boolean } {
	const dt = Math.min(Math.max(input.dt, 0), 48)
	if (dt === 0) {
		return { offset: input.offset, velocity: input.velocity, done: false }
	}
	const velocity = input.velocity * Math.exp(-FLICK_FRICTION_PER_MS * dt)
	if (Math.abs(velocity) < FLICK_STOP_VELOCITY_PX_PER_MS) {
		return { offset: input.offset, velocity: 0, done: true }
	}
	return {
		offset: input.offset + velocity * dt,
		velocity,
		done: false,
	}
}

/**
 * Close out a pointer gesture. Coalesced touch flicks often skip move
 * events, so a large horizontal jump on up still counts as a drag.
 */
export function finishPointerGesture(input: {
	startX: number
	startY: number
	lastX: number
	endX: number
	endY: number
	endT: number
	samples: ReadonlyArray<FlickSample>
	dragging: boolean
}): {
	offsetDelta: number
	dragging: boolean
	coastVelocity: number
} {
	let dragging = input.dragging
	let lastX = input.lastX
	if (!dragging) {
		const intent = classifyPointerIntent({
			dx: input.endX - input.startX,
			dy: input.endY - input.startY,
		})
		if (intent !== 'drag') {
			return { offsetDelta: 0, dragging: false, coastVelocity: 0 }
		}
		dragging = true
		lastX = input.startX
	}
	const samples = samplesForFlickVelocity(input.samples, {
		t: input.endT,
		x: input.endX,
	})
	const velocity = clampFlickVelocity(flickVelocityPxPerMs(samples))
	return {
		offsetDelta: lastX - input.endX,
		dragging: true,
		coastVelocity: shouldCoastFlick(velocity) ? velocity : 0,
	}
}

export type LanePlacement = {
	itemIndex: number
	x: number
	/** Second (or later) copy of the same quote, used when it straddles the seam. */
	seam: boolean
}

export function wrapPagerIndex(index: number, count: number) {
	if (count <= 0) return 0
	return ((index % count) + count) % count
}

/**
 * Hover pause is desktop-only. Coarse pointers and window-resize leave
 * `:hover` stuck on the strip, which freezes the lane. Keyboard `focus`
 * still pauses on every pointer class.
 */
export function canPauseOnHover(
	query: (query: string) => { matches: boolean } = (mediaQuery) =>
		typeof matchMedia === 'function'
			? matchMedia(mediaQuery)
			: { matches: false },
) {
	return query('(hover: hover) and (pointer: fine)').matches
}

export function isTestimonialsLanePaused(input: {
	inView: boolean
	userNudging: boolean
	focus: boolean
	hover: boolean
	matchesHover: boolean
	matchesFocusWithin: boolean
	hoverCapable?: boolean
}) {
	if (!input.inView || input.userNudging || input.focus) return true
	if (!(input.hoverCapable ?? canPauseOnHover())) return false
	return input.hover || input.matchesHover || input.matchesFocusWithin
}

export function wrapUnitInterval(value: number, period: number) {
	if (period <= 0) return 0
	const next = value % period
	return next < 0 ? next + period : next
}

/** Off-stage park if `[hidden]` loses to `display: flex` (see styles.css). */
export const PARKED_TRANSFORM = 'translate3d(-200vw, 0, 0)'

export type ParkableLaneCard = {
	hidden: HTMLElement['hidden']
	style: Pick<CSSStyleDeclaration, 'transform'>
}

export function placeLaneCard(node: ParkableLaneCard, x: number) {
	node.hidden = false
	node.style.transform = `translate3d(${x}px, 0, 0)`
}

function parkLaneCard(node: ParkableLaneCard) {
	node.hidden = true
	node.style.transform = PARKED_TRANSFORM
}

/** Hide and park every card that is not in this frame's used set. */
export function parkUnusedLaneCards<T extends ParkableLaneCard>(
	nodes: Iterable<T>,
	used: ReadonlySet<T>,
) {
	for (const node of nodes) {
		if (used.has(node)) continue
		parkLaneCard(node)
	}
}

/**
 * Visible + overscan placements on a circular lane.
 *
 * One logical quote can emit two placements when it straddles the wrap
 * (left edge and right edge at once). That is the extra seam copy — not a
 * 3× clone of the whole set.
 */
export function listLanePlacements(input: {
	count: number
	stride: number
	cardWidth: number
	offset: number
	viewportWidth: number
	overscan?: number
}): Array<LanePlacement> {
	const { count, stride, cardWidth, offset, viewportWidth } = input
	const overscan = input.overscan ?? stride
	const totalWidth = count * stride
	if (count <= 0 || stride <= 0 || totalWidth <= 0) return []

	const viewLeft = -overscan
	const viewRight = viewportWidth + overscan
	const placements: Array<LanePlacement> = []

	for (let itemIndex = 0; itemIndex < count; itemIndex += 1) {
		const primary = wrapUnitInterval(itemIndex * stride - offset, totalWidth)
		const firstLap = Math.floor((viewLeft - cardWidth - primary) / totalWidth)
		const lastLap = Math.ceil((viewRight - primary) / totalWidth)
		let copies = 0
		for (let lap = firstLap; lap <= lastLap; lap += 1) {
			const x = primary + lap * totalWidth
			if (x >= viewRight || x + cardWidth <= viewLeft) continue
			placements.push({ itemIndex, x, seam: copies > 0 })
			copies += 1
		}
	}

	return placements
}
