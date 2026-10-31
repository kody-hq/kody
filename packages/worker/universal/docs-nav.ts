/**
 * Information architecture for the `/docs` site (web sidebar, markdown /
 * JSON / `llms.txt` indexes, sitemap, and prev/next links).
 *
 * The docs are bundled from `docs/guides/**\/*.md` (see
 * `#worker/guides/catalog.ts`); MCP still addresses them as `guide:{id}`
 * entities. This module owns only the reading order and grouping. Adding a
 * doc means adding its slug here (or to `unadvertisedDocSlugs`); the catalog
 * throws at module scope when a bundled guide is missing from both lists or
 * when a listed slug has no matching file — see `guide-order.ts`.
 *
 * Labels are the short sidebar names. Page titles (frontmatter `title`) can
 * be longer and more descriptive.
 */

export type DocsNavItem = {
	slug: string
	/** Short sidebar label. */
	label: string
}

export type DocsNavSection = {
	id: string
	label: string
	/** One line under the section heading in markdown / llms indexes. */
	description: string
	items: ReadonlyArray<DocsNavItem>
	/**
	 * When true, the section is omitted from public nav, indexes, sitemap, and
	 * search. Logged-in admins see it; everyone else does not.
	 */
	adminOnly?: boolean
}

/**
 * The first article. `/docs` renders it (canonical); `/docs/what-is-kody`
 * serves the same page so links and agent fetches without redirect support
 * keep working.
 */
export const docsIntroSlug = 'what-is-kody'

/**
 * Path segments under `/docs/` reserved for index and companion routes.
 * Catalog docs must not use these slugs — they would collide.
 */
const reservedDocsIndexSlugs = ['connect', 'llms.txt'] as const

export const docsNav: ReadonlyArray<DocsNavSection> = [
	{
		id: 'introduction',
		label: 'Introduction',
		description:
			'What Kody is, the two MCP tools, and the loop those tools run.',
		items: [
			{ slug: 'what-is-kody', label: 'What is Kody?' },
			{ slug: 'search-and-execute', label: 'Search and execute' },
			{ slug: 'how-kody-works', label: 'How Kody works' },
			{ slug: 'kody-factory', label: 'The factory map' },
		],
	},
	{
		id: 'get-started',
		label: 'Get started',
		description:
			'Connect the agent you already use, make one useful thing, then reuse it from a second agent.',
		items: [
			{ slug: 'connect-your-agent', label: 'Connect your agent' },
			{ slug: 'onboarding', label: 'First run (agent playbook)' },
			{ slug: 'quick-example', label: 'First build (agent playbook)' },
			{ slug: 'portability', label: 'Second agent (agent playbook)' },
			{ slug: 'first-win', label: 'Email and memories (optional)' },
		],
	},
	{
		id: 'concepts',
		label: 'Concepts',
		description:
			'The primitives every connected agent shares: memory, credentials, packages, triggers, and the runtime.',
		items: [
			{ slug: 'memory', label: 'Shared memory' },
			{ slug: 'agent-guidance', label: 'Agent guidance' },
			{ slug: 'credentials', label: 'Credentials' },
			{ slug: 'secrets', label: 'Secrets' },
			{ slug: 'secret-providers', label: 'Custom secret providers' },
			{
				slug: 'packages-integrations-mcp',
				label: 'Packages vs integrations vs MCP',
			},
			{ slug: 'organizations', label: 'Organizations' },
			{ slug: 'text-your-agent', label: 'Text your agent' },
			{ slug: 'openmuse', label: 'OpenMuse and Kody' },
			{ slug: 'triggers', label: 'Jobs, workflows, and webhooks' },
			{ slug: 'platform-efficiency', label: 'Runtime and efficiency' },
			{ slug: 'local-execute', label: 'Local CLI execute' },
			{ slug: 'execution-contexts', label: 'Execution contexts' },
			{ slug: 'profiles', label: 'Profiles' },
			{ slug: 'auth-setup-git', label: 'Git credential helper' },
			{ slug: 'open-api', label: 'Kody Open API' },
			{ slug: 'api-tokens', label: 'API tokens (API keys)' },
			{ slug: 'api-versioning', label: 'API versioning' },
		],
	},
	{
		id: 'examples',
		label: 'Examples',
		description:
			'Homepage trigger cards as worked examples: cron, webhook, email, and event.',
		items: [
			{ slug: 'flake-hunter', label: 'Flake Hunter' },
			{ slug: 'sentry-issues', label: 'Sentry Issues' },
			{ slug: 'agent-inbox', label: 'Agent inbox' },
			{ slug: 'purchase-thanks', label: 'Purchase thanks' },
		],
	},
	{
		id: 'packages',
		label: 'Packages',
		description: 'Turn working code into a package you own, then grow it.',
		items: [
			{
				slug: 'package-lifecycle',
				label: 'Lifecycle: reuse, execute, fork, create',
			},
			{ slug: 'package-authoring', label: 'Authoring' },
			{ slug: 'package-sharing', label: 'Sharing a package' },
			{ slug: 'shared-packages', label: 'Shared packages for many accounts' },
			{ slug: 'package-skills', label: 'Package skills' },
			{ slug: 'package-apps', label: 'Package apps' },
			{
				slug: 'package-app-custom-domains',
				label: 'Custom domains for apps',
			},
			{ slug: 'package-subscriptions', label: 'Subscriptions and events' },
			{ slug: 'mcp-events', label: 'MCP Events' },
			{ slug: 'wake-your-agent', label: 'Wake your agent' },
			{ slug: 'heavy-work-offload', label: 'Offload heavy work' },
		],
	},
	{
		id: 'integrations',
		label: 'Integrations',
		description:
			'Bring your own keys, OAuth apps, OpenAPI documents, and MCP servers — and lock them to the code that should use them.',
		items: [
			{ slug: 'integration-bootstrap', label: 'Integration bootstrap' },
			{ slug: 'oauth', label: 'OAuth (bring your own app)' },
			{ slug: 'google-oauth', label: 'Google OAuth walkthrough' },
			{
				slug: 'secret-backed-integration',
				label: 'Secret-backed integrations',
			},
			{ slug: 'account-secret-setup', label: 'Secret setup URL reference' },
			{ slug: 'openapi-integrations', label: 'OpenAPI integrations' },
			{ slug: 'local-mcp-tunnels', label: 'Connect a home MCP server' },
			{ slug: 'locked-mcp-server', label: 'Lock an MCP server to a package' },
			{ slug: 'locked-gmail-drafts', label: 'Gmail drafts without send' },
		],
	},
	{
		id: 'providers',
		label: 'Connect a provider',
		description:
			'Verified, console-by-console walkthroughs for connecting a specific service.',
		items: [
			{ slug: 'discord', label: 'Discord' },
			{ slug: 'dropbox', label: 'Dropbox' },
			{ slug: 'figma', label: 'Figma' },
			{ slug: 'github', label: 'GitHub' },
			{ slug: 'google', label: 'Google' },
			{ slug: 'notion', label: 'Notion' },
			{ slug: 'origin', label: 'Origin' },
			{ slug: 'salesforce', label: 'Salesforce' },
			{ slug: 'slack', label: 'Slack' },
			{ slug: 'spotify', label: 'Spotify' },
		],
	},
	{
		id: 'help',
		label: 'Help',
		description: 'When Kody gets in the way.',
		items: [
			{ slug: 'limited-browser-sign-in', label: 'Sign in from an e-reader' },
			{
				slug: 'cant-open-or-get-mail',
				label: "Can't open or get mail",
			},
			{ slug: 'platform-friction', label: 'Report friction' },
		],
	},
	{
		id: 'admin',
		label: 'Admin',
		description:
			'Operator topics visible only when you are signed in with the admin role.',
		adminOnly: true,
		items: [{ slug: 'admin-events', label: 'Admin events' }],
	},
]

/**
 * Bundled docs that stay reachable by exact slug / MCP id but are left out
 * of the sidebar, indexes, sitemap, and search advertisements. Matches the
 * frontmatter `unadvertised: true` flag on each file.
 */
export const unadvertisedDocSlugs: ReadonlyArray<string> = []

/**
 * Old slugs that no longer exist as their own page. The legacy `/guides/*`
 * redirect and the `/docs/:slug` handler send them to the doc (and heading)
 * that absorbed the content.
 */
export const legacyDocSlugAliases: Readonly<
	Record<string, { slug: string; fragment?: string }>
> = {
	'integration-backed-app-happy-path': {
		slug: 'package-apps',
		fragment: 'after-an-integration-smoke-test',
	},
	webhooks: {
		slug: 'triggers',
		fragment: 'inbound-webhooks-the-external-http-knock',
	},
}

/**
 * Old MCP guide ids for docs merged into another doc. `search({ entity })`
 * resolves these to the absorbing guide (optionally scoped to a heading).
 */
export const legacyGuideIdAliases: Readonly<
	Record<string, { id: string; section?: string }>
> = {
	integration_backed_app: {
		id: 'package_apps',
		section: 'after-an-integration-smoke-test',
	},
	what_can_kody_do: { id: 'what_is_kody' },
}

/**
 * `docs/use` filenames whose page only points at a catalog guide.
 * Bundled links to those files resolve to the served `/docs` route.
 */
export const useDocGuideTwins: Readonly<Record<string, string>> = {
	'what-can-kody-do': 'what-is-kody',
	'package-skills': 'package-skills',
	'mcp-events': 'mcp-events',
}

export function isReservedDocsIndexSlug(slug: string): boolean {
	return (reservedDocsIndexSlugs as ReadonlyArray<string>).includes(slug)
}

/**
 * Sidebar section for the current page. `/docs/connect` is the providers
 * index (not a catalog slug), so it resolves to that section.
 */
export function resolveDocsNavSection(current: string): DocsNavSection | null {
	if (current === 'connect') {
		return docsNav.find((section) => section.id === 'providers') ?? null
	}
	return findDocsNavSection(current)
}

/** Short label for the open page — mobile menu current, focus target copy. */
export function docsCurrentPageLabel(current: string): string {
	if (current === 'connect') return 'Connect a provider'
	const section = findDocsNavSection(current)
	const item = section?.items.find((entry) => entry.slug === current)
	return item?.label ?? section?.label ?? 'Docs'
}

function isAdminOnlyDocsSection(section: DocsNavSection): boolean {
	return section.adminOnly === true
}

/** Sidebar / index sections the viewer is allowed to see. */
export function visibleDocsNav(
	includeAdmin = false,
): ReadonlyArray<DocsNavSection> {
	if (includeAdmin) return docsNav
	return docsNav.filter((section) => !isAdminOnlyDocsSection(section))
}

/** Every advertised slug in reading order (sidebar order). */
export function listDocsNavSlugs(options?: {
	includeAdmin?: boolean
}): ReadonlyArray<string> {
	return visibleDocsNav(options?.includeAdmin !== false).flatMap((section) =>
		section.items.map((item) => item.slug),
	)
}

export function findDocsNavSection(slug: string): DocsNavSection | null {
	return (
		docsNav.find((section) =>
			section.items.some((item) => item.slug === slug),
		) ?? null
	)
}

/** Previous and next docs in reading order; null at either end. */
export function findDocsNavNeighbors(
	slug: string,
	options?: { includeAdmin?: boolean },
): {
	prev: DocsNavItem | null
	next: DocsNavItem | null
} {
	const items = visibleDocsNav(options?.includeAdmin === true).flatMap(
		(section) => section.items,
	)
	const index = items.findIndex((item) => item.slug === slug)
	if (index === -1) return { prev: null, next: null }
	return {
		prev: items[index - 1] ?? null,
		next: items[index + 1] ?? null,
	}
}

/**
 * Canonical web path for a doc. The introduction lives at `/docs` itself;
 * everything else is `/docs/:slug`.
 */
export function docHref(slug: string): string {
	return slug === docsIntroSlug ? '/docs' : `/docs/${slug}`
}

/** Raw markdown twin for a doc (`/docs/:slug.md`). */
export function docMarkdownHref(slug: string): string {
	return `/docs/${slug}.md`
}

export function resolveLegacyDocSlug(slug: string): {
	slug: string
	fragment: string | null
} {
	const alias = legacyDocSlugAliases[slug]
	if (!alias) return { slug, fragment: null }
	return { slug: alias.slug, fragment: alias.fragment ?? null }
}
