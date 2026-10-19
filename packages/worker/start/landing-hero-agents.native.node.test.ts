import { jsx } from '@emotion/react/jsx-runtime'
import { renderStartPage as renderToString } from './test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import {
	listAllWalkthroughHosts,
	pickWalkthroughHosts,
} from '#universal/walkthrough-hosts.ts'
import {
	LandingHeroAgents,
	landingHeroLightAt,
	landingHeroLightProximity,
	landingHeroLightRate,
	pickLandingHeroRing,
	placeLandingHeroAgents,
} from './components/landing-hero-agents.tsx'

const pinnedHostIds = ['grok-bot', 'chatgpt', 'claude-code'] as const
const heroSlotCount = 8

test('hero ring always includes the pinned hosts and fills leftover slots from the SSR shuffle', () => {
	const catalog = listAllWalkthroughHosts()
	expect(catalog.length).toBeGreaterThan(heroSlotCount)

	const fallback = placeLandingHeroAgents()
	expect(fallback).toHaveLength(heroSlotCount)
	expect(fallback.map((agent) => ({ x: agent.x, y: agent.y }))).toEqual([
		{ x: 12, y: 19 },
		{ x: 88, y: 19 },
		{ x: 93, y: 46 },
		{ x: 87, y: 72 },
		{ x: 74, y: 92 },
		{ x: 26, y: 92 },
		{ x: 13, y: 72 },
		{ x: 7, y: 46 },
	])
	expect(fallback.map((agent) => agent.label)).toEqual(
		expect.arrayContaining(['Grok Bot', 'ChatGPT', 'Claude Code']),
	)

	const pick = pickWalkthroughHosts(() => 0)
	const placed = placeLandingHeroAgents(pick)
	expect(placed).toHaveLength(heroSlotCount)
	expect(placed.map((agent) => agent.label)).toEqual(
		expect.arrayContaining(['Grok Bot', 'ChatGPT', 'Claude Code']),
	)

	const pinnedLast = [
		...catalog.filter(
			(host) => !(pinnedHostIds as ReadonlyArray<string>).includes(host.id),
		),
		...catalog.filter((host) =>
			(pinnedHostIds as ReadonlyArray<string>).includes(host.id),
		),
	]
	const fromPinnedLast = pickLandingHeroRing(pinnedLast)
	expect(fromPinnedLast).toHaveLength(heroSlotCount)
	for (const id of pinnedHostIds) {
		expect(fromPinnedLast.some((host) => host.id === id)).toBe(true)
	}
	expect(fromPinnedLast.map((host) => host.id)).not.toEqual(
		pinnedLast.slice(0, heroSlotCount).map((host) => host.id),
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
	expect(landingHeroLightRate(0.5)).toBe(1.425)
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
	expect(tones).toHaveLength(heroSlotCount)
	expect(new Set(tones)).toEqual(
		new Set(['memory', 'packages', 'triggers', 'integrations', 'apps']),
	)
	expect(html).toContain('--orb:var(--primitive-memory)')
	expect(html).toContain('landing-hero-agent-track')
	expect(html).toContain('data-decorative')
	expect(html.match(/<span\b[^>]*class="landing-lantern-orb"/g)).toHaveLength(5)
	expect(html).not.toContain('<button')
})
