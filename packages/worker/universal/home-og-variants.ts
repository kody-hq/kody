/**
 * Homepage `?og=` share-card variants.
 *
 * Headlines and subtitles are the locked homepage Open Graph copy. `**` marks
 * words the PNG paints in the accent colour. `og:title` is the H1 and
 * `og:description` is the sub, with those markers removed and hard line breaks
 * collapsed to spaces. The default home card (no param) stays in `og-pages.ts`.
 */

import { type LandingPrimitiveId } from '#universal/landing-lantern.ts'
import { stripOgEmphasis } from '#universal/og-emphasis.ts'
import { type PublicOgPage } from '#universal/og-pages.ts'

const homeOgQueryParam = 'og'

export const homeOgVariantIds = [
	'switch',
	'cursor-claude',
	'skills',
	'forever',
	'secrets',
	'shared',
	'memory',
	'packages',
	'integrations',
	'apps',
	'triggers',
	'webhooks',
	'email',
	'cron',
	'subscriptions',
] as const

export type HomeOgVariantId = (typeof homeOgVariantIds)[number]

type HomeOgVariantGroup = 'icp' | 'lantern' | 'triggers-door'

type HomeOgVariantEntry = {
	group: HomeOgVariantGroup
	/** Primitive to ring in the lantern. Null keeps every orb equal. */
	highlight: LandingPrimitiveId | null
	imageTitle: string
	imageSubtitle: string
}

/**
 * `secrets` is an ICP door that highlights the credentials orb (secrets
 * fold into credentials; there is no secrets orb).
 * `triggers` is the generic triggers door (same orb as the other doors).
 */
const homeOgVariants = {
	switch: {
		group: 'icp',
		highlight: null,
		imageTitle: '**Switch** agents.\n**Keep** the work.',
		imageSubtitle: 'Memory, secrets, and automations that travel with you',
	},
	'cursor-claude': {
		group: 'icp',
		highlight: null,
		imageTitle: '**Build it**\nwith Cursor.\n**Run it**\nwith Claude.',
		imageSubtitle: 'One package graph every agent can call',
	},
	skills: {
		group: 'icp',
		highlight: null,
		imageTitle: 'Turn a skill into\n**software**',
		imageSubtitle: 'Faster, cheaper, portable, and more reliable',
	},
	forever: {
		group: 'icp',
		highlight: null,
		imageTitle: 'Say it once.\nRun it **forever**.',
		imageSubtitle: 'Packages and jobs that don\u2019t need a chat open',
	},
	secrets: {
		group: 'icp',
		highlight: 'integrations',
		imageTitle: '**Secrets**\nyour agents\ncan use, not read',
		imageSubtitle: 'The vault stays yours across every host',
	},
	shared: {
		group: 'icp',
		highlight: null,
		imageTitle: 'Your agents\u2019\n**cloud**',
		imageSubtitle: 'One home for memory, packages, and jobs',
	},
	memory: {
		group: 'lantern',
		highlight: 'memory',
		imageTitle: '**Stop**\nre-explaining\nyourself to\nevery agent',
		imageSubtitle: 'Shared memory your agents actually use',
	},
	packages: {
		group: 'lantern',
		highlight: 'packages',
		imageTitle: '**Custom software**\nfor your **agents**',
		imageSubtitle: 'Invoke from your agent, any trigger, or even a custom app',
	},
	integrations: {
		group: 'lantern',
		highlight: 'integrations',
		imageTitle: 'Connect the tools\n**once**',
		imageSubtitle: 'One MCP server connects to all of your stuff',
	},
	apps: {
		group: 'lantern',
		highlight: 'apps',
		imageTitle: 'Sometimes you\njust want a **UI**',
		imageSubtitle: 'The agent builds it for you, it integrates with everything',
	},
	triggers: {
		group: 'triggers-door',
		highlight: 'triggers',
		imageTitle: 'Invoke\ndeterministic\ncode from\n**anything**',
		imageSubtitle:
			'Trigger from email, cron, webhooks, events, and even a custom UI',
	},
	webhooks: {
		group: 'triggers-door',
		highlight: 'triggers',
		imageTitle: 'Trigger **anything**\nfrom webhooks',
		imageSubtitle: "Connect everything you own in Your agents' cloud",
	},
	email: {
		group: 'triggers-door',
		highlight: 'triggers',
		imageTitle: 'Run code from\nyour **email**',
		imageSubtitle: "Connect everything you own in Your agents' cloud",
	},
	cron: {
		group: 'triggers-door',
		highlight: 'triggers',
		imageTitle: 'Put your\nautomations\non a schedule',
		imageSubtitle: "Connect everything you own in Your agents' cloud",
	},
	subscriptions: {
		group: 'triggers-door',
		highlight: 'triggers',
		imageTitle: 'Subscribe and\nemit custom\nevents',
		imageSubtitle: "Connect everything you own in Your agents' cloud",
	},
} as const satisfies Record<HomeOgVariantId, HomeOgVariantEntry>

export type HomeOgVariant = HomeOgVariantEntry & {
	id: HomeOgVariantId
	ogTitle: string
	ogDescription: string
}

function isHomeOgVariantId(value: string): value is HomeOgVariantId {
	return Object.hasOwn(homeOgVariants, value)
}

export function getHomeOgVariant(
	value: string | null | undefined,
): HomeOgVariant | null {
	if (!value || !isHomeOgVariantId(value)) return null
	const entry = homeOgVariants[value]
	return {
		id: value,
		group: entry.group,
		highlight: entry.highlight,
		imageTitle: entry.imageTitle,
		imageSubtitle: entry.imageSubtitle,
		ogTitle: stripOgEmphasis(entry.imageTitle),
		ogDescription: entry.imageSubtitle,
	}
}

/** `?og=` on a URL, or a bare query string. Unknown values are null. */
export function readHomeOgVariant(search: string): HomeOgVariant | null {
	return getHomeOgVariant(new URLSearchParams(search).get(homeOgQueryParam))
}

/** Image route that actually renders this variant. */
export function homeOgImagePath(id: HomeOgVariantId): string {
	return `/og/home.png?${homeOgQueryParam}=${id}`
}

export function applyHomeOgVariant(
	page: PublicOgPage,
	variant: HomeOgVariant,
): PublicOgPage {
	return {
		...page,
		imageTitle: variant.imageTitle,
		imageSubtitle: variant.imageSubtitle,
		// Sized for the default card's copy; variants use the default size.
		imageTitleFontSize: undefined,
		ogTitle: variant.ogTitle,
		ogDescription: variant.ogDescription,
	}
}

/**
 * Path for `history.replaceState` after dropping `og`. Null when the param
 * is already absent. Other params and the hash stay.
 */
export function locationWithoutHomeOgParam(href: string): string | null {
	let url: URL
	try {
		url = new URL(href)
	} catch {
		return null
	}
	if (!url.searchParams.has(homeOgQueryParam)) return null
	url.searchParams.delete(homeOgQueryParam)
	return `${url.pathname}${url.search}${url.hash}`
}
