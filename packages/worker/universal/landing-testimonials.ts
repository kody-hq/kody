/**
 * Homepage testimonials. Keep this list data-only — the carousel scales to
 * about eight entries without a layout rewrite. Do not invent quotes or fill
 * empty slots; add real cleared quotes only. Opt a card into a longer story
 * with `storyAnchor` matching that heading id (accents strip to ASCII). Omit
 * `storyPath` to use the case-studies blog post; set it only when the longer
 * note lives elsewhere (for example a temporary surface).
 */

import { routes } from '#universal/routes.ts'

/** Blog slug for longer case-study notes linked from the carousel. */
export const landingTestimonialsStorySlug = 'early-kody-users'

export type LandingTestimonial = {
	quote: string
	name: string
	/** Public profile photo under `/images/testimonials/`, or null for initials. */
	photo: string | null
	/** Personal site or primary public social profile, or null when none is published. */
	href: string | null
	/** Verified public occupation or role — omit if unsure. */
	title?: string
	/** Verified public employer — omit if unsure. */
	company?: string
	/** Heading id on the story page. Omit when there is no longer note. */
	storyAnchor?: string
	/**
	 * Path for the longer story (no hash). Defaults to the case-studies blog
	 * post when omitted.
	 */
	storyPath?: string
}

export const landingTestimonials = [
	{
		quote:
			"Between my organization and myself we pay for six accounts over four providers. I don't want personal tokens on work harnesses or work tokens on personal devices. Kody funnels everything into one secure MCP I manage myself. The interoperability is the real magic.",
		name: 'Josh Tomaino',
		photo: '/images/testimonials/josh-tomaino.webp',
		href: 'https://copyjosh.com/',
		title: 'Engineering Manager',
		company: 'Cloverleaf.me',
		storyAnchor: 'josh-tomaino',
	},
	{
		quote:
			"Kody gives our agents durable and credentialed access to infrastructure. Agents own deployment automation, while Kody owns the secure execution layer. In contested environments, that split keeps us moving when downtime isn't an option.",
		name: 'Jett Hays',
		photo: '/images/testimonials/jett-hays.webp',
		href: 'https://sentala.org',
		title: 'Head of Software',
		company: 'Sentala',
		storyAnchor: 'jett-hays',
	},
	{
		quote:
			'Kody transformed how I work. Railway health checks land in Discord, a personal task list replaced the Notion notes I always lost, and everything I need lives in one place.',
		name: 'Gabriel Alegría',
		photo: '/images/testimonials/gabriel-alegria.webp',
		href: 'https://www.linkedin.com/in/gabriel-alegria-mx',
		title: 'Software Engineer',
		company: 'IB',
		storyAnchor: 'gabriel-alegria',
	},
	{
		quote:
			'Kody rocks. Been a user for several hours now and will convert to paid.',
		name: 'Erik Rasmussen',
		photo: '/images/testimonials/erik-rasmussen.webp',
		href: 'https://x.com/erikras/status/2097720067316203941',
	},
	{
		quote:
			'For me, Kody is unbeatable. Being able to write custom pages from my phone using Claude (or any LLM) is crazy. I recently made a simple API wrapper for a product I\'m working on that exposes a Scalar /api/docs page in about two minutes. Now I can just ask Claude "How many users logged in?" or "Reset user\'s password." It\'s awesome!',
		name: 'Bradley Haveman',
		photo: '/images/testimonials/bradley-haveman.webp',
		href: 'https://haveman.ca/',
		title: 'Lead Developer',
		company: 'Lean Labs',
	},
	{
		quote:
			'Before Kody, every new agent meant rebuilding the same setup. Instructions, memory, MCP servers, and skills stayed scattered, and something always got left behind. Now I connect one MCP, bring my packages with me, and say “Hey Kody…” wherever I’m working. Portability plus a feedback loop that shipped three of my bug reports in under an hour.',
		name: 'Maciek Sitkowski',
		photo: '/images/testimonials/maciek-sitkowski.webp',
		href: 'https://macieksitkowski.com',
		title: 'Frontend Developer',
		company: 'Keto-Mojo',
		storyAnchor: 'maciek-sitkowski',
	},
	{
		quote:
			'Kody feels like the missing layer between my coding agents and the real systems I need them to operate. My agents still do the thinking and build the software, but Kody gives that work a durable home that isn’t tied to any one agent or tool.',
		name: 'Justin Elias',
		photo: '/images/testimonials/justin-elias.webp',
		href: 'https://www.linkedin.com/in/justin-elias-22279a75/',
		company: 'Zoot Enterprises',
	},
	{
		quote:
			'Kody means peace of mind for me when working with agents. All of my tools, whether through MCP or a package I created on the fly, and my skills are always with me, no matter what agent harness I use.',
		name: 'Cameron Pak',
		photo: '/images/testimonials/cameron-pak.webp',
		href: 'https://cameronpak.com',
		title: 'Software Developer',
		company: 'Heartwood LLC',
	},
] as const satisfies ReadonlyArray<LandingTestimonial>

export function testimonialInitials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2)
	return parts.map((part) => part[0]?.toUpperCase() ?? '').join('')
}

/** Role and employer for the carousel byline. Omits blank parts. */
export function testimonialAttribution(entry: {
	title?: string
	company?: string
}): string | null {
	const parts = [entry.title, entry.company].filter((part): part is string =>
		Boolean(part),
	)
	if (parts.length === 0) return null
	return parts.join(', ')
}

/** Story page + heading when this person has a longer note; otherwise no link. */
export function testimonialStoryHref(entry: {
	storyAnchor?: string
	storyPath?: string
}): string | null {
	if (!entry.storyAnchor) return null
	const path =
		entry.storyPath ??
		routes.blogPost.href({ slug: landingTestimonialsStorySlug })
	return `${path}#${entry.storyAnchor}`
}
