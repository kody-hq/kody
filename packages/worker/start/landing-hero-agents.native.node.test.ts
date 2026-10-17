import { jsx } from '@emotion/react/jsx-runtime'
import { renderStartPage as renderToString } from './test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { landingPrimitiveIds } from '#universal/landing-lantern.ts'
import {
	listAllWalkthroughHosts,
	pickWalkthroughHosts,
} from '#universal/walkthrough-hosts.ts'
import {
	LandingHeroAgents,
	landingHeroLightAt,
	landingHeroLightProximity,
	landingHeroLightRate,
	landingHeroLightRateFar,
	landingHeroLightRateNear,
	landingHeroPinnedHostIds,
	landingHeroSlots,
	pickLandingHeroRing,
	placeLandingHeroAgents,
} from './components/landing-hero-agents.tsx'

test('hero ring always includes the pinned hosts and fills leftover slots from the SSR shuffle', () => {
	const catalog = listAllWalkthroughHosts()
	expect(landingHeroSlots.length).toBeLessThan(catalog.length)

	const fallback = placeLandingHeroAgents()
	expect(fallback.map((agent) => ({ x: agent.x, y: agent.y }))).toEqual(
		landingHeroSlots.map((slot) => ({ x: slot.x, y: slot.y })),
	)
	for (const id of landingHeroPinnedHostIds) {
		const host = catalog.find((entry) => entry.id === id)
		expect(host).toBeDefined()
		expect(fallback.some((agent) => agent.label === host?.label)).toBe(true)
	}

	const pick = pickWalkthroughHosts(() => 0)
	const placed = placeLandingHeroAgents(pick)
	expect(placed).toHaveLength(landingHeroSlots.length)
	for (const id of landingHeroPinnedHostIds) {
		const host = catalog.find((entry) => entry.id === id)
		expect(host).toBeDefined()
		expect(placed.some((agent) => agent.label === host?.label)).toBe(true)
	}

	const pinnedLast = [
		...catalog.filter(
			(host) =>
				!(landingHeroPinnedHostIds as ReadonlyArray<string>).includes(host.id),
		),
		...catalog.filter((host) =>
			(landingHeroPinnedHostIds as ReadonlyArray<string>).includes(host.id),
		),
	]
	const fromPinnedLast = pickLandingHeroRing(pinnedLast)
	expect(fromPinnedLast).toHaveLength(landingHeroSlots.length)
	for (const id of landingHeroPinnedHostIds) {
		expect(fromPinnedLast.some((host) => host.id === id)).toBe(true)
	}
	expect(fromPinnedLast.map((host) => host.id)).not.toEqual(
		pinnedLast.slice(0, landingHeroSlots.length).map((host) => host.id),
	)
})

test('hero tether lights travel inbound to the lantern and outbound to the agent', () => {
	const timing = { cycle: 4, phase: 0, travel: 1 }
	const agent = timing as Parameters<typeof landingHeroLightAt>[0]
	const inboundStart = landingHeroLightAt(agent, 0, 'in')
	expect(inboundStart).toMatchObject({ progress: 0, scale: 1 })
	const inboundMid = landingHeroLightAt(agent, 0.5, 'in')
	expect(inboundMid).not.toBeNull()
	expect(inboundMid!.progress).toBeGreaterThan(0)
	expect(inboundMid!.progress).toBeLessThan(1)
	expect(inboundMid!.scale).toBeLessThan(1)
	expect(landingHeroLightAt(agent, 1.2, 'in')).toBeNull()

	const outboundStart = landingHeroLightAt(agent, 4 - agent.cycle * 0.42, 'out')
	expect(outboundStart).toMatchObject({ progress: 1, scale: 0.45 })
	const outboundMid = landingHeroLightAt(
		agent,
		4 - agent.cycle * 0.42 + 0.5,
		'out',
	)
	expect(outboundMid).not.toBeNull()
	expect(outboundMid!.progress).toBeGreaterThan(0)
	expect(outboundMid!.progress).toBeLessThan(1)
	expect(outboundMid!.scale).toBeGreaterThan(0.45)
	expect(landingHeroLightRate(0.5)).toBeGreaterThan(landingHeroLightRateFar)
	expect(landingHeroLightRate(0.5)).toBeLessThan(landingHeroLightRateNear)
	// Fine pointers light by distance to the pointer; coarse pointers by the
	// lantern's distance from the viewport centre.
	const proximity = (
		lantern: { x: number; y: number },
		pointer: { x: number; y: number } | null,
		finePointer: boolean,
	) =>
		landingHeroLightProximity({
			lantern,
			pointer,
			viewport: { width: 800, height: 600 },
			finePointer,
		})
	expect(proximity({ x: 100, y: 100 }, { x: 100, y: 100 }, true)).toBe(1)
	expect(proximity({ x: 100, y: 100 }, null, true)).toBe(0)
	expect(proximity({ x: 400, y: 300 }, null, false)).toBe(1)
	expect(proximity({ x: 0, y: 0 }, null, false)).toBeLessThan(0.5)
})

test('orbit lights carry the primitive colors and paint no connector', async () => {
	const html = await renderToString(jsx(LandingHeroAgents, {}))

	const tones = [...html.matchAll(/data-tone="([a-z]+)"/g)].map(
		(match) => match[1],
	)
	expect(tones).toHaveLength(landingHeroSlots.length)
	expect(new Set(tones)).toEqual(new Set(landingPrimitiveIds))
	expect(html).toContain('--orb:var(--primitive-memory)')
	expect(html).toContain('landing-hero-agent-track')
	expect(html).not.toContain('landing-hero-agent-line')
	expect(html).not.toContain('landing-hero-agent-glow')
	expect(html).toContain('data-decorative')
	expect(html.match(/<span\b[^>]*class="landing-lantern-orb"/g)).toHaveLength(
		landingPrimitiveIds.length,
	)
	expect(html).not.toContain('<button')
})
