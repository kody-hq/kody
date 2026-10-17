import { publicAsset } from '../public-assets.ts'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { SiteLink } from './site-link.tsx'
import {
	resolveWithAgentOrder,
	withAgentHref,
	withAgentIconSrc,
	type WithAgent,
} from '#universal/with-agents.ts'

const hintId = 'landing-agents-hint'

/**
 * Homepage hero row of agent marks, each linking to its `/with/:agent` page.
 * The order is shuffled once on the server (`landingAgentOrder` loader data)
 * so hydrate matches. The real list sits between two aria-hidden copies.
 * Without JavaScript the copies are hidden and the row is a plain
 * horizontal scroller. With JavaScript (`attachAgentMarqueeMotion`) the copies
 * show, the scroll position wraps by one list width so scrolling never
 * ends, the row drifts when motion is allowed and nobody is using it, and
 * the list is a single tab stop with arrow keys between marks. Styles:
 * `.landing-agents` in `public/styles.css`.
 */
export function LandingAgentMarquee({
	order,
}: {
	order?: ReadonlyArray<string> | null
}) {
	const [initialOrder] = useState(() => resolveWithAgentOrder(order))
	const stage = useRef<HTMLElement>(null)
	useEffect(() => {
		const node = stage.current
		if (!node) return
		const controller = new AbortController()
		attachAgentMarqueeMotion(node, controller.signal)
		return () => controller.abort()
	}, [])
	return (
		<nav
			ref={stage}
			className="landing-agents"
			aria-label="Agents that work with Kody"
		>
			<span id={hintId} hidden>
				Use the arrow keys to move between agents.
			</span>
			<ul className="landing-agents-track">
				{initialOrder.map((agent) => renderAgent(agent, 'before'))}
				{initialOrder.map((agent) => renderAgent(agent, null))}
				{initialOrder.map((agent) => renderAgent(agent, 'after'))}
			</ul>
		</nav>
	)
}

function renderAgent(agent: WithAgent, loopCopy: 'before' | 'after' | null) {
	return (
		<li
			key={loopCopy ? `${agent.slug}-${loopCopy}` : agent.slug}
			className="landing-agents-item"
			aria-hidden={loopCopy ? 'true' : undefined}
		>
			<SiteLink
				href={withAgentHref(agent.slug)}
				className="landing-agent"
				draggable={false}
				// Real links leave tabindex to the roving focus in
				// `attachAgentMarqueeMotion`; rendering it would reset that on update.
				{...(loopCopy ? { tabIndex: -1 } : {})}
			>
				<span
					className="landing-agent-icon"
					aria-hidden="true"
					style={
						{
							'--agent-icon': `url(${publicAsset(withAgentIconSrc(agent))})`,
						} as CSSProperties
					}
				></span>
				<span className="landing-agent-name">{agent.name}</span>
			</SiteLink>
		</li>
	)
}

/** Drift speed in CSS pixels per second. */
const driftSpeed = 28
/** Pause the drift this long after someone scrolls, swipes, or drags. */
const idleAfterUseMs = 2500
/** Pointer travel before a press on a mark becomes a drag instead of a click. */
const dragThreshold = 6
/** How many marks away from the pointer the magnification reaches. */
const magnifyReach = 2.5

function attachAgentMarqueeMotion(node: HTMLElement, signal: AbortSignal) {
	const list = node.querySelector<HTMLElement>('.landing-agents-track')
	if (!list) return
	const items = [...list.querySelectorAll<HTMLElement>('.landing-agents-item')]
	const count = items.length / 3
	if (!Number.isInteger(count) || count === 0) return
	const links = items
		.slice(count, count * 2)
		.map((item) => item.querySelector<HTMLAnchorElement>('.landing-agent'))
		.filter((link): link is HTMLAnchorElement => link != null)
	if (links.length !== count) return

	node.classList.add('is-looping')
	for (const link of links) link.setAttribute('aria-describedby', hintId)

	let active = 0
	const setActive = (index: number) => {
		active = index
		links.forEach((link, i) => {
			link.tabIndex = i === index ? 0 : -1
		})
	}
	setActive(0)

	let setWidth = 0
	let pos = 0
	const measure = () => {
		const start = items[count]?.offsetLeft ?? 0
		const end = items[count * 2]?.offsetLeft ?? 0
		const next = end - start
		if (next <= 0) return
		pos = setWidth > 0 ? next + (pos - setWidth) : next
		setWidth = next
	}
	const keyboardFocusInside = () =>
		node.contains(document.activeElement) &&
		document.activeElement?.matches(':focus-visible') === true
	// Keep the view inside the middle third. The copies make the jump
	// invisible. Keyboard focus is on a real mark, so it must stay put.
	const wrap = () => {
		if (setWidth <= 0 || keyboardFocusInside()) return 0
		let shift = 0
		if (pos < setWidth * 0.5) shift = setWidth
		else if (pos >= setWidth * 1.5) shift = -setWidth
		pos += shift
		return shift
	}
	const apply = () => {
		node.scrollLeft = pos
	}

	measure()
	apply()

	let usedUntil = 0
	const markUsed = () => {
		usedUntil = performance.now() + idleAfterUseMs
	}
	let hovering = false
	let pressed = false

	// Dock-style magnification: every mark scales by its distance to the
	// mouse, not by whether the mouse is over it, and the marks around
	// the pointer make room. Centers come from layout (offsetLeft), so
	// the transforms written here never feed back into the measurement.
	const motionOk = matchMedia('(prefers-reduced-motion: no-preference)')
	const style = getComputedStyle(node)
	const iconSize = parseFloat(style.getPropertyValue('--agent-size')) || 64
	const maxZoom = parseFloat(style.getPropertyValue('--agent-zoom')) || 1.25
	let pointerX: number | null = null
	let magnifyRaf: number | null = null
	const magnify = () => {
		magnifyRaf = null
		const px = pointerX
		if (px == null) {
			for (const item of items) {
				item.style.removeProperty('--agent-scale')
				item.style.removeProperty('--agent-x')
				item.classList.remove('is-nearest')
			}
			return
		}
		const start = trackStart()
		const pitch =
			(items[1]?.offsetLeft ?? 0) - (items[0]?.offsetLeft ?? 0) || 90
		const radius = pitch * magnifyReach
		let nearest = -1
		let nearestDistance = Infinity
		const extras = items.map((item, index) => {
			const center =
				item.offsetLeft - start + item.offsetWidth / 2 - node.scrollLeft
			const distance = Math.abs(center - px)
			if (distance < nearestDistance) {
				nearestDistance = distance
				nearest = index
			}
			const t =
				distance < radius
					? (1 + Math.cos((Math.PI * distance) / radius)) / 2
					: 0
			const scale = 1 + (maxZoom - 1) * t
			item.style.setProperty('--agent-scale', scale.toFixed(4))
			return iconSize * (scale - 1)
		})
		const total = extras.reduce((sum, extra) => sum + extra, 0)
		let before = 0
		extras.forEach((extra, index) => {
			const item = items[index]
			if (!item) return
			item.style.setProperty(
				'--agent-x',
				`${(before + extra / 2 - total / 2).toFixed(2)}px`,
			)
			before += extra
			item.classList.toggle(
				'is-nearest',
				index === nearest && nearestDistance < pitch / 2,
			)
		})
	}
	const scheduleMagnify = () => {
		if (magnifyRaf == null) magnifyRaf = requestAnimationFrame(magnify)
	}
	node.addEventListener(
		'pointermove',
		(event) => {
			if (!(event instanceof PointerEvent) || event.pointerType !== 'mouse')
				return
			if (!motionOk.matches) return
			pointerX = event.clientX - node.getBoundingClientRect().left
			node.classList.add('is-magnifying')
			scheduleMagnify()
		},
		{ signal, passive: true },
	)
	const stopMagnifying = () => {
		pointerX = null
		node.classList.remove('is-magnifying')
		scheduleMagnify()
	}
	node.addEventListener('pointerleave', stopMagnifying, { signal })
	motionOk.addEventListener(
		'change',
		() => {
			if (!motionOk.matches) stopMagnifying()
		},
		{ signal },
	)

	node.addEventListener(
		'scroll',
		() => {
			if (pointerX != null) scheduleMagnify()
			if (Math.abs(node.scrollLeft - pos) < 1) return
			pos = node.scrollLeft
			if (wrap() !== 0) apply()
		},
		{ signal, passive: true },
	)
	node.addEventListener('wheel', markUsed, { signal, passive: true })
	node.addEventListener('touchstart', markUsed, { signal, passive: true })
	node.addEventListener('touchend', markUsed, { signal, passive: true })
	node.addEventListener(
		'pointerenter',
		(event) => {
			if (event instanceof PointerEvent && event.pointerType === 'mouse') {
				hovering = true
			}
		},
		{ signal },
	)
	node.addEventListener(
		'pointerleave',
		() => {
			hovering = false
		},
		{ signal },
	)

	// Mouse drag scrolls the row. Touch and trackpads scroll natively.
	let drag: {
		id: number
		startX: number
		startPos: number
		moved: boolean
	} | null = null
	let suppressClick = false
	let clickTimer: ReturnType<typeof setTimeout> | null = null
	node.addEventListener(
		'pointerdown',
		(event) => {
			if (!(event instanceof PointerEvent)) return
			if (event.pointerType !== 'mouse' || event.button !== 0) return
			drag = {
				id: event.pointerId,
				startX: event.clientX,
				startPos: pos,
				moved: false,
			}
			pressed = true
		},
		{ signal },
	)
	const endDrag = () => {
		if (!drag) return
		if (drag.moved) {
			// The click a drag produces fires in the same task as its
			// pointerup; anything later (or a drag with no click) is fresh.
			suppressClick = true
			if (clickTimer != null) clearTimeout(clickTimer)
			clickTimer = setTimeout(() => {
				clickTimer = null
				suppressClick = false
			})
			node.classList.remove('is-dragging')
			markUsed()
		}
		drag = null
		pressed = false
	}
	node.addEventListener(
		'pointermove',
		(event) => {
			if (!(event instanceof PointerEvent) || !drag) return
			if (event.pointerId !== drag.id) return
			if ((event.buttons & 1) === 0) {
				endDrag()
				return
			}
			const dx = event.clientX - drag.startX
			if (!drag.moved) {
				if (Math.abs(dx) < dragThreshold) return
				drag.moved = true
				try {
					node.setPointerCapture(drag.id)
				} catch {
					// The pointer is already gone; moves still drag the row.
				}
				node.classList.add('is-dragging')
			}
			pos = drag.startPos - dx
			drag.startPos += wrap()
			apply()
			markUsed()
		},
		{ signal },
	)
	// A press can end anywhere, including outside the row.
	window.addEventListener('pointerup', endDrag, { signal })
	window.addEventListener('pointercancel', endDrag, { signal })
	node.addEventListener(
		'click',
		(event) => {
			if (!suppressClick) return
			suppressClick = false
			event.preventDefault()
			event.stopPropagation()
		},
		{ signal, capture: true },
	)

	const trackStart = () => items[0]?.offsetLeft ?? 0
	const centeredLeft = (item: HTMLElement) =>
		item.offsetLeft - trackStart() - (node.clientWidth - item.offsetWidth) / 2
	// Shift the view by whole list widths (invisible, since the copies
	// match) so the real mark sits next to what is on screen, then glide.
	const reveal = (index: number) => {
		const item = items[count + index]
		if (!item) return
		if (setWidth > 0) {
			pos += Math.round((centeredLeft(item) - pos) / setWidth) * setWidth
			apply()
		}
		const left = centeredLeft(item)
		if (motionOk.matches) {
			node.scrollTo({ left, behavior: 'smooth' })
		} else {
			pos = left
			apply()
		}
	}
	const centeredIndex = (left: number) => {
		const center = left + node.clientWidth / 2 + trackStart()
		const hit = items.findIndex(
			(item) =>
				item.offsetLeft <= center &&
				center < item.offsetLeft + item.offsetWidth,
		)
		return hit < 0 ? active : hit % count
	}
	node.addEventListener(
		'focusin',
		(event) => {
			const index = links.indexOf(event.target as HTMLAnchorElement)
			if (index < 0) return
			const from = event.relatedTarget
			const tabbedIn =
				!(from instanceof Node && node.contains(from)) &&
				links[index]?.matches(':focus-visible')
			if (!tabbedIn) {
				if (index !== active) setActive(index)
				return
			}
			// Tabbing in lands on the mark in the middle of the view, not
			// wherever the drift has carried the last active one. `pos` is
			// the view before the browser scrolls the focused link into view.
			const target = centeredIndex(pos)
			setActive(target)
			if (target !== index) links[target]?.focus({ preventScroll: true })
			apply()
			reveal(target)
		},
		{ signal },
	)
	node.addEventListener(
		'keydown',
		(event) => {
			if (!(event instanceof KeyboardEvent)) return
			const index = links.indexOf(event.target as HTMLAnchorElement)
			if (index < 0) return
			let next: number
			switch (event.key) {
				case 'ArrowRight':
					next = (index + 1) % count
					break
				case 'ArrowLeft':
					next = (index - 1 + count) % count
					break
				case 'Home':
					next = 0
					break
				case 'End':
					next = count - 1
					break
				default:
					return
			}
			event.preventDefault()
			setActive(next)
			links[next]?.focus({ preventScroll: true })
			reveal(next)
		},
		{ signal },
	)

	let visible = false
	let raf: number | null = null
	let last = performance.now()
	const drifting = () =>
		visible &&
		motionOk.matches &&
		!hovering &&
		!pressed &&
		!keyboardFocusInside() &&
		performance.now() >= usedUntil
	const tick = (now: number) => {
		raf = null
		const dt = Math.min(0.05, (now - last) / 1000)
		last = now
		if (drifting()) {
			pos += driftSpeed * dt
			wrap()
			apply()
		}
		if (visible && motionOk.matches) raf = requestAnimationFrame(tick)
	}
	const wake = () => {
		last = performance.now()
		if (raf == null && visible && motionOk.matches) {
			raf = requestAnimationFrame(tick)
		}
	}
	const observer = new IntersectionObserver(([entry]) => {
		visible = entry?.isIntersecting ?? false
		wake()
	})
	observer.observe(node)
	const resize = new ResizeObserver(() => {
		measure()
		wrap()
		apply()
	})
	resize.observe(list)
	motionOk.addEventListener('change', wake, { signal })

	signal.addEventListener('abort', () => {
		if (clickTimer != null) clearTimeout(clickTimer)
		if (drag && node.hasPointerCapture(drag.id))
			node.releasePointerCapture(drag.id)
		observer.disconnect()
		resize.disconnect()
		if (raf != null) cancelAnimationFrame(raf)
		if (magnifyRaf != null) cancelAnimationFrame(magnifyRaf)
		node.classList.remove('is-looping', 'is-dragging', 'is-magnifying')
		for (const link of links) {
			link.removeAttribute('aria-describedby')
			link.removeAttribute('tabindex')
		}
		for (const item of items) {
			item.style.removeProperty('--agent-scale')
			item.style.removeProperty('--agent-x')
			item.classList.remove('is-nearest')
		}
	})
}
