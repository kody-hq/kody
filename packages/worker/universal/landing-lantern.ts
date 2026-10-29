import type { LandingHomePrimitive } from '#universal/landing-home-copy.ts'

/**
 * Five-orb lantern for the `/features` primitives section. The lantern is one
 * still (glass, glow, and metal together). Each primitive orb is an overlay
 * clipped to the opening inside the frame, keyed to a `landingHomePrimitives`
 * id so the copy stays the single source of words and definitions. Orb
 * centres are percentages of that still. Colors live in `styles.css` as
 * `--primitive-<id>` so the orbit lights and the leader lines share one
 * palette.
 */

export type LandingPrimitiveId = LandingHomePrimitive['id']

export const landingPrimitiveIds = [
	'memory',
	'packages',
	'triggers',
	'integrations',
	'apps',
] as const satisfies ReadonlyArray<LandingPrimitiveId>

/** The whole lantern. Metal and glass stay in one image so the frame edge
 *  cannot open a seam against the page. */
export const landingLanternImage = {
	src: '/images/lantern/kody-primitives-lantern-480.webp',
	srcSet: [
		'/images/lantern/kody-primitives-lantern-480.webp 480w',
		'/images/lantern/kody-primitives-lantern.webp 863w',
	].join(', '),
	sizes: '(max-width: 800px) 58vw, 17rem',
	width: 863,
	height: 1242,
} as const

/** Orb cutouts. Each sprite is centered on its disc in the shell. */
export const landingLanternOrbArt = {
	memory: '/images/lantern/kody-primitives-orb-memory.webp',
	packages: '/images/lantern/kody-primitives-orb-packages.webp',
	triggers: '/images/lantern/kody-primitives-orb-triggers.webp',
	integrations: '/images/lantern/kody-primitives-orb-integrations.webp',
	apps: '/images/lantern/kody-primitives-orb-apps.webp',
} as const satisfies Record<LandingPrimitiveId, string>

/** Glass globe: centre as fractions of width and height, radius as a
 *  fraction of width. Used to fade leaders inside the glass. */
export const landingLanternGlass = { x: 0.5, y: 0.545, r: 0.46 } as const

/**
 * Inner edge of the frame, as fractions of the still. Traced where the
 * glass glow meets the metal: under the cap, around the globe, and above
 * the base. The orb overlay stops on this line.
 */
const landingLanternFrameOpening = [
	[0.021, 0.49],
	[0.042, 0.451],
	[0.059, 0.427],
	[0.101, 0.383],
	[0.143, 0.353],
	[0.163, 0.341],
	[0.226, 0.313],
	[0.243, 0.312],
	[0.302, 0.322],
	[0.389, 0.329],
	[0.448, 0.332],
	[0.553, 0.332],
	[0.66, 0.326],
	[0.72, 0.32],
	[0.758, 0.312],
	[0.772, 0.312],
	[0.834, 0.34],
	[0.866, 0.358],
	[0.907, 0.39],
	[0.925, 0.407],
	[0.952, 0.442],
	[0.98, 0.494],
	[0.98, 0.641],
	[0.963, 0.676],
	[0.928, 0.721],
	[0.9, 0.746],
	[0.869, 0.769],
	[0.866, 0.787],
	[0.845, 0.795],
	[0.841, 0.799],
	[0.838, 0.799],
	[0.834, 0.793],
	[0.827, 0.794],
	[0.768, 0.808],
	[0.681, 0.82],
	[0.528, 0.827],
	[0.435, 0.826],
	[0.351, 0.822],
	[0.292, 0.817],
	[0.24, 0.81],
	[0.198, 0.801],
	[0.177, 0.794],
	[0.163, 0.792],
	[0.16, 0.8],
	[0.153, 0.8],
	[0.129, 0.787],
	[0.125, 0.765],
	[0.09, 0.739],
	[0.052, 0.699],
	[0.038, 0.68],
	[0.021, 0.647],
] as const satisfies ReadonlyArray<readonly [number, number]>

/**
 * Orb centres (percent of width and height), shared disc diameter (percent
 * of width), and sprite width (percent of width). `size` is the painted
 * disc, so the hotspot, ring, collision radius, and leader rim match it.
 * `art` is the slightly larger sprite, cropped so that disc sits in the
 * middle of the image. Five discs at 16.2 sit on a pentagon inside the
 * glass with room to drift.
 */
export const landingLanternOrbs = [
	{ id: 'memory', x: 50, y: 40, size: 16.2, art: 16.94 },
	{ id: 'packages', x: 72, y: 48, size: 16.2, art: 16.95 },
	{ id: 'triggers', x: 37, y: 69, size: 16.2, art: 16.94 },
	{ id: 'integrations', x: 28, y: 48, size: 16.2, art: 16.93 },
	{ id: 'apps', x: 63, y: 69, size: 16.2, art: 16.94 },
] as const satisfies ReadonlyArray<{
	id: LandingPrimitiveId
	x: number
	y: number
	size: number
	art: number
}>

/**
 * Clip for the orb overlay. The sprite halo, pulse ring, and hover bloom
 * paint with the discs, so the clip is the opening inside the frame.
 */
export function landingLanternOrbClipPath() {
	const percent = (value: number) => `${Math.round(value * 1000) / 10}%`
	return `polygon(${landingLanternFrameOpening
		.map(([x, y]) => `${percent(x)} ${percent(y)}`)
		.join(',')})`
}

/** CSS custom property that carries a primitive's color. */
export function landingPrimitiveColorVar(id: LandingPrimitiveId) {
	return `var(--primitive-${id})`
}

/** Palette tone for the nth orbit light; cycles through the five colors. */
export function landingOrbitLightTone(index: number): LandingPrimitiveId {
	const count = landingPrimitiveIds.length
	return landingPrimitiveIds[((index % count) + count) % count]!
}

export type LandingLeaderPoint = { x: number; y: number }

/**
 * Cubic from an orb to the word's dot with horizontal tangents at both
 * ends: it leaves the glass sideways and glides into the dot from the
 * left. Coordinates are pixels relative to the stage; the SVG's viewBox is
 * set to the stage size so units map one to one.
 */
export function landingLeaderPath(
	from: LandingLeaderPoint,
	to: LandingLeaderPoint,
) {
	const dx = to.x - from.x
	const reach = Math.max(Math.abs(dx) * 0.5, 24)
	const c1 = { x: from.x + reach, y: from.y }
	const c2 = { x: to.x - reach * 0.6, y: to.y }
	return `M${round(from.x)} ${round(from.y)} C${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(to.x)} ${round(to.y)}`
}

/** Word anchor: the left edge of the colored dot before the word. */
export function landingLeaderWordAnchor(
	rect: { left: number; top: number; height: number },
	origin: { left: number; top: number },
): LandingLeaderPoint {
	return {
		x: rect.left - origin.left - 2,
		y: rect.top + rect.height / 2 - origin.top,
	}
}

/** Orb anchor: the orb's centre. */
export function landingLeaderOrbAnchor(
	rect: { left: number; top: number; width: number; height: number },
	origin: { left: number; top: number },
): LandingLeaderPoint {
	return {
		x: rect.left + rect.width / 2 - origin.left,
		y: rect.top + rect.height / 2 - origin.top,
	}
}

/**
 * Where a leader leaves the orb: on the painted orb's rim, facing the
 * word, so the line does not cross the orb's own face. `radius` is the
 * hotspot radius; the painted orb sits just inside it.
 */
export function landingLeaderOrbExit(
	centre: LandingLeaderPoint,
	to: LandingLeaderPoint,
	radius: number,
): LandingLeaderPoint {
	const dx = to.x - centre.x
	const dy = to.y - centre.y
	const length = Math.hypot(dx, dy)
	if (length === 0) return centre
	const rim = radius * 0.86
	return {
		x: centre.x + (dx / length) * rim,
		y: centre.y + (dy / length) * rim,
	}
}

function round(value: number) {
	return Math.round(value * 10) / 10
}
