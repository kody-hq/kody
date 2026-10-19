/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import { useEffect, useMemo, useRef, type CSSProperties } from 'react'
import { stageParallaxRef } from './hero-stage.tsx'
import { LandingLantern } from './landing-lantern.tsx'
import {
	landingLantern,
	landingOrbitAgents,
	landingOrbitTetherPath,
} from '#universal/landing-agent-orbit.ts'
import {
	landingLanternGlass,
	landingOrbitLightTone,
	landingPrimitiveColorVar,
} from '#universal/landing-lantern.ts'
import {
	listAllWalkthroughHosts,
	type WalkthroughHost,
	type WalkthroughHostPick,
} from '#universal/walkthrough-hosts.ts'

/**
 * Proof stage: the same five-orb lantern as the primitives section, with the
 * agents you already use floating around it. Connector lines stay off;
 * travelling orbs still run both ways on the same clocks. Orbit positions
 * live in `#universal/landing-agent-orbit`.
 */

/** Slot motion. Identities come from the SSR-shuffled catalog: pinned hosts
 *  always make the ring, leftover slots fill from the rest, then allRow
 *  order assigns them so hydrate matches. `dur`/`del` drive the drift.
 *  `cycle`/`phase`/`travel` (seconds at rate 1) drive each tether's lights:
 *  inbound and outbound share the cycle, outbound offset by ~0.42 of it,
 *  in flight for `travel`. The frame loop advances that clock slower at
 *  rest and faster as the pointer (desktop) or lantern (mobile) nears.
 *  Periods are deliberately unequal so the lights overlap in ever-changing
 *  combinations. Order matches `landingOrbitAgents`. */
const hostAgentMotion = [
	{ dur: '8s', del: '-2s', cycle: 3.4, phase: 0.8, travel: 1.45 },
	{ dur: '8.5s', del: '-1.5s', cycle: 4.8, phase: 2.6, travel: 1.9 },
	{ dur: '6s', del: '-1s', cycle: 3.8, phase: 2.0, travel: 1.25 },
	{ dur: '7.5s', del: '-6s', cycle: 5.6, phase: 0.4, travel: 2.4 },
	{ dur: '9s', del: '-4s', cycle: 3.2, phase: 1.4, travel: 1.55 },
	{ dur: '6.5s', del: '-5s', cycle: 5.9, phase: 4.0, travel: 1.8 },
	{ dur: '5.5s', del: '-2.5s', cycle: 4.2, phase: 1.8, travel: 1.3 },
	{ dur: '9.5s', del: '-3.5s', cycle: 5.1, phase: 3.4, travel: 2.2 },
] as const

const landingHeroSlots = landingOrbitAgents.map((agent, index) => ({
	x: agent.x,
	y: agent.y,
	...hostAgentMotion[index]!,
}))

/** Always on the homepage ring. Everyone else competes for leftover slots. */
const landingHeroPinnedHostIds = ['grok-bot', 'chatgpt', 'claude-code'] as const

export type LandingHeroAgent = (typeof landingHeroSlots)[number] & {
	label: string
	icon: string
}

export function pickLandingHeroRing(
	allRow: ReadonlyArray<WalkthroughHost>,
	slotCount: number = landingHeroSlots.length,
): Array<WalkthroughHost> {
	const order = allRow.length > 0 ? allRow : listAllWalkthroughHosts()
	const pinnedIds = new Set<string>(landingHeroPinnedHostIds)
	const pinned = order.filter((host) => pinnedIds.has(host.id))
	const rest = order.filter((host) => !pinnedIds.has(host.id))
	const selectedIds = new Set(
		[...pinned, ...rest].slice(0, slotCount).map((host) => host.id),
	)
	return order.filter((host) => selectedIds.has(host.id))
}

export function placeLandingHeroAgents(
	hosts?: WalkthroughHostPick | null,
): Array<LandingHeroAgent> {
	const identities = pickLandingHeroRing(
		hosts?.allRow ?? listAllWalkthroughHosts(),
	)
	const fallback = listAllWalkthroughHosts()
	return landingHeroSlots.map((slot, index) => {
		const identity = identities[index] ?? fallback[index]!
		return {
			...slot,
			label: identity.label,
			icon: identity.icon,
		}
	})
}

const lantern = landingLantern

type LandingHeroLightDirection = 'in' | 'out'

/** Where along its trip a light is, and how it looks. Inbound leaves the
 *  token slowly and is pulled in faster, shrinking as it nears the lantern.
 *  Outbound is the reverse: small at the lantern, growing toward the token.
 *  Fades in leaving and out arriving. `null` while it rests. */
export function landingHeroLightAt(
	agent: Pick<LandingHeroAgent, 'cycle' | 'phase' | 'travel'>,
	seconds: number,
	direction: LandingHeroLightDirection = 'in',
) {
	const phase =
		direction === 'out' ? agent.phase + agent.cycle * 0.42 : agent.phase
	const t = (((seconds + phase) % agent.cycle) + agent.cycle) % agent.cycle
	const linear = t / agent.travel
	if (linear >= 1) return null
	// Ease-in along the trip: gentle departure, quickening approach.
	const eased = linear * linear * (1.7 - 0.7 * linear)
	const progress = direction === 'out' ? 1 - eased : eased
	const fadeIn = Math.min(1, linear / 0.1)
	const fadeOut = Math.min(1, (1 - linear) / 0.14)
	const scale = direction === 'out' ? 0.45 + 0.55 * eased : 1 - 0.55 * eased
	return { progress, opacity: Math.min(fadeIn, fadeOut), scale }
}

/** Wall-clock multiplier for the light clock. `proximity` is 0 far, 1 close. */
const landingHeroLightRateFar = 0.54
const landingHeroLightRateNear = 2.31

export function landingHeroLightRate(proximity: number) {
	const t = Math.min(1, Math.max(0, proximity))
	const ease = t * t * (3 - 2 * t)
	return (
		landingHeroLightRateFar +
		(landingHeroLightRateNear - landingHeroLightRateFar) * ease
	)
}

/** How close the controlling point is to the lantern, 0–1. Fine pointers
 *  use the mouse; coarse pointers use the viewport centre (scroll). */
export function landingHeroLightProximity(input: {
	lantern: { x: number; y: number }
	pointer: { x: number; y: number } | null
	viewport: { width: number; height: number }
	finePointer: boolean
}) {
	const range = Math.hypot(input.viewport.width, input.viewport.height) * 0.38
	if (range <= 0) return 0
	const target = input.finePointer
		? input.pointer
		: {
				x: input.viewport.width / 2,
				y: input.viewport.height / 2,
			}
	if (!target) return 0
	const distance = Math.hypot(
		target.x - input.lantern.x,
		target.y - input.lantern.y,
	)
	return 1 - Math.min(1, distance / range)
}

/** Tokens sit deeper in the parallax field than Kody (-0.06) so they float
 *  in front of the backdrop. */
const tokenDepth = '0.32'

const tetherPath = landingOrbitTetherPath

/** Keep every orb pinned to its token and to the lantern while both move
 *  (drift, pointer parallax). Positions are read from layout each frame and
 *  written back as viewBox units, so the SVG itself never transforms. The
 *  track path is measurement only (no stroke). Runs only while the stage is
 *  on screen; under reduced motion nothing moves and lights stay hidden, so
 *  a single pass after layout (and on resize) is enough. */
function attachTetherFollow(
	agents: ReadonlyArray<LandingHeroAgent>,
	node: Element,
	signal: AbortSignal,
) {
	const kody = node.querySelector<HTMLElement>('.landing-hero-lantern')
	const lines = node.querySelector<SVGSVGElement>('.landing-hero-agents-lines')
	const tiles = [
		...node.querySelectorAll<HTMLElement>('.landing-hero-agent-tile'),
	]
	const tethers = [
		...node.querySelectorAll<SVGGElement>('.landing-hero-agent-tether'),
	]
	if (!kody || !lines || tiles.length === 0) return

	let clock = 0
	let lastNow = performance.now()
	let pointer: { x: number; y: number } | null = null
	const finePointer = matchMedia('(hover: hover) and (pointer: fine)')

	const draw = () => {
		const now = performance.now()
		const dt = Math.min(0.05, (now - lastNow) / 1000)
		lastNow = now
		const stage = node.getBoundingClientRect()
		if (stage.width === 0) return
		const toUnits = (px: number, py: number) => ({
			x: ((px - stage.left) / stage.width) * 100,
			y: ((py - stage.top) / stage.height) * 100,
		})
		const kodyRect = kody.getBoundingClientRect()
		const lanternPx = {
			x: kodyRect.left + kodyRect.width * landingLanternGlass.x,
			y: kodyRect.top + kodyRect.height * landingLanternGlass.y,
		}
		clock +=
			dt *
			landingHeroLightRate(
				landingHeroLightProximity({
					lantern: lanternPx,
					pointer,
					viewport: {
						width: window.innerWidth,
						height: window.innerHeight,
					},
					finePointer: finePointer.matches,
				}),
			)
		const seconds = clock
		const end = toUnits(lanternPx.x, lanternPx.y)
		// The stage is square, so viewBox units double as percentages.
		lines.style.setProperty('--lantern-x', `${end.x}%`)
		lines.style.setProperty('--lantern-y', `${end.y}%`)
		const starts = tiles.map((tile) => {
			const rect = tile.getBoundingClientRect()
			return toUnits(rect.left + rect.width / 2, rect.top + rect.height / 2)
		})
		for (const tether of tethers) {
			const index = Number(tether.dataset.agent)
			const start = starts[index]
			const agent = agents[index]
			if (!start || !agent) continue
			const d = tetherPath(start.x, start.y, end.x, end.y)
			const track = tether.querySelector<SVGPathElement>(
				'.landing-hero-agent-track',
			)
			const lights = tether.querySelectorAll<SVGGElement>(
				'g.landing-hero-agent-light',
			)
			if (!track || lights.length === 0) continue
			track.setAttribute('d', d)
			const hideLights = () => {
				for (const light of lights) light.setAttribute('opacity', '0')
			}
			// Runtime type: the SVGPathElement querySelector cast is compile-time only.
			if (!(track instanceof SVGGeometryElement)) {
				hideLights()
				continue
			}
			try {
				const length = track.getTotalLength()
				for (const light of lights) {
					const direction = light.dataset.direction === 'out' ? 'out' : 'in'
					const at = landingHeroLightAt(agent, seconds, direction)
					if (!at) {
						light.setAttribute('opacity', '0')
						continue
					}
					const point = track.getPointAtLength(at.progress * length)
					light.setAttribute(
						'transform',
						`translate(${point.x} ${point.y}) scale(${at.scale})`,
					)
					light.setAttribute('opacity', String(at.opacity))
				}
			} catch {
				hideLights()
				continue
			}
		}
	}

	const motionOk = matchMedia('(prefers-reduced-motion: no-preference)')
	let raf: number | null = null
	let visible = false
	const tick = () => {
		raf = null
		draw()
		if (visible && motionOk.matches) raf = requestAnimationFrame(tick)
	}
	const wake = () => {
		lastNow = performance.now()
		if (raf == null) raf = requestAnimationFrame(tick)
	}

	const observer = new IntersectionObserver(([entry]) => {
		visible = entry?.isIntersecting ?? false
		wake()
	})
	observer.observe(node)
	window.addEventListener(
		'pointermove',
		(event) => {
			if (!(event instanceof PointerEvent)) return
			pointer = { x: event.clientX, y: event.clientY }
		},
		{ signal, passive: true },
	)
	window.addEventListener('resize', wake, { signal })
	motionOk.addEventListener('change', wake, { signal })
	finePointer.addEventListener('change', wake, { signal })
	wake()
	signal.addEventListener('abort', () => {
		observer.disconnect()
		if (raf != null) cancelAnimationFrame(raf)
	})
}

/** Invisible track plus travelling orbs. Lights start hidden; `tetherFollow`
 *  places them. No connector line or glow stroke is painted. Each tether's
 *  lights take one of the primitive colors, cycling in ring order. */
function renderOrbLayer(agents: ReadonlyArray<LandingHeroAgent>) {
	return (
		<svg
			className="landing-hero-agents-lines"
			viewBox="0 0 100 100"
			aria-hidden="true"
			style={
				{
					'--lantern-x': `${lantern.x}%`,
					'--lantern-y': `${lantern.y}%`,
				} as CSSProperties
			}
		>
			<g className="landing-hero-agents-tethers">
				{agents.map((agent, index) => {
					const d = tetherPath(agent.x, agent.y, lantern.x, lantern.y)
					return (
						<g
							key={agent.label}
							className="landing-hero-agent-tether"
							data-agent={String(index)}
							data-tone={landingOrbitLightTone(index)}
							style={
								{
									'--orb': landingPrimitiveColorVar(
										landingOrbitLightTone(index),
									),
								} as CSSProperties
							}
						>
							<path className="landing-hero-agent-track" d={d} fill="none" />
							<g
								className="landing-hero-agent-light"
								data-direction="in"
								opacity="0"
							>
								<circle className="landing-hero-agent-light-halo" r="2.4" />
								<circle className="landing-hero-agent-light-core" r="0.85" />
							</g>
							<g
								className="landing-hero-agent-light"
								data-direction="out"
								opacity="0"
							>
								<circle className="landing-hero-agent-light-halo" r="2.4" />
								<circle className="landing-hero-agent-light-core" r="0.85" />
							</g>
						</g>
					)
				})}
			</g>
		</svg>
	)
}

export function LandingHeroAgents({ hosts }: { hosts?: WalkthroughHostPick }) {
	const stage = useRef<HTMLDivElement>(null)
	const agents = useMemo(() => placeLandingHeroAgents(hosts), [hosts])
	useEffect(() => {
		const node = stage.current
		if (!node) return
		const controller = new AbortController()
		attachTetherFollow(agents, node, controller.signal)
		const cleanParallax = stageParallaxRef(node)
		return () => {
			controller.abort()
			if (typeof cleanParallax === 'function') cleanParallax()
		}
	}, [agents])
	return (
		<figure
			data-rise
			style={{ '--rise': '1.2' } as CSSProperties}
			className="landing-hero-art landing-hero-agents"
		>
			<figcaption className="visually-hidden">
				A lantern of five glowing orbs, one for each primitive, with the agents
				it plugs into floating around it.
			</figcaption>
			<div className="landing-hero-agents-stage" ref={stage}>
				<div className="landing-hero-lantern" data-depth="-0.06">
					<LandingLantern
						decorative
						activeId={null}
						onOpen={() => {}}
						onToggle={() => {}}
						onClose={() => {}}
						onDismiss={() => {}}
						onResume={() => {}}
					/>
				</div>
				<div
					className="landing-hero-agents-glow"
					style={{ left: '50%', top: '46%' }}
					data-depth="-0.06"
				></div>
				{renderOrbLayer(agents)}
				<ul
					aria-label="Agents Kody plugs into"
					className="landing-hero-agents-list"
				>
					{agents.map((agent) => (
						<li
							key={agent.label}
							className="landing-hero-agent"
							data-depth={tokenDepth}
							style={
								{
									'--x': `${agent.x}%`,
									'--y': `${agent.y}%`,
									'--dur': agent.dur,
									'--del': agent.del,
								} as CSSProperties
							}
						>
							<span
								className="landing-hero-agent-tile"
								style={
									{
										'--chip-icon': `url("${publicAsset(`/images/icons/${agent.icon}.svg`)}")`,
									} as CSSProperties
								}
								aria-hidden="true"
							></span>
							<span className="landing-hero-agent-name">{agent.label}</span>
						</li>
					))}
				</ul>
			</div>
		</figure>
	)
}
