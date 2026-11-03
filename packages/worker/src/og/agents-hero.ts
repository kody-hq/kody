/**
 * Satori composition of the homepage agents-around-lantern hero for OG cards.
 * Uses the same Kody base art as the live landing stage (`kody-base`), then
 * draws chips, tethers, and mid-flight lantern lights from shared orbit
 * geometry so the share card matches the homepage still.
 */

import {
	getKodyBaseDataUri,
	getLandingAgentIconDataUri,
} from '#worker/og/og-image-assets.ts'
import { getOgPalette, type OgTheme } from '#worker/og/palette.ts'
import {
	landingLantern,
	landingOrbitAgents,
	landingOrbitOgLights,
	landingOrbitTetherPath,
	landingOrbitTetherPoint,
	type LandingOrbitAgentIcon,
} from '#universal/landing-agent-orbit.ts'
import type { SatoriElement } from '#worker/og/render.ts'

/** Matches the page OG hero slot (bled past frame padding). */
export const AGENTS_HERO_SIZE = 560

const CHIP_SIZE = 50
const CHIP_ICON_SIZE = 24
const CHIP_RADIUS = 14

/** Soft amber halo + core for a still of the travelling lantern lights. */
const LIGHT_HALO_SIZE = 28
const LIGHT_CORE_SIZE = 10

function pctToPx(pct: number, size: number = AGENTS_HERO_SIZE): number {
	return (pct / 100) * size
}

function createLanternGlow(theme: OgTheme): SatoriElement {
	const isLight = theme === 'light'
	const size = AGENTS_HERO_SIZE * 0.26
	return {
		type: 'div',
		props: {
			style: {
				position: 'absolute',
				left: pctToPx(landingLantern.x) - size / 2,
				top: pctToPx(landingLantern.y) - size / 2,
				width: size,
				height: size,
				borderRadius: size / 2,
				backgroundImage: isLight
					? 'radial-gradient(circle at center, rgba(232, 168, 32, 0.28) 0%, rgba(232, 168, 32, 0.1) 42%, rgba(232, 168, 32, 0) 72%)'
					: 'radial-gradient(circle at center, rgba(245, 198, 90, 0.55) 0%, rgba(245, 198, 90, 0.18) 42%, rgba(245, 198, 90, 0) 72%)',
			},
		},
	}
}

/** Clearer than raw `palette.border` on the dark OG ground (Satori softens 1px). */
function tetherStrokeColor(theme: OgTheme): string {
	return theme === 'light' ? '#6a7078' : '#9aa1a9'
}

function chipBorderColor(theme: OgTheme): string {
	return theme === 'light' ? '#9aa1a9' : '#7a828c'
}

function createTetherLayer(theme: OgTheme): SatoriElement {
	const palette = getOgPalette(theme)
	const stroke = tetherStrokeColor(theme)
	const hx = pctToPx(landingLantern.x)
	const hy = pctToPx(landingLantern.y)
	const paths: Array<SatoriElement> = []
	for (const agent of landingOrbitAgents) {
		const d = landingOrbitTetherPath(pctToPx(agent.x), pctToPx(agent.y), hx, hy)
		paths.push({
			type: 'path',
			props: {
				d,
				fill: 'none',
				stroke: palette.text,
				strokeWidth: 8,
				strokeLinecap: 'round',
				strokeOpacity: theme === 'light' ? 0.08 : 0.12,
			},
		})
		paths.push({
			type: 'path',
			props: {
				d,
				fill: 'none',
				stroke,
				strokeWidth: 2.6,
				strokeLinecap: 'round',
			},
		})
	}
	return {
		type: 'svg',
		props: {
			width: AGENTS_HERO_SIZE,
			height: AGENTS_HERO_SIZE,
			viewBox: `0 0 ${AGENTS_HERO_SIZE} ${AGENTS_HERO_SIZE}`,
			style: {
				position: 'absolute',
				left: 0,
				top: 0,
				width: AGENTS_HERO_SIZE,
				height: AGENTS_HERO_SIZE,
			},
			children: paths,
		},
	}
}

/**
 * Same dissolve as `.landing-hero-agents-lines`: a hole over the lantern globe
 * so strokes (and arriving lights) fade into the glow instead of crossing it.
 * Percentages match the homepage CSS (`ellipse 9.5% 8.2%` at lantern %).
 */
function withLanternTetherMask(children: Array<SatoriElement>): SatoriElement {
	const maskImage = `radial-gradient(ellipse 9.5% 8.2% at ${landingLantern.x}% ${landingLantern.y}%, transparent 66%, black 100%)`
	return {
		type: 'div',
		props: {
			style: {
				position: 'absolute',
				left: 0,
				top: 0,
				width: AGENTS_HERO_SIZE,
				height: AGENTS_HERO_SIZE,
				display: 'flex',
				maskImage,
			},
			children,
		},
	}
}

function createAgentChip(input: {
	icon: LandingOrbitAgentIcon
	x: number
	y: number
	theme: OgTheme
}): SatoriElement {
	const palette = getOgPalette(input.theme)
	const left = pctToPx(input.x) - CHIP_SIZE / 2
	const top = pctToPx(input.y) - CHIP_SIZE / 2
	return {
		type: 'div',
		props: {
			style: {
				position: 'absolute',
				left,
				top,
				width: CHIP_SIZE,
				height: CHIP_SIZE,
				borderRadius: CHIP_RADIUS,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
				backgroundColor: palette.surface,
				// 2px — 1px borders disappear under Satori/resvg antialias on dark.
				border: `2px solid ${chipBorderColor(input.theme)}`,
				boxShadow:
					input.theme === 'light'
						? '0 10px 24px rgba(23, 27, 32, 0.12)'
						: '0 10px 24px rgba(0, 0, 0, 0.45)',
			},
			children: {
				type: 'img',
				props: {
					src: getLandingAgentIconDataUri(input.icon, input.theme),
					width: CHIP_ICON_SIZE,
					height: CHIP_ICON_SIZE,
					style: {
						width: CHIP_ICON_SIZE,
						height: CHIP_ICON_SIZE,
						objectFit: 'contain',
					},
				},
			},
		},
	}
}

function createOrbitLight(input: {
	icon: LandingOrbitAgentIcon
	progress: number
	scale: number
	theme: OgTheme
}): SatoriElement | null {
	const agent = landingOrbitAgents.find((entry) => entry.icon === input.icon)
	if (!agent) return null
	const point = landingOrbitTetherPoint(
		agent.x,
		agent.y,
		landingLantern.x,
		landingLantern.y,
		input.progress,
	)
	const halo = LIGHT_HALO_SIZE * input.scale
	const core = LIGHT_CORE_SIZE * input.scale
	const cx = pctToPx(point.x)
	const cy = pctToPx(point.y)
	const isLight = input.theme === 'light'
	return {
		type: 'div',
		props: {
			style: {
				position: 'absolute',
				left: cx - halo / 2,
				top: cy - halo / 2,
				width: halo,
				height: halo,
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'center',
			},
			children: [
				{
					type: 'div',
					props: {
						style: {
							position: 'absolute',
							left: 0,
							top: 0,
							width: halo,
							height: halo,
							borderRadius: halo / 2,
							backgroundImage: isLight
								? 'radial-gradient(circle at center, rgba(232, 168, 32, 0.42) 0%, rgba(232, 168, 32, 0.14) 45%, rgba(232, 168, 32, 0) 72%)'
								: 'radial-gradient(circle at center, rgba(245, 198, 90, 0.55) 0%, rgba(245, 198, 90, 0.18) 45%, rgba(245, 198, 90, 0) 72%)',
						},
					},
				},
				{
					type: 'div',
					props: {
						style: {
							width: core,
							height: core,
							borderRadius: core / 2,
							backgroundColor: isLight ? '#fff6d6' : '#fff8e8',
							boxShadow: isLight
								? '0 0 10px rgba(232, 168, 32, 0.55)'
								: '0 0 12px rgba(245, 198, 90, 0.75)',
						},
					},
				},
			],
		},
	}
}

/**
 * Full agents hero for lantern-kind page OG cards: Kody + orbit chips +
 * tethers + a couple of glowing balls mid-flight toward the lantern.
 */
export function createAgentsHero(theme: OgTheme = 'dark'): SatoriElement {
	const chips = landingOrbitAgents.map((agent) =>
		createAgentChip({
			icon: agent.icon,
			x: agent.x,
			y: agent.y,
			theme,
		}),
	)
	const lights = landingOrbitOgLights
		.map((light) =>
			createOrbitLight({
				icon: light.icon,
				progress: light.progress,
				scale: light.scale,
				theme,
			}),
		)
		.filter((node): node is SatoriElement => node != null)

	return {
		type: 'div',
		props: {
			style: {
				position: 'absolute',
				right: -46,
				top: -5,
				width: AGENTS_HERO_SIZE,
				height: AGENTS_HERO_SIZE,
				display: 'flex',
			},
			children: [
				{
					type: 'img',
					props: {
						src: getKodyBaseDataUri(),
						width: AGENTS_HERO_SIZE,
						height: AGENTS_HERO_SIZE,
						style: {
							position: 'absolute',
							left: 0,
							top: 0,
							width: AGENTS_HERO_SIZE,
							height: AGENTS_HERO_SIZE,
							objectFit: 'contain',
						},
					},
				},
				createLanternGlow(theme),
				withLanternTetherMask([createTetherLayer(theme), ...lights]),
				...chips,
			],
		},
	}
}
