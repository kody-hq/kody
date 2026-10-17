import {
	clampToCavity,
	createLanternOrbBodies,
	lanternFlickVelocity,
	stepLanternOrbMotion,
	type LanternOrbBody,
	type LanternOrbHold,
	type LanternPointerSample,
} from '#universal/landing-lantern-motion.ts'
import { type LandingPrimitiveId } from '#universal/landing-lantern.ts'

/** Bubbles from the lantern so the leader overlay can redraw in the same frame. */
export const lanternOrbMotionEvent = 'lantern-orb-motion'

/** Fired on an orb when a drag ends, so the word can close without pointerleave. */
export const lanternOrbReleaseEvent = 'lantern-orb-release'

/** Movement before a press becomes a drag, so a tap can still open the word. */
const dragSlopPx = 8

const homes = new Map(
	createLanternOrbBodies().map((body) => [
		body.id,
		{ x: body.homeX, y: body.homeY },
	]),
)

/**
 * Move the orb layers and their hotspots together. Reduced motion leaves
 * every layer on its rest pose, including after a drag. A phone uses a
 * shorter wander so the small lantern does not look busy. A pointer can
 * grab one orb, drag it, and flick it; the toss then coasts inside the glass.
 */
export function attachLanternOrbMotion(node: Element, signal: AbortSignal) {
	if (!(node instanceof HTMLElement)) return
	const motionOk = matchMedia('(prefers-reduced-motion: no-preference)')
	const narrow = matchMedia('(max-width: 800px)')
	let bodies: Array<LanternOrbBody> = createLanternOrbBodies()
	let hold: LanternOrbHold | null = null
	let last = performance.now()
	let time = 0
	let raf: number | null = null
	let visible = false
	let pointerId: number | null = null
	let grabbedId: LandingPrimitiveId | null = null
	let dragged = false
	let swallowClick = false
	let originX = 0
	let originY = 0
	let offsetX = 0
	let offsetY = 0
	let samples: Array<LanternPointerSample> = []
	let swallowFrame: number | null = null

	const place = (drift: boolean) => {
		const width = node.getBoundingClientRect().width
		if (width === 0) return
		for (const body of bodies) {
			const home = homes.get(body.id)
			if (!home) continue
			const dx = drift ? (body.x - home.x) * width : 0
			const dy = drift ? (body.y - home.y) * width : 0
			const transform = drift
				? `translate3d(${dx.toFixed(2)}px, ${dy.toFixed(2)}px, 0)`
				: ''
			for (const el of node.querySelectorAll<HTMLElement>(
				`[data-orb="${body.id}"]`,
			)) {
				if (transform) el.style.transform = transform
				else el.style.removeProperty('transform')
			}
		}
		node.dispatchEvent(
			new CustomEvent(lanternOrbMotionEvent, { bubbles: true }),
		)
	}

	const amplitude = () => {
		if (!motionOk.matches) return 0
		return narrow.matches ? 0.62 : 1
	}

	const tick = (now: number) => {
		raf = null
		// A held orb is direct manipulation. A coast only keeps the loop
		// alive while motion is allowed, so turning reduced motion on
		// mid-toss snaps every orb back to rest.
		const gesture =
			hold !== null ||
			(motionOk.matches && bodies.some((body) => body.coasting))
		if (!motionOk.matches && !gesture) {
			bodies = createLanternOrbBodies()
			time = 0
			place(false)
			return
		}
		if (document.visibilityState === 'hidden') return
		if (!visible && !gesture) return
		const dt = Math.min(0.033, Math.max(0, (now - last) / 1000))
		last = now
		time += dt
		bodies = stepLanternOrbMotion(bodies, dt, {
			time,
			amplitude: amplitude(),
			hold,
		})
		place(true)
		raf = requestAnimationFrame(tick)
	}

	const sync = () => {
		const now = performance.now()
		const dt = Math.min(0.033, Math.max(0, (now - last) / 1000))
		last = now
		time += dt
		bodies = stepLanternOrbMotion(bodies, dt, {
			time,
			amplitude: amplitude(),
			hold,
		})
		place(true)
	}

	const wake = () => {
		last = performance.now()
		if (raf == null) raf = requestAnimationFrame(tick)
	}

	const clearGrabChrome = () => {
		delete node.dataset.grabbing
		document.documentElement.style.cursor = ''
		for (const el of node.querySelectorAll<HTMLElement>('[data-grabbed]')) {
			delete el.dataset.grabbed
		}
	}

	const clientToMotion = (clientX: number, clientY: number) => {
		const rect = node.getBoundingClientRect()
		if (rect.width === 0) return null
		return {
			x: (clientX - rect.left) / rect.width,
			y: (clientY - rect.top) / rect.width,
		}
	}

	const isOrbId = (value: string | undefined): value is LandingPrimitiveId =>
		bodies.some((body) => body.id === value)

	const endGrab = (flick: boolean, clientX: number, clientY: number) => {
		if (pointerId === null) return
		const id = grabbedId
		const pose = hold
		if (dragged && pose && id) {
			const velocity =
				flick && motionOk.matches
					? lanternFlickVelocity(samples, performance.now())
					: { vx: 0, vy: 0 }
			bodies = bodies.map((body) => {
				if (body.id !== id) return body
				const clamped = clampToCavity(pose.x, pose.y, body.radius)
				return {
					...body,
					x: clamped.x,
					y: clamped.y,
					vx: velocity.vx,
					vy: velocity.vy,
					coasting: Math.hypot(velocity.vx, velocity.vy) > 0,
				}
			})
		}
		if (dragged) {
			swallowClick = true
			// Click follows pointerup in this task. Drop the flag on the
			// next frame so a later keyboard activation still toggles.
			if (swallowFrame != null) cancelAnimationFrame(swallowFrame)
			swallowFrame = requestAnimationFrame(() => {
				swallowFrame = null
				swallowClick = false
			})
		}
		if (!motionOk.matches) {
			bodies = createLanternOrbBodies()
			place(false)
		} else if (dragged) {
			place(true)
		}
		pointerId = null
		grabbedId = null
		hold = null
		const released = dragged
		dragged = false
		samples = []
		clearGrabChrome()
		if (released && id) releaseHover(id, clientX, clientY)
		wake()
	}

	const releaseHover = (
		id: LandingPrimitiveId,
		clientX: number,
		clientY: number,
	) => {
		const orb = node.querySelector<HTMLElement>(`[data-orb="${id}"]`)
		if (!orb) return
		// The disc can move out from under a still pointer, so
		// pointerleave never fires and the word would stay open.
		orb.dataset.suppressHover = ''
		if (document.activeElement === orb) orb.blur()
		orb.dispatchEvent(new Event(lanternOrbReleaseEvent))
		const coasting = bodies.some((body) => body.id === id && body.coasting)
		if (coasting) return
		// A drop that stays under the cursor is a real hover. A toss
		// keeps the flag until a later move is no longer over the disc,
		// so an early move cannot clear it before the disc leaves.
		const hit = document.elementFromPoint(clientX, clientY)
		if (hit instanceof Node && orb.contains(hit)) {
			delete orb.dataset.suppressHover
		}
	}

	const clearSuppressedHover = (event: PointerEvent) => {
		if (pointerId !== null) return
		const hit = document.elementFromPoint(event.clientX, event.clientY)
		for (const el of node.querySelectorAll<HTMLElement>(
			'[data-suppress-hover]',
		)) {
			if (hit instanceof Node && el.contains(hit)) continue
			delete el.dataset.suppressHover
		}
	}

	const onPointerDown = (event: PointerEvent) => {
		if (pointerId !== null) return
		swallowClick = false
		if (node.dataset.decorative != null) return
		if (event.button !== 0) return
		if (!(event.target instanceof Element)) return
		const orb = event.target.closest('[data-orb]')
		if (!(orb instanceof HTMLElement) || !node.contains(orb)) return
		if (!isOrbId(orb.dataset.orb)) return
		const point = clientToMotion(event.clientX, event.clientY)
		if (!point) return
		pointerId = event.pointerId
		grabbedId = orb.dataset.orb
		dragged = false
		originX = event.clientX
		originY = event.clientY
		samples = [{ ...point, t: performance.now() }]
		hold = null
		try {
			orb.setPointerCapture(event.pointerId)
		} catch {
			// The pointer can already be inactive. Moves that reach this
			// node still drag, and pointerup ends the gesture.
		}
	}

	const onPointerMove = (event: PointerEvent) => {
		if (event.pointerId !== pointerId || grabbedId === null) return
		const point = clientToMotion(event.clientX, event.clientY)
		if (!point) return
		samples.push({ ...point, t: performance.now() })
		if (samples.length > 12) samples.shift()
		if (!dragged) {
			const travel = Math.hypot(
				event.clientX - originX,
				event.clientY - originY,
			)
			if (travel < dragSlopPx) return
			const body = bodies.find((entry) => entry.id === grabbedId)
			if (!body) return
			dragged = true
			offsetX = point.x - body.x
			offsetY = point.y - body.y
			node.dataset.grabbing = ''
			document.documentElement.style.cursor = 'grabbing'
			// A touch drag focuses the orb and would leave the bottom
			// sheet open after the flick. A tap still focuses and toggles.
			if (event.pointerType === 'touch') {
				const active = document.activeElement
				if (active instanceof HTMLElement && node.contains(active)) {
					active.blur()
				}
			}
			const orb = node.querySelector<HTMLElement>(`[data-orb="${grabbedId}"]`)
			if (orb) orb.dataset.grabbed = ''
		}
		const velocity = lanternFlickVelocity(samples, performance.now())
		hold = {
			id: grabbedId,
			x: point.x - offsetX,
			y: point.y - offsetY,
			vx: velocity.vx,
			vy: velocity.vy,
		}
		if (event.cancelable) event.preventDefault()
		sync()
		wake()
	}

	const onPointerUp = (event: PointerEvent) => {
		if (event.pointerId !== pointerId) return
		const point = clientToMotion(event.clientX, event.clientY)
		if (point) {
			samples.push({ ...point, t: performance.now() })
			if (dragged && grabbedId && hold) {
				hold = {
					id: grabbedId,
					x: point.x - offsetX,
					y: point.y - offsetY,
					vx: hold.vx,
					vy: hold.vy,
				}
			}
		}
		endGrab(true, event.clientX, event.clientY)
	}

	const onPointerCancel = (event: PointerEvent) => {
		if (event.pointerId !== pointerId) return
		endGrab(false, event.clientX, event.clientY)
	}

	node.addEventListener('pointerdown', onPointerDown, { signal })
	node.addEventListener(
		'click',
		(event) => {
			if (!swallowClick) return
			swallowClick = false
			event.preventDefault()
			event.stopPropagation()
		},
		{ capture: true, signal },
	)
	window.addEventListener(
		'pointermove',
		(event) => {
			clearSuppressedHover(event)
			onPointerMove(event)
		},
		{ signal },
	)
	window.addEventListener('pointerup', onPointerUp, { signal })
	window.addEventListener('pointercancel', onPointerCancel, { signal })

	const observer = new IntersectionObserver(([entry]) => {
		visible = entry?.isIntersecting ?? false
		wake()
	})
	observer.observe(node)
	motionOk.addEventListener('change', wake, { signal })
	narrow.addEventListener('change', wake, { signal })
	document.addEventListener('visibilitychange', wake, { signal })
	signal.addEventListener('abort', () => {
		observer.disconnect()
		if (raf != null) cancelAnimationFrame(raf)
		if (swallowFrame != null) cancelAnimationFrame(swallowFrame)
		clearGrabChrome()
	})
}
