/**
 * Homepage OG still of the primitives lantern.
 * The lantern PNG is the homepage lantern at the orbs' rest pose.
 * Leader paths use the same orb geometry and cubic as the live section
 * (`landing-lantern.ts`); Satori cannot measure the DOM, so word anchors
 * are a fixed stack beside the glass.
 */

import { getKodyPrimitivesLanternDataUri } from '#worker/og/og-image-assets.ts'
import { getOgPalette, type OgTheme } from '#worker/og/palette.ts'
import { OG_HEIGHT, OG_WIDTH, type SatoriElement } from '#worker/og/render.ts'
import { landingHomePrimitives } from '#universal/landing-home-copy.ts'
import {
	landingLanternGlass,
	landingLanternImage,
	landingLanternOrbs,
	landingLeaderOrbExit,
	landingLeaderPath,
	type LandingPrimitiveId,
} from '#universal/landing-lantern.ts'

/** Content box inside the 40px / 52px OG frame padding. */
const CONTENT_WIDTH = OG_WIDTH - 52 * 2
const CONTENT_HEIGHT = OG_HEIGHT - 40 * 2

/**
 * Centres the lantern and its labels between the 580px title column and the
 * right edge, so the art has an even margin on both sides.
 */
const STAGE_LEFT = 640
const LANTERN_WIDTH = 286
const WORD_GAP = 18
const STAGE_WIDTH = CONTENT_WIDTH - STAGE_LEFT

const LANTERN_HEIGHT = Math.round(
	LANTERN_WIDTH * (landingLanternImage.height / landingLanternImage.width),
)
const STAGE_TOP = Math.round((CONTENT_HEIGHT - LANTERN_HEIGHT) / 2)

const WORD_FONT_SIZE = 26
const WORD_ROW = 46
const DOT_SIZE = 12

/**
 * sRGB of `--primitive-*` / `--primitive-*-dark` in styles.css. Satori does
 * not resolve oklch. Memory is the brain's red, triggers the lightning's
 * yellow; integrations (credentials) stays the plug's green and apps is the
 * app grid's purple.
 */
export const landingPrimitiveOgColors = {
	light: {
		memory: '#f13b2e',
		packages: '#007df3',
		triggers: '#d6b603',
		integrations: '#05b047',
		apps: '#9f61f2',
	},
	dark: {
		memory: '#fd7464',
		packages: '#53a6ff',
		triggers: '#fcd936',
		integrations: '#43d066',
		apps: '#b884ff',
	},
} as const satisfies Record<OgTheme, Record<LandingPrimitiveId, string>>

function orbCentre(id: LandingPrimitiveId) {
	const orb = landingLanternOrbs.find((entry) => entry.id === id)
	if (!orb) {
		throw new Error(`Missing lantern orb: ${id}`)
	}
	return {
		x: (orb.x / 100) * LANTERN_WIDTH,
		y: (orb.y / 100) * LANTERN_HEIGHT,
		radius: ((orb.size / 100) * LANTERN_WIDTH) / 2,
	}
}

/** Word-list centres, stacked in copy order and centred on the glass. */
function wordCentres(): Array<{
	id: LandingPrimitiveId
	word: string
	y: number
}> {
	const glassY = LANTERN_HEIGHT * landingLanternGlass.y
	const span = (landingHomePrimitives.length - 1) * WORD_ROW
	const firstY = glassY - span / 2
	return landingHomePrimitives.map((primitive, index) => ({
		id: primitive.id,
		word: primitive.word,
		y: firstY + index * WORD_ROW,
	}))
}

function leaderInk(
	id: LandingPrimitiveId,
	highlight: LandingPrimitiveId | null,
) {
	if (!highlight) {
		return { halo: 0.28, core: 0.95, coreWidth: 2.6 }
	}
	if (id === highlight) {
		return { halo: 0.55, core: 1, coreWidth: 3.6 }
	}
	return { halo: 0.08, core: 0.2, coreWidth: 2.2 }
}

/** Ring the baked orb so a share card can point at one primitive. */
function createOrbAccent(
	theme: OgTheme,
	id: LandingPrimitiveId,
): SatoriElement {
	const orb = orbCentre(id)
	const colour = landingPrimitiveOgColors[theme][id]
	return {
		type: 'svg',
		props: {
			width: LANTERN_WIDTH,
			height: LANTERN_HEIGHT,
			viewBox: `0 0 ${LANTERN_WIDTH} ${LANTERN_HEIGHT}`,
			style: {
				position: 'absolute',
				left: 0,
				top: 0,
				width: LANTERN_WIDTH,
				height: LANTERN_HEIGHT,
			},
			children: [
				{
					type: 'circle',
					props: {
						cx: orb.x,
						cy: orb.y,
						r: orb.radius + 11,
						fill: 'none',
						stroke: colour,
						strokeWidth: 10,
						strokeOpacity: 0.35,
					},
				},
				{
					type: 'circle',
					props: {
						cx: orb.x,
						cy: orb.y,
						r: orb.radius + 4,
						fill: 'none',
						stroke: colour,
						strokeWidth: 4,
						strokeOpacity: 1,
					},
				},
			],
		},
	}
}

function createLeaders(
	theme: OgTheme,
	highlight: LandingPrimitiveId | null,
): SatoriElement {
	const glassX = LANTERN_WIDTH * landingLanternGlass.x
	const glassY = LANTERN_HEIGHT * landingLanternGlass.y
	const glassR = LANTERN_WIDTH * landingLanternGlass.r
	const paths: Array<SatoriElement> = []
	for (const word of wordCentres()) {
		const colour = landingPrimitiveOgColors[theme][word.id]
		const ink = leaderInk(word.id, highlight)
		const orb = orbCentre(word.id)
		const to = { x: LANTERN_WIDTH + WORD_GAP, y: word.y }
		const from = landingLeaderOrbExit(orb, to, orb.radius)
		const d = landingLeaderPath(from, to)
		paths.push({
			type: 'path',
			props: {
				d,
				fill: 'none',
				stroke: colour,
				strokeWidth: 8,
				strokeLinecap: 'round',
				strokeOpacity: ink.halo,
			},
		})
		paths.push({
			type: 'path',
			props: {
				d,
				fill: 'none',
				stroke: colour,
				strokeWidth: ink.coreWidth,
				strokeLinecap: 'round',
				strokeOpacity: ink.core,
			},
		})
	}
	return {
		type: 'div',
		props: {
			style: {
				position: 'absolute',
				left: 0,
				top: 0,
				width: STAGE_WIDTH,
				height: LANTERN_HEIGHT,
				display: 'flex',
				// Faint inside the glass so the painted orbs stay readable,
				// same idea as `.landing-primitives-leaders`.
				maskImage: `radial-gradient(circle ${glassR}px at ${glassX}px ${glassY}px, rgba(0, 0, 0, 0.28) 74%, rgba(0, 0, 0, 1) 100%)`,
			},
			children: {
				type: 'svg',
				props: {
					width: STAGE_WIDTH,
					height: LANTERN_HEIGHT,
					viewBox: `0 0 ${STAGE_WIDTH} ${LANTERN_HEIGHT}`,
					style: {
						width: STAGE_WIDTH,
						height: LANTERN_HEIGHT,
					},
					children: paths,
				},
			},
		},
	}
}

function createWords(
	theme: OgTheme,
	highlight: LandingPrimitiveId | null,
): Array<SatoriElement> {
	const palette = getOgPalette(theme)
	return wordCentres().map((word) => {
		const colour = landingPrimitiveOgColors[theme][word.id]
		const emphasized = highlight === word.id
		const fontSize = emphasized ? WORD_FONT_SIZE + 4 : WORD_FONT_SIZE
		const labelColor = emphasized
			? colour
			: highlight
				? palette.textMuted
				: palette.text
		// Separate annotations so the two style objects are not unified into
		// one type with optional keys (`undefined` is not a Satori style value).
		const dot: SatoriElement = {
			type: 'div',
			props: {
				style: {
					width: DOT_SIZE,
					height: DOT_SIZE,
					borderRadius: DOT_SIZE / 2,
					backgroundColor: colour,
					marginRight: 10,
					flexShrink: 0,
				},
			},
		}
		const label: SatoriElement = {
			type: 'div',
			props: {
				style: {
					fontFamily: 'Bricolage Grotesque',
					fontSize,
					fontWeight: 700,
					lineHeight: 1,
					letterSpacing: '-0.02em',
					color: labelColor,
					whiteSpace: 'nowrap',
				},
				children: word.word,
			},
		}
		return {
			type: 'div',
			props: {
				style: {
					position: 'absolute',
					left: LANTERN_WIDTH + WORD_GAP - DOT_SIZE / 2,
					top: word.y - fontSize / 2,
					display: 'flex',
					alignItems: 'center',
					height: fontSize,
				},
				children: [dot, label],
			},
		}
	})
}

/** Lantern plus energy lines to the five homepage primitives. */
export function createPrimitivesLantern(
	theme: OgTheme = 'dark',
	highlight: LandingPrimitiveId | null = null,
): SatoriElement {
	return {
		type: 'div',
		props: {
			style: {
				position: 'absolute',
				left: STAGE_LEFT,
				top: STAGE_TOP,
				width: STAGE_WIDTH,
				height: LANTERN_HEIGHT,
				display: 'flex',
			},
			children: [
				{
					type: 'img',
					props: {
						src: getKodyPrimitivesLanternDataUri(),
						width: LANTERN_WIDTH,
						height: LANTERN_HEIGHT,
						style: {
							position: 'absolute',
							left: 0,
							top: 0,
							width: LANTERN_WIDTH,
							height: LANTERN_HEIGHT,
							objectFit: 'contain',
						},
					},
				},
				...(highlight ? [createOrbAccent(theme, highlight)] : []),
				createLeaders(theme, highlight),
				...createWords(theme, highlight),
			],
		},
	}
}
