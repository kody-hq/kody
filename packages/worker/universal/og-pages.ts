import { stripOgEmphasis } from '#universal/og-emphasis.ts'

const homeOgImageTitle = 'The **cloud** for\nyour team\u2019s agents'
const homeOgImageSubtitle =
	'One place for the credentials, tools, and workflows for every agent your team members use.'

/**
 * Registry of public pages that get a Satori-generated OG image at
 * `/og/:page.png`. The page id is the `:page` path segment; `path` is the
 * canonical page path the OG tags point at.
 *
 * Kept separate from `page-image.ts` so handlers can read titles and
 * descriptions without pulling satori/resvg into the isolate.
 */
export type PublicOgPage = {
	/** Large heading inside the generated image. */
	imageTitle: string
	/** Muted supporting line inside the generated image. */
	imageSubtitle: string
	/**
	 * Heading size in the PNG. Omit for the default display size; set it when
	 * an authored line would otherwise wrap past its hard break.
	 */
	imageTitleFontSize?: number
	/** `og:title` / `twitter:title` for the page. */
	ogTitle: string
	/** `og:description` / `twitter:description` for the page. */
	ogDescription: string
	/** Canonical page path (used for `og:url` and the canonical link). */
	path: string
}

export const publicOgPages = {
	home: {
		// Locked share card. `**` is accent emphasis in the PNG. The newline is
		// the 1200×630 break (after "for"), not a wording change. Meta uses
		// the same words with the markers removed.
		imageTitle: homeOgImageTitle,
		imageSubtitle: homeOgImageSubtitle,
		// "your team's agents" overflows the title column at the default 78px.
		imageTitleFontSize: 72,
		ogTitle: stripOgEmphasis(homeOgImageTitle),
		ogDescription: homeOgImageSubtitle,
		path: '/',
	},
	community: {
		imageTitle: 'Public packages',
		imageSubtitle:
			'Browse packages shared by Kody users, fork them into your own assistant, and rate what works.',
		ogTitle: 'Public packages — Kody',
		ogDescription: 'Browse public packages shared by Kody users.',
		path: '/community',
	},
	blog: {
		imageTitle: 'Kody Blog',
		imageSubtitle:
			'Updates and positioning posts from Kent C. Dodds about Kody.',
		ogTitle: 'Blog — Kody',
		ogDescription:
			'Updates and positioning posts from Kent C. Dodds about Kody.',
		path: '/blog',
	},
	login: {
		imageTitle: 'Your agents\u2019 cloud',
		imageSubtitle:
			"For all the agents you use today,\nand the ones you'll use tomorrow",
		ogTitle: 'Sign in — Kody',
		ogDescription:
			"For all the agents you use today, and the ones you'll use tomorrow.",
		path: '/login',
	},
	signup: {
		imageTitle: 'Your agents\u2019 cloud',
		imageSubtitle:
			"For all the agents you use today,\nand the ones you'll use tomorrow",
		ogTitle: 'Sign up — Kody',
		ogDescription:
			"For all the agents you use today, and the ones you'll use tomorrow.",
		path: '/signup',
	},
	features: {
		imageTitle: 'Your agents’ cloud',
		imageSubtitle:
			'Memory, packages, triggers, credentials, and apps for your connected AI agents.',
		ogTitle: 'Kody features for your AI agents | Kody',
		ogDescription:
			'Memory, packages, triggers, credentials, and apps for your connected AI agents.',
		path: '/features',
	},
	'feature-memory': {
		imageTitle: 'New agent. Same you.',
		imageSubtitle:
			'Save facts and preferences in Kody and use them with agents connected to your account.',
		ogTitle: 'Shared memory for your AI agents | Kody',
		ogDescription:
			'Save facts and preferences in Kody and use them with agents connected to your account.',
		path: '/features/memory',
	},
	'feature-packages': {
		imageTitle: 'Work worth keeping.',
		imageSubtitle:
			'Save reusable code, review its source, publish changes, and share access to your packages.',
		ogTitle: 'Reusable packages for your AI agents | Kody',
		ogDescription:
			'Save reusable code, review its source, publish changes, and share access to your packages.',
		path: '/features/packages',
	},
	'feature-triggers': {
		imageTitle: 'When it happens, your work starts.',
		imageSubtitle:
			'Start saved packages from schedules, webhooks, incoming email, and package events.',
		ogTitle: 'Triggers and automation for your AI agents | Kody',
		ogDescription:
			'Start saved packages from schedules, webhooks, incoming email, and package events.',
		path: '/features/triggers',
	},
	'feature-credentials': {
		imageTitle: 'Your agent can use the key. It can’t read it.',
		imageSubtitle:
			'API keys and OAuth connections your agents use but never see, sent only to hosts you approve.',
		ogTitle: 'Credentials for your AI agents | Kody',
		ogDescription:
			'Keep API keys and OAuth connections out of the conversation. Anything that speaks OAuth can connect, and Kody sends credentials only to hosts you approve.',
		path: '/features/credentials',
	},
	'feature-apps': {
		imageTitle: 'Give your work an interface.',
		imageSubtitle:
			'Build browser interfaces backed by saved packages and durable package storage.',
		ogTitle: 'Package apps for your AI agents | Kody',
		ogDescription:
			'Build browser interfaces backed by saved packages and durable package storage.',
		path: '/features/apps',
	},
	business: {
		imageTitle: 'The agent cloud\nfor your business',
		imageSubtitle:
			'Shared tools, data, and automations for teams and agencies.',
		ogTitle: 'AI Agent Cloud for Business and Agencies | Kody',
		ogDescription:
			'Give your teams and AI agents a shared home for tools, data, and automations. Run work across departments and client organizations with clear ownership.',
		path: '/for/business',
	},
	pricing: {
		imageTitle: 'Simple Kody pricing',
		imageSubtitle: 'Every plan is the whole factory. You pay for volume.',
		ogTitle: 'Pricing — Kody',
		ogDescription:
			'Every plan is the whole factory. You pay for volume. Paid plans raise the caps.',
		path: '/pricing',
	},
	faq: {
		imageTitle: 'FAQ',
		imageSubtitle:
			'What Kody is, what it is not, and how your assistant stays yours.',
		ogTitle: 'FAQ — Kody',
		ogDescription:
			'Common questions about what Kody is, what it is not, and how your assistant stays yours.',
		path: '/faq',
	},
	'case-studies': {
		imageTitle: 'Case studies',
		imageSubtitle:
			'Longer notes from people using Kody — how it shows up in their work.',
		ogTitle: 'Case studies — Kody',
		ogDescription:
			'Longer notes from people using Kody — how it shows up in their work.',
		path: '/case-studies',
	},
	believe: {
		imageTitle: 'What we believe',
		imageSubtitle:
			'Invisible software: problems solved, not another app to learn.',
		ogTitle: 'What we believe: Kody',
		ogDescription:
			'The beliefs behind Kody, each tied to how the product behaves today.',
		path: '/believe',
	},
	support: {
		imageTitle: 'Support',
		imageSubtitle: 'Contact the hosted kody.codes service.',
		ogTitle: 'Support — Kody',
		ogDescription: 'Contact support for the hosted Kody service at kody.codes.',
		path: '/support',
	},
	about: {
		imageTitle: 'About Kody',
		imageSubtitle:
			"Your agents' cloud: what Kody is, who builds it, and how to reach us.",
		ogTitle: 'About Kody',
		ogDescription:
			"Kody is Your agents' cloud for individuals and teams. Built by Kent C. Dodds at kody.codes.",
		path: '/about',
	},
	'brand-guide': {
		imageTitle: 'Brand guide',
		imageSubtitle: 'Download the Kody mark and follow simple usage rules.',
		ogTitle: 'Brand guide — Kody',
		ogDescription:
			'Download the Kody koala mark as SVG or PNG, and see light and dark treatments.',
		path: '/brand-guide',
	},
	contact: {
		imageTitle: 'Contact Kody',
		imageSubtitle: 'Support, teams, security, and community channels.',
		ogTitle: 'Contact Kody',
		ogDescription:
			'Email support@kody.codes, join Discord, or open a GitHub issue for the hosted Kody service.',
		path: '/contact',
	},
	privacy: {
		imageTitle: 'Privacy',
		imageSubtitle:
			'How Kody stores your data and what a deployment admin can see.',
		ogTitle: 'Privacy — Kody',
		ogDescription:
			'How Kody stores your data and what a deployment admin can see.',
		path: '/privacy',
	},
	terms: {
		imageTitle: 'Terms',
		imageSubtitle: 'Terms and acceptable use for this Kody deployment.',
		ogTitle: 'Terms — Kody',
		ogDescription: 'Terms and acceptable use for this Kody deployment.',
		path: '/terms',
	},
	discord: {
		imageTitle: 'Kody Discord',
		imageSubtitle:
			'Join the official server and connect your Kody account for member and plan roles.',
		ogTitle: 'Discord — Kody',
		ogDescription:
			'Join the official Kody Discord and connect your account so we can assign member and plan roles.',
		path: '/discord',
	},
	onboarding: {
		imageTitle: 'Get started with Kody',
		imageSubtitle:
			'Connect your AI agent host and set up Kody for you or your team.',
		ogTitle: 'Get started — Kody',
		ogDescription:
			'Connect your AI agent host and set up Kody for you or your team.',
		path: '/onboarding',
	},
	'reset-password': {
		imageTitle: 'Reset your password',
		imageSubtitle: 'Choose a new password for your kody account.',
		ogTitle: 'Reset password — Kody',
		ogDescription: 'Choose a new password for your kody account.',
		path: '/reset-password',
	},
} as const satisfies Record<string, PublicOgPage>

export type PublicOgPageId = keyof typeof publicOgPages

export function getPublicOgPage(pageId: string): PublicOgPage | null {
	if (Object.hasOwn(publicOgPages, pageId)) {
		return publicOgPages[pageId as PublicOgPageId]
	}
	return null
}
