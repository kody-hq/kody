/** @jsxImportSource @emotion/react */
import { primitiveFeatureHref } from '#universal/primitive-cards.ts'
import { useEffect, useReducer, useRef, type CSSProperties } from 'react'
import { SiteLink } from './site-link.tsx'
import { docHref } from '#universal/docs-nav.ts'
import {
	landingHomePrimitives,
	landingPrimitivesIntroLead,
	landingPrimitivesMoreLead,
	landingPrimitivesMoreLink,
	type LandingHomePrimitive,
} from '#universal/landing-home-copy.ts'
import {
	landingLanternGlass,
	landingLeaderOrbAnchor,
	landingLeaderOrbExit,
	landingLeaderPath,
	landingLeaderWordAnchor,
	landingPrimitiveColorVar,
	landingPrimitiveIds,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'
import { LandingLantern } from './landing-lantern.tsx'
import { lanternOrbMotionEvent } from './landing-lantern-motion.ts'

/**
 * `/features` primitives block: the locked intro line, then the five-orb
 * lantern with the five words listed beside it, then the learn-more line
 * ("What is Kody?" → intro guide). Orbs highlight a primitive and draw
 * leader lines to its word; each word links to that primitive's feature page.
 *
 * Leader lines run from each orb to the colored dot before its word. They
 * are measured from layout and redrawn on resize and font load, so they
 * track wrapping. The overlay is `display: none` on narrow screens
 * and the measurement skips while it is hidden. No-JS keeps the definitions
 * in the document for read-out and simply has no lines.
 */

const landingPrimitivesSectionId = 'primitives'

const whatIsKodyHref = docHref('what-is-kody')

/** Measure orbs and words, then write the leader paths in section pixels. */
function attachLeaderFollow(node: Element, signal: AbortSignal) {
	const svg = node.querySelector<SVGSVGElement>('.landing-primitives-leaders')
	const stage = node.querySelector<HTMLElement>('.landing-primitives-stage')
	if (!svg || !stage) return
	const words = node.querySelector<HTMLElement>('.landing-primitives-words')
	const lanternArt = node.querySelector<HTMLElement>('.landing-lantern-art')

	const draw = () => {
		if (getComputedStyle(svg).display === 'none') return
		const origin = stage.getBoundingClientRect()
		if (origin.width === 0) return
		svg.setAttribute('viewBox', `0 0 ${origin.width} ${origin.height}`)
		if (lanternArt) {
			// Lines run faint inside the glass and come up to full strength
			// as they leave it (see the mask in styles.css).
			const art = lanternArt.getBoundingClientRect()
			svg.style.setProperty(
				'--glass-x',
				`${art.left - origin.left + art.width * landingLanternGlass.x}px`,
			)
			svg.style.setProperty(
				'--glass-y',
				`${art.top - origin.top + art.height * landingLanternGlass.y}px`,
			)
			svg.style.setProperty(
				'--glass-r',
				`${art.width * landingLanternGlass.r}px`,
			)
		}
		for (const id of landingPrimitiveIds) {
			const orb = node.querySelector<HTMLElement>(`[data-orb="${id}"]`)
			const dot = node.querySelector<HTMLElement>(`[data-dot="${id}"]`)
			const leader = svg.querySelector<SVGGElement>(`[data-primitive="${id}"]`)
			if (!orb || !dot || !leader) continue
			const orbRect = orb.getBoundingClientRect()
			const centre = landingLeaderOrbAnchor(orbRect, origin)
			const to = landingLeaderWordAnchor(dot.getBoundingClientRect(), origin)
			const from = landingLeaderOrbExit(centre, to, orbRect.width / 2)
			const d = landingLeaderPath(from, to)
			for (const path of leader.querySelectorAll('path')) {
				path.setAttribute('d', d)
			}
		}
		svg.dataset.ready = ''
	}

	let frame: number | null = null
	const schedule = () => {
		if (frame != null) return
		frame = requestAnimationFrame(() => {
			frame = null
			draw()
		})
	}

	// Same frame as the orb step, so the leaders meet the moving rims.
	node.addEventListener(lanternOrbMotionEvent, draw, { signal })

	const observer = new ResizeObserver(schedule)
	observer.observe(stage)
	if (words) observer.observe(words)
	window.addEventListener('resize', schedule, { signal })
	const narrow = matchMedia('(max-width: 800px)')
	narrow.addEventListener('change', schedule, { signal })
	document.fonts?.ready.then(schedule).catch(() => {})
	schedule()
	signal.addEventListener('abort', () => {
		observer.disconnect()
		if (frame != null) cancelAnimationFrame(frame)
	})
}

function renderLeaders(activeId: LandingPrimitiveId | null) {
	return (
		<svg
			className="landing-primitives-leaders"
			aria-hidden="true"
			focusable={false}
			preserveAspectRatio="none"
		>
			{landingPrimitiveIds.map((id) => (
				<g
					key={id}
					className="landing-leader"
					data-primitive={id}
					data-open={activeId === id ? '' : undefined}
					style={
						{
							'--primitive-color': landingPrimitiveColorVar(id),
						} as CSSProperties
					}
				>
					<path className="landing-leader-halo" fill="none" />
					<path className="landing-leader-base" fill="none" />
					<path className="landing-leader-flow" fill="none" />
				</g>
			))}
		</svg>
	)
}

/** A click that lands this soon after hover or focus opened the same
 *  primitive is the same gesture (tap: focus then click), not a toggle. */
const toggleGraceMs = 400

type DisclosureState = {
	openId: LandingPrimitiveId | null
	dismissedId: LandingPrimitiveId | null
	openedAt: number
}
type DisclosureAction = {
	type: 'open' | 'toggle' | 'close' | 'dismiss' | 'resume'
	id: LandingPrimitiveId
	now: number
}
function disclosureReducer(
	state: DisclosureState,
	action: DisclosureAction,
): DisclosureState {
	const { id, type, now } = action
	if (type === 'resume')
		return state.dismissedId === id ? { ...state, dismissedId: null } : state
	if (
		type === 'dismiss' ||
		(type === 'toggle' &&
			state.openId === id &&
			now - state.openedAt > toggleGraceMs)
	)
		return {
			...state,
			openId: state.openId === id ? null : state.openId,
			dismissedId: id,
		}
	if (type === 'close')
		return state.openId === id ? { ...state, openId: null } : state
	if (state.openId === id) return state
	return {
		openId: id,
		openedAt: now,
		dismissedId:
			state.openId ?? (state.dismissedId === id ? null : state.dismissedId),
	}
}
export function LandingPrimitives() {
	const [{ openId }, dispatch] = useReducer(disclosureReducer, {
		openId: null,
		dismissedId: null,
		openedAt: 0,
	})
	const section = useRef<HTMLElement>(null)
	useEffect(() => {
		if (!section.current) return
		const controller = new AbortController()
		attachLeaderFollow(section.current, controller.signal)
		return () => controller.abort()
	}, [])
	function setOpen(id: LandingPrimitiveId) {
		dispatch({ type: 'open', id, now: performance.now() })
	}
	function toggle(id: LandingPrimitiveId) {
		dispatch({ type: 'toggle', id, now: performance.now() })
	}
	function close(id: LandingPrimitiveId) {
		dispatch({ type: 'close', id, now: 0 })
	}
	function dismiss(id: LandingPrimitiveId) {
		dispatch({ type: 'dismiss', id, now: 0 })
	}
	function clearDismissed(id: LandingPrimitiveId) {
		dispatch({ type: 'resume', id, now: 0 })
	}

	return (
		<section
			id={landingPrimitivesSectionId}
			aria-labelledby="primitives-title"
			className="landing-primitives"
			data-active={openId ?? undefined}
			ref={section}
		>
			<h2 id="primitives-title" className="landing-primitives-lead">
				{landingPrimitivesIntroLead}
			</h2>
			<div className="landing-primitives-stage">
				<LandingLantern
					activeId={openId}
					onOpen={setOpen}
					onToggle={toggle}
					onClose={close}
					onDismiss={dismiss}
					onResume={clearDismissed}
				/>
				{renderLeaders(openId)}
				<ul
					className="landing-primitives-words"
					aria-label="The five primitives"
				>
					{landingHomePrimitives.map((primitive) => (
						<li key={primitive.id} className="landing-primitive-item">
							<LandingPrimitiveWord
								primitive={primitive}
								highlighted={openId === primitive.id}
							/>
						</li>
					))}
				</ul>
			</div>
			<p className="landing-primitives-more">
				{landingPrimitivesMoreLead}{' '}
				<SiteLink href={whatIsKodyHref} className="landing-inline-link">
					{landingPrimitivesMoreLink}
				</SiteLink>
			</p>
		</section>
	)
}

function LandingPrimitiveWord({
	primitive,
	highlighted,
}: {
	primitive: LandingHomePrimitive
	highlighted: boolean
}) {
	return (
		<span
			className="landing-primitive"
			data-open={highlighted ? '' : undefined}
			style={
				{
					'--primitive-color': landingPrimitiveColorVar(primitive.id),
				} as CSSProperties
			}
		>
			<span
				className="landing-primitive-dot"
				data-dot={primitive.id}
				aria-hidden="true"
			/>
			<SiteLink
				href={primitiveFeatureHref(primitive.id)}
				className="landing-primitive-word"
				data-word={primitive.id}
			>
				{primitive.word}
			</SiteLink>
		</span>
	)
}
