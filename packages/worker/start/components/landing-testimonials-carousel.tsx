/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { useEffect, useRef } from 'react'
import { SiteLink } from './site-link.tsx'
import { isElementNearViewport } from '#client/deferred-turnstile.ts'
import { revealRef } from './reveal.ts'
import {
	landingTestimonials,
	testimonialAttribution,
	testimonialInitials,
	testimonialStoryHref,
	type LandingTestimonial,
} from '#universal/landing-testimonials.ts'
import { renderIcon } from './icon.tsx'
import {
	TESTIMONIALS_LAP_MS,
	appendFlickSample,
	classifyPointerIntent,
	finishPointerGesture,
	isTestimonialsLanePaused,
	listLanePlacements,
	parkUnusedLaneCards,
	placeLaneCard,
	stepFlickCoast,
	wrapPagerIndex,
	wrapUnitInterval,
	type FlickSample,
} from '#client/routes/landing-testimonials-motion.ts'

const USER_NUDGE_RESUME_MS = 500

/**
 * Homepage testimonials strip. SSR and the first client render paint the
 * same canonical order , one DOM node per quote. Motion is enhance-only
 * (`html.js` + no reduced-motion): each card translates on a circular lane
 * so a fully exited card is recycled to the other end. A quote that
 * straddles the wrap gets a second aria-hidden copy so the lane never
 * shows a hole. Yields to hover,
 * focus-within, wheel, pointer-drag, and a flick coast after a fast
 * swipe. Reduced-motion + JS is a chevron
 * pager (one card, no rAF). No-JS keeps a stacked static list.
 */
export function LandingTestimonialsCarousel() {
	const fade = useRef<HTMLDivElement>(null)
	useEffect(() => {
		if (!fade.current) return
		const controller = new AbortController()
		armTestimonialsEnhance(fade.current, controller.signal)
		return () => controller.abort()
	}, [])
	const items: Array<LandingTestimonial> = [...landingTestimonials]

	return (
		<div
			className="landing-testimonials-marquee"
			aria-label="Testimonials"
			ref={revealRef()}
		>
			<div className="landing-testimonials-nav">
				<button
					type="button"
					className="landing-testimonials-nav-button"
					data-direction="prev"
					aria-label="Previous testimonial"
				>
					{renderChevron('prev')}
				</button>
				<button
					type="button"
					className="landing-testimonials-nav-button"
					data-direction="next"
					aria-label="Next testimonial"
				>
					{renderChevron('next')}
				</button>
			</div>
			<div className="landing-testimonials-fade" ref={fade}>
				<div className="landing-testimonials-track">
					{items.map((item) => renderTestimonialCard(item))}
				</div>
			</div>
		</div>
	)
}

function armTestimonialsEnhance(fade: HTMLElement, signal: AbortSignal) {
	const marquee = fade.closest('.landing-testimonials-marquee')
	const root = marquee instanceof HTMLElement ? marquee : fade

	if (typeof matchMedia === 'function') {
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
			armTestimonialsPager(root, signal)
			return
		}
	}

	armTestimonialsMotion(fade, signal)
}

function armTestimonialsPager(root: HTMLElement, signal: AbortSignal) {
	const cards = [
		...root.querySelectorAll<HTMLElement>('.landing-testimonial-card'),
	]
	if (cards.length === 0) return

	let index = 0

	function show(next: number) {
		index = wrapPagerIndex(next, cards.length)
		for (const [cardIndex, card] of cards.entries()) {
			const active = cardIndex === index
			card.classList.toggle('is-active', active)
			card.hidden = !active
		}
	}

	function onClick(event: Event) {
		const target = event.target
		if (!(target instanceof Element)) return
		const navButton = target.closest('.landing-testimonials-nav-button')
		if (!(navButton instanceof HTMLButtonElement)) return
		const direction = navButton.getAttribute('data-direction')
		if (direction === 'prev') show(index - 1)
		else if (direction === 'next') show(index + 1)
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowLeft') {
			event.preventDefault()
			show(index - 1)
			return
		}
		if (event.key === 'ArrowRight') {
			event.preventDefault()
			show(index + 1)
		}
	}

	show(0)
	root.addEventListener('click', onClick, { signal })
	root.addEventListener('keydown', onKeydown, { signal })
	signal.addEventListener(
		'abort',
		() => {
			for (const card of cards) {
				card.classList.remove('is-active')
				card.hidden = false
			}
		},
		{ once: true },
	)
}

function armTestimonialsMotion(scroller: HTMLElement, signal: AbortSignal) {
	const trackNode = scroller.querySelector('.landing-testimonials-track')
	if (!(trackNode instanceof HTMLElement)) return
	const track = trackNode

	let cards: Array<HTMLElement> = []
	let gap = 0
	let stride = 0
	let cardWidth = 0
	let viewportWidth = 0
	const seamClones: Array<HTMLElement> = []
	let inView = isElementNearViewport(scroller, '0px')
	let hover = false
	let focus = false
	let userNudging = false
	let userNudgeTimer: ReturnType<typeof setTimeout> | null = null
	let lastTs = 0
	let raf = 0
	let offset = 0
	let pointerId: number | null = null
	let dragStartX = 0
	let dragStartY = 0
	let dragLastX = 0
	let dragging = false
	let pointerHeld = false
	let flickSamples: Array<FlickSample> = []
	let coastVelocity = 0
	let suppressClick = false

	function isPaused() {
		return isTestimonialsLanePaused({
			inView,
			userNudging,
			focus,
			hover,
			matchesHover: scroller.matches(':hover'),
			matchesFocusWithin: scroller.matches(':focus-within'),
		})
	}

	function realCards() {
		if (cards.length === 0) {
			cards = [
				...track.querySelectorAll<HTMLElement>(
					':scope > .landing-testimonial-card',
				),
			].filter((card) => card.dataset.seam !== 'true')
		}
		return cards
	}

	function measure() {
		const sources = realCards()
		const first = sources[0]
		if (!first) return
		if (!track.classList.contains('is-virtual')) {
			gap = Number.parseFloat(getComputedStyle(track).gap) || 0
			cardWidth = first.offsetWidth
			stride = cardWidth + gap
			let tallest = 0
			for (const card of sources) {
				tallest = Math.max(tallest, card.offsetHeight)
			}
			track.style.minHeight = tallest > 0 ? `${tallest}px` : ''
			track.classList.add('is-virtual')
		} else {
			const sample = sources.find((card) => !card.hidden) ?? first
			cardWidth = sample.getBoundingClientRect().width
			stride = cardWidth + gap
		}
		viewportWidth = scroller.clientWidth
	}

	function fillSeamClone(
		node: HTMLElement,
		source: HTMLElement,
		itemIndex: number,
	) {
		if (node.dataset.index === String(itemIndex)) return
		node.innerHTML = source.innerHTML
		node.dataset.index = String(itemIndex)
		node.dataset.seam = 'true'
		node.setAttribute('aria-hidden', 'true')
		for (const link of node.querySelectorAll('a')) {
			link.setAttribute('tabindex', '-1')
		}
	}

	function takeSeamClone(source: HTMLElement, itemIndex: number, slot: number) {
		const existing = seamClones[slot]
		if (existing) {
			fillSeamClone(existing, source, itemIndex)
			return existing
		}
		const node = source.cloneNode(true) as HTMLElement
		node.dataset.seam = 'true'
		node.dataset.index = String(itemIndex)
		node.setAttribute('aria-hidden', 'true')
		for (const link of node.querySelectorAll('a')) {
			link.setAttribute('tabindex', '-1')
		}
		track.append(node)
		seamClones[slot] = node
		return node
	}

	function apply() {
		if (stride <= 0) measure()
		const sources = realCards()
		const count = sources.length
		const totalWidth = count * stride
		offset = wrapUnitInterval(offset, totalWidth)
		const placements = listLanePlacements({
			count,
			stride,
			cardWidth,
			offset,
			viewportWidth,
		})
		const used = new Set<HTMLElement>()
		let seamSlot = 0
		for (const placement of placements) {
			const source = sources[placement.itemIndex]
			if (!source) continue
			const node = placement.seam
				? takeSeamClone(source, placement.itemIndex, seamSlot++)
				: source
			placeLaneCard(node, placement.x)
			used.add(node)
		}
		parkUnusedLaneCards(sources, used)
		parkUnusedLaneCards(seamClones, used)
	}

	function markUserNudge() {
		userNudging = true
		if (userNudgeTimer != null) clearTimeout(userNudgeTimer)
		userNudgeTimer = setTimeout(() => {
			userNudging = false
			lastTs = 0
		}, USER_NUDGE_RESUME_MS)
	}

	function clearUserNudge() {
		userNudging = false
		if (userNudgeTimer != null) {
			clearTimeout(userNudgeTimer)
			userNudgeTimer = null
		}
	}

	function stopCoast() {
		coastVelocity = 0
	}

	function frame(now: number) {
		if (signal.aborted) return
		raf = requestAnimationFrame(frame)
		if (stride <= 0) measure()
		if (pointerHeld) {
			lastTs = 0
			return
		}
		if (coastVelocity !== 0) {
			if (focus) {
				stopCoast()
				lastTs = 0
				return
			}
			if (lastTs === 0) lastTs = now
			const dt = Math.min(now - lastTs, 48)
			lastTs = now
			const stepped = stepFlickCoast({
				offset,
				velocity: coastVelocity,
				dt,
			})
			offset = stepped.offset
			coastVelocity = stepped.velocity
			apply()
			if (stepped.done) lastTs = 0
			return
		}
		if (isPaused()) {
			lastTs = 0
			return
		}
		if (lastTs === 0) lastTs = now
		const dt = Math.min(now - lastTs, 48)
		lastTs = now
		const lapWidth = realCards().length * stride
		if (lapWidth <= 0) return
		offset += (lapWidth / TESTIMONIALS_LAP_MS) * dt
		apply()
	}

	function onWheel(event: WheelEvent) {
		const horizontal = event.shiftKey ? event.deltaY : event.deltaX
		if (horizontal === 0) return
		if (!event.shiftKey && Math.abs(event.deltaX) < Math.abs(event.deltaY)) {
			return
		}
		event.preventDefault()
		stopCoast()
		offset += horizontal
		markUserNudge()
		apply()
	}

	function recordPointerSamples(event: PointerEvent) {
		const coalesced =
			typeof event.getCoalescedEvents === 'function'
				? event.getCoalescedEvents()
				: []
		const events = coalesced.length > 0 ? coalesced : [event]
		for (const entry of events) {
			flickSamples = appendFlickSample(flickSamples, {
				t: entry.timeStamp,
				x: entry.clientX,
			})
		}
	}

	function captureScrollerPointer(id: number) {
		if (!scroller.isConnected || scroller.hasPointerCapture(id)) return
		scroller.setPointerCapture(id)
	}

	function releaseCapturedPointer(id: number) {
		if (!scroller.isConnected || !scroller.hasPointerCapture(id)) return
		scroller.releasePointerCapture(id)
	}

	function beginHorizontalDrag(event: PointerEvent) {
		dragging = true
		suppressClick = true
		stopCoast()
		scroller.style.touchAction = 'none'
		captureScrollerPointer(event.pointerId)
	}

	function endPointerGesture(event: PointerEvent) {
		if (pointerId !== event.pointerId) return
		pointerId = null
		pointerHeld = false
		releaseCapturedPointer(event.pointerId)
		scroller.style.touchAction = ''
		const finished = finishPointerGesture({
			startX: dragStartX,
			startY: dragStartY,
			lastX: dragLastX,
			endX: event.clientX,
			endY: event.clientY,
			endT: event.timeStamp,
			samples: flickSamples,
			dragging,
		})
		dragging = false
		flickSamples = []
		if (!finished.dragging) return
		suppressClick = true
		if (finished.offsetDelta !== 0) {
			offset += finished.offsetDelta
			apply()
		}
		if (finished.coastVelocity !== 0) {
			clearUserNudge()
			coastVelocity = finished.coastVelocity
			lastTs = 0
			return
		}
		markUserNudge()
	}

	function onPointerDown(event: PointerEvent) {
		if (event.pointerType === 'mouse' && event.button !== 0) return
		pointerId = event.pointerId
		dragStartX = dragLastX = event.clientX
		dragStartY = event.clientY
		dragging = false
		suppressClick = false
		pointerHeld = true
		stopCoast()
		flickSamples = []
		recordPointerSamples(event)
	}

	function onPointerMove(event: PointerEvent) {
		if (pointerId !== event.pointerId) return
		recordPointerSamples(event)
		const dx = event.clientX - dragStartX
		const dy = event.clientY - dragStartY
		if (!dragging) {
			const intent = classifyPointerIntent({ dx, dy })
			if (intent === 'pending') return
			if (intent === 'scroll') {
				const id = event.pointerId
				pointerId = null
				pointerHeld = false
				flickSamples = []
				releaseCapturedPointer(id)
				return
			}
			beginHorizontalDrag(event)
		}
		offset += dragLastX - event.clientX
		dragLastX = event.clientX
		markUserNudge()
		apply()
	}

	function onClickCapture(event: MouseEvent) {
		if (!suppressClick) return
		event.preventDefault()
		event.stopPropagation()
		suppressClick = false
	}

	function onFocusIn(event: FocusEvent) {
		focus = true
		const target = event.target
		if (!(target instanceof Element)) return
		const card = target.closest('.landing-testimonial-card')
		if (!(card instanceof HTMLElement)) return
		if (card.dataset.seam === 'true') return
		apply()
		const fadeBox = scroller.getBoundingClientRect()
		const cardBox = card.getBoundingClientRect()
		const pad = 32
		if (cardBox.left < fadeBox.left + pad) {
			offset -= fadeBox.left + pad - cardBox.left
		} else if (cardBox.right > fadeBox.right - pad) {
			offset += cardBox.right - (fadeBox.right - pad)
		}
		apply()
	}

	function onFocusOut(event: FocusEvent) {
		const next = event.relatedTarget
		if (next instanceof Node && scroller.contains(next)) return
		focus = false
	}

	function teardownVirtual() {
		for (const clone of seamClones) clone.remove()
		seamClones.length = 0
		for (const card of realCards()) {
			card.hidden = false
			card.style.transform = ''
		}
		track.classList.remove('is-virtual')
		track.style.minHeight = ''
	}

	scroller.addEventListener('wheel', onWheel, { passive: false, signal })
	scroller.addEventListener('pointerdown', onPointerDown, { signal })
	scroller.addEventListener('pointermove', onPointerMove, { signal })
	scroller.addEventListener('pointerup', endPointerGesture, { signal })
	scroller.addEventListener('pointercancel', endPointerGesture, { signal })
	// Pending presses do not capture, so a tap can still click name links.
	// Window terminals still end a lift that happens outside the fade.
	window.addEventListener('pointerup', endPointerGesture, { signal })
	window.addEventListener('pointercancel', endPointerGesture, { signal })
	scroller.addEventListener('click', onClickCapture, {
		capture: true,
		signal,
	})
	scroller.addEventListener(
		'pointerenter',
		(event) => {
			if (event.pointerType !== 'mouse') return
			hover = true
		},
		{ signal },
	)
	scroller.addEventListener(
		'pointerleave',
		() => {
			hover = false
		},
		{ signal },
	)
	scroller.addEventListener('focusin', onFocusIn, { signal })
	scroller.addEventListener('focusout', onFocusOut, { signal })
	window.addEventListener(
		'resize',
		() => {
			measure()
			apply()
		},
		{ passive: true, signal },
	)

	const visibilityObserver =
		typeof IntersectionObserver === 'undefined'
			? null
			: new IntersectionObserver(
					(entries) => {
						inView = entries.some((entry) => entry.isIntersecting)
					},
					{ root: null, rootMargin: '0px', threshold: 0 },
				)
	if (visibilityObserver) visibilityObserver.observe(scroller)
	else inView = true

	measure()
	raf = requestAnimationFrame(frame)
	signal.addEventListener(
		'abort',
		() => {
			cancelAnimationFrame(raf)
			if (userNudgeTimer != null) clearTimeout(userNudgeTimer)
			visibilityObserver?.disconnect()
			scroller.style.touchAction = ''
			teardownVirtual()
		},
		{ once: true },
	)
}

function renderChevron(direction: 'prev' | 'next') {
	return renderIcon(direction === 'prev' ? 'chevron-left' : 'chevron-right', {
		size: '1em',
	})
}

function renderTestimonialIdentity(item: LandingTestimonial) {
	const attribution = testimonialAttribution(item)
	return (
		<>
			{item.photo ? (
				<img
					src={publicAsset(item.photo)}
					alt=""
					width={56}
					height={56}
					className="landing-testimonial-photo"
					decoding="async"
					loading="lazy"
				/>
			) : (
				<span className="landing-testimonial-initials" aria-hidden="true">
					{testimonialInitials(item.name)}
				</span>
			)}
			<span className="landing-testimonial-meta">
				<span className="landing-testimonial-name">{item.name}</span>
				{attribution ? (
					<span className="landing-testimonial-title">{attribution}</span>
				) : null}
			</span>
		</>
	)
}

function renderTestimonialCard(item: LandingTestimonial) {
	const storyHref = testimonialStoryHref(item)
	const identity = renderTestimonialIdentity(item)
	return (
		<article key={item.name} className="landing-testimonial-card">
			<blockquote className="landing-testimonial-quote">
				<p>{item.quote}</p>
			</blockquote>
			<footer className="landing-testimonial-person">
				{item.href ? (
					<SiteLink
						href={item.href}
						className="landing-testimonial-identity landing-testimonial-link"
						target="_blank"
						rel="noopener noreferrer"
					>
						{identity}
					</SiteLink>
				) : (
					<div className="landing-testimonial-identity">{identity}</div>
				)}
				{storyHref ? (
					<SiteLink href={storyHref} className="landing-testimonial-story">
						Read the full story
						<span className="visually-hidden"> from {item.name}</span>
					</SiteLink>
				) : null}
			</footer>
		</article>
	)
}
