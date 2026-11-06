import {
	blogCategories,
	blogSeries,
	getBlogSeries,
	type BlogCategorySlug,
	type BlogSeriesSlug,
} from '#universal/blog-taxonomy.ts'
import { parseBlogPostMarkdown, type BlogPost } from './parse-frontmatter.ts'
import earlyKodyUsers from './posts/early-kody-users.md'
import everyInstallIsAForkYouOwn from './posts/every-install-is-a-fork-you-own.md'
import gatewaysConnectHomesAccumulate from './posts/gateways-connect-homes-accumulate.md'
import howToTurnAgentWorkIntoSoftwareYouOwn from './posts/how-to-turn-agent-work-into-software-you-own.md'
import kodyWeekly20260320 from './posts/kody-weekly-2026-03-20.md'
import kodyWeekly20260327 from './posts/kody-weekly-2026-03-27.md'
import kodyWeekly20260403 from './posts/kody-weekly-2026-04-03.md'
import kodyWeekly20260410 from './posts/kody-weekly-2026-04-10.md'
import kodyWeekly20260417 from './posts/kody-weekly-2026-04-17.md'
import kodyWeekly20260424 from './posts/kody-weekly-2026-04-24.md'
import kodyWeekly20260501 from './posts/kody-weekly-2026-05-01.md'
import kodyWeekly20260508 from './posts/kody-weekly-2026-05-08.md'
import kodyWeekly20260515 from './posts/kody-weekly-2026-05-15.md'
import kodyWeekly20260522 from './posts/kody-weekly-2026-05-22.md'
import kodyWeekly20260529 from './posts/kody-weekly-2026-05-29.md'
import kodyWeekly20260605 from './posts/kody-weekly-2026-06-05.md'
import kodyWeekly20260612 from './posts/kody-weekly-2026-06-12.md'
import kodyWeekly20260619 from './posts/kody-weekly-2026-06-19.md'
import kodyWeekly20260626 from './posts/kody-weekly-2026-06-26.md'
import kodyWeekly20260703 from './posts/kody-weekly-2026-07-03.md'
import kodyWeekly20260710 from './posts/kody-weekly-2026-07-10.md'
import kodyWeekly20260717 from './posts/kody-weekly-2026-07-17.md'
import kodyWeekly20260724 from './posts/kody-weekly-2026-07-24.md'
import kodyWeekly20260731 from './posts/kody-weekly-2026-07-31.md'
import kodyWeekly20260807 from './posts/kody-weekly-2026-08-07.md'
import kodyWeekly20260814 from './posts/kody-weekly-2026-08-14.md'
import kodyWeekly20260821 from './posts/kody-weekly-2026-08-21.md'
import kodyWeekly20260828 from './posts/kody-weekly-2026-08-28.md'
import kodyWeekly20260904 from './posts/kody-weekly-2026-09-04.md'
import kodyWeekly20260911 from './posts/kody-weekly-2026-09-11.md'
import kodyWeekly20260918 from './posts/kody-weekly-2026-09-18.md'
import kodyWeekly20260925 from './posts/kody-weekly-2026-09-25.md'
import kodyWeekly20261002 from './posts/kody-weekly-2026-10-02.md'
import kodyWeekly20261009 from './posts/kody-weekly-2026-10-09.md'
import kodyWeekly20261016 from './posts/kody-weekly-2026-10-16.md'
import kodyWeekly20261023 from './posts/kody-weekly-2026-10-23.md'
import kodyWeekly20261030 from './posts/kody-weekly-2026-10-30.md'
import kodyWeekly20261106 from './posts/kody-weekly-2026-11-06.md'
import selfServiceMeansOwnership from './posts/self-service-means-ownership.md'
import theAssistantThatCantLeakYourKeychain from './posts/the-assistant-that-cant-leak-your-keychain.md'
import theAutomationsYouNeverBuilt from './posts/the-automations-you-never-built.md'
import openclaw2NeedsAHome from './posts/openclaw-2-needs-a-home.md'
import yourAssistantsHome from './posts/your-assistants-home.md'
import zeroInferenceCalls from './posts/zero-inference-calls.md'
import engineersAreHandingPrivateKeysToAiAgents from './posts/engineers-are-handing-private-keys-to-ai-agents.md'
import aiAgentGithubAccessWithoutYourToken from './posts/ai-agent-github-access-without-your-token.md'
import aiAgentCredentialsGuideForTeamLeads from './posts/ai-agent-credentials-guide-for-team-leads.md'
import whereToStoreApiKeysForAiAgents from './posts/where-to-store-api-keys-for-ai-agents.md'
import leastPrivilegeForAiAgents from './posts/least-privilege-for-ai-agents.md'
import revokeAiAgentAccess from './posts/revoke-ai-agent-access.md'
import mcpSecurityChecklistForEngineeringManagers from './posts/mcp-security-checklist-for-engineering-managers.md'
import aiAgentAuditLogForProductionAccess from './posts/ai-agent-audit-log-for-production-access.md'
import aiAgentGuardrailsForTeams from './posts/ai-agent-guardrails-for-teams.md'
import whyAiAgentCostsKeepGrowing from './posts/why-ai-agent-costs-keep-growing.md'
import aiToolingForEngineeringTeamsHiddenCost from './posts/ai-tooling-for-engineering-teams-hidden-cost.md'
import teamAiWorkflowsWhenSomeoneQuits from './posts/team-ai-workflows-when-someone-quits.md'
import shareAiWorkflowsWithYourTeam from './posts/share-ai-workflows-with-your-team.md'
import aiAgentSkillsVsPackages from './posts/ai-agent-skills-vs-packages.md'
import claudeCodeCursorAndCodexSharedCredentials from './posts/claude-code-cursor-and-codex-shared-credentials.md'
import bringYourOwnKeyForSharedTeamTools from './posts/bring-your-own-key-for-shared-team-tools.md'
import avoidAiAssistantLockIn from './posts/avoid-ai-assistant-lock-in.md'
import whyAwsLambdaBreaksDownForAiAgentTeams from './posts/why-aws-lambda-breaks-down-for-ai-agent-teams.md'
import internalToolsBuiltWithAiTeamCredentials from './posts/internal-tools-built-with-ai-team-credentials.md'
import howToRollOutAiAgentsToYourTeam from './posts/how-to-roll-out-ai-agents-to-your-team.md'

/**
 * Static post sources. When adding a post, drop a `.md` file under `posts/`
 * and add one import + entry here (and the slug in
 * `#universal/blog-post-slugs.ts`). Pick its category and series with
 * docs/contributing/blog.md. The client never imports this module.
 * Optional `image` / `imageAlt` are
 * headline artwork. Optional `ogImage` is Satori artwork composed into the
 * generated `/blog/:slug/og.png` card.
 */
const postSources: Array<{ slug: string; raw: string }> = [
	{ slug: 'early-kody-users', raw: earlyKodyUsers },
	{ slug: 'your-assistants-home', raw: yourAssistantsHome },
	{
		slug: 'gateways-connect-homes-accumulate',
		raw: gatewaysConnectHomesAccumulate,
	},
	{
		slug: 'the-assistant-that-cant-leak-your-keychain',
		raw: theAssistantThatCantLeakYourKeychain,
	},
	{ slug: 'zero-inference-calls', raw: zeroInferenceCalls },
	{
		slug: 'every-install-is-a-fork-you-own',
		raw: everyInstallIsAForkYouOwn,
	},
	{
		slug: 'the-automations-you-never-built',
		raw: theAutomationsYouNeverBuilt,
	},
	{ slug: 'self-service-means-ownership', raw: selfServiceMeansOwnership },
	{
		slug: 'openclaw-2-needs-a-home',
		raw: openclaw2NeedsAHome,
	},
	{
		slug: 'how-to-turn-agent-work-into-software-you-own',
		raw: howToTurnAgentWorkIntoSoftwareYouOwn,
	},
	{
		slug: 'engineers-are-handing-private-keys-to-ai-agents',
		raw: engineersAreHandingPrivateKeysToAiAgents,
	},
	{
		slug: 'ai-agent-github-access-without-your-token',
		raw: aiAgentGithubAccessWithoutYourToken,
	},
	{
		slug: 'ai-agent-credentials-guide-for-team-leads',
		raw: aiAgentCredentialsGuideForTeamLeads,
	},
	{
		slug: 'where-to-store-api-keys-for-ai-agents',
		raw: whereToStoreApiKeysForAiAgents,
	},
	{
		slug: 'least-privilege-for-ai-agents',
		raw: leastPrivilegeForAiAgents,
	},
	{
		slug: 'revoke-ai-agent-access',
		raw: revokeAiAgentAccess,
	},
	{
		slug: 'mcp-security-checklist-for-engineering-managers',
		raw: mcpSecurityChecklistForEngineeringManagers,
	},
	{
		slug: 'ai-agent-audit-log-for-production-access',
		raw: aiAgentAuditLogForProductionAccess,
	},
	{
		slug: 'ai-agent-guardrails-for-teams',
		raw: aiAgentGuardrailsForTeams,
	},
	{
		slug: 'why-ai-agent-costs-keep-growing',
		raw: whyAiAgentCostsKeepGrowing,
	},
	{
		slug: 'ai-tooling-for-engineering-teams-hidden-cost',
		raw: aiToolingForEngineeringTeamsHiddenCost,
	},
	{
		slug: 'team-ai-workflows-when-someone-quits',
		raw: teamAiWorkflowsWhenSomeoneQuits,
	},
	{
		slug: 'share-ai-workflows-with-your-team',
		raw: shareAiWorkflowsWithYourTeam,
	},
	{
		slug: 'ai-agent-skills-vs-packages',
		raw: aiAgentSkillsVsPackages,
	},
	{
		slug: 'claude-code-cursor-and-codex-shared-credentials',
		raw: claudeCodeCursorAndCodexSharedCredentials,
	},
	{
		slug: 'bring-your-own-key-for-shared-team-tools',
		raw: bringYourOwnKeyForSharedTeamTools,
	},
	{ slug: 'avoid-ai-assistant-lock-in', raw: avoidAiAssistantLockIn },
	{
		slug: 'why-aws-lambda-breaks-down-for-ai-agent-teams',
		raw: whyAwsLambdaBreaksDownForAiAgentTeams,
	},
	{
		slug: 'internal-tools-built-with-ai-team-credentials',
		raw: internalToolsBuiltWithAiTeamCredentials,
	},
	{
		slug: 'how-to-roll-out-ai-agents-to-your-team',
		raw: howToRollOutAiAgentsToYourTeam,
	},
	{ slug: 'kody-weekly-2026-03-20', raw: kodyWeekly20260320 },
	{ slug: 'kody-weekly-2026-03-27', raw: kodyWeekly20260327 },
	{ slug: 'kody-weekly-2026-04-03', raw: kodyWeekly20260403 },
	{ slug: 'kody-weekly-2026-04-10', raw: kodyWeekly20260410 },
	{ slug: 'kody-weekly-2026-04-17', raw: kodyWeekly20260417 },
	{ slug: 'kody-weekly-2026-04-24', raw: kodyWeekly20260424 },
	{ slug: 'kody-weekly-2026-05-01', raw: kodyWeekly20260501 },
	{ slug: 'kody-weekly-2026-05-08', raw: kodyWeekly20260508 },
	{ slug: 'kody-weekly-2026-05-15', raw: kodyWeekly20260515 },
	{ slug: 'kody-weekly-2026-05-22', raw: kodyWeekly20260522 },
	{ slug: 'kody-weekly-2026-05-29', raw: kodyWeekly20260529 },
	{ slug: 'kody-weekly-2026-06-05', raw: kodyWeekly20260605 },
	{ slug: 'kody-weekly-2026-06-12', raw: kodyWeekly20260612 },
	{ slug: 'kody-weekly-2026-06-19', raw: kodyWeekly20260619 },
	{ slug: 'kody-weekly-2026-06-26', raw: kodyWeekly20260626 },
	{ slug: 'kody-weekly-2026-07-03', raw: kodyWeekly20260703 },
	{ slug: 'kody-weekly-2026-07-10', raw: kodyWeekly20260710 },
	{ slug: 'kody-weekly-2026-07-17', raw: kodyWeekly20260717 },
	{ slug: 'kody-weekly-2026-07-24', raw: kodyWeekly20260724 },
	{ slug: 'kody-weekly-2026-07-31', raw: kodyWeekly20260731 },
	{ slug: 'kody-weekly-2026-08-07', raw: kodyWeekly20260807 },
	{ slug: 'kody-weekly-2026-08-14', raw: kodyWeekly20260814 },
	{ slug: 'kody-weekly-2026-08-21', raw: kodyWeekly20260821 },
	{ slug: 'kody-weekly-2026-08-28', raw: kodyWeekly20260828 },
	{ slug: 'kody-weekly-2026-09-04', raw: kodyWeekly20260904 },
	{ slug: 'kody-weekly-2026-09-11', raw: kodyWeekly20260911 },
	{ slug: 'kody-weekly-2026-09-18', raw: kodyWeekly20260918 },
	{ slug: 'kody-weekly-2026-09-25', raw: kodyWeekly20260925 },
	{ slug: 'kody-weekly-2026-10-02', raw: kodyWeekly20261002 },
	{ slug: 'kody-weekly-2026-10-09', raw: kodyWeekly20261009 },
	{ slug: 'kody-weekly-2026-10-16', raw: kodyWeekly20261016 },
	{ slug: 'kody-weekly-2026-10-23', raw: kodyWeekly20261023 },
	{ slug: 'kody-weekly-2026-10-30', raw: kodyWeekly20261030 },
	{ slug: 'kody-weekly-2026-11-06', raw: kodyWeekly20261106 },
]

function compareBlogPosts(a: BlogPost, b: BlogPost): number {
	if (a.date !== b.date) {
		return a.date < b.date ? 1 : -1
	}
	return a.order - b.order
}

/** Cross-post rules the per-file frontmatter parse cannot see. */
function assertCatalogRules(posts: ReadonlyArray<BlogPost>) {
	const slugs = new Set<string>()
	for (const post of posts) {
		if (slugs.has(post.slug)) {
			throw new Error(`Blog post slug "${post.slug}" is listed twice.`)
		}
		slugs.add(post.slug)
	}
	const featured = posts.filter((post) => post.featured)
	if (featured.length > 1) {
		throw new Error(
			`Only one blog post may set "featured: true" (found ${featured
				.map((post) => post.slug)
				.join(', ')}).`,
		)
	}
	for (const series of blogSeries) {
		const parts = posts.filter((post) => post.series === series.slug)
		if (parts.length < 2) {
			throw new Error(
				`Blog series "${series.slug}" needs at least two posts (found ${parts.length}); drop it from #universal/blog-taxonomy.ts or tag more posts.`,
			)
		}
	}
}

function buildCatalog(): ReadonlyArray<BlogPost> {
	const posts = postSources.map(({ slug, raw }) =>
		parseBlogPostMarkdown(slug, raw),
	)
	assertCatalogRules(posts)
	return posts.sort(compareBlogPosts)
}

const blogPosts: ReadonlyArray<BlogPost> = buildCatalog()

const postsBySlug = new Map(blogPosts.map((post) => [post.slug, post]))

export function getBlogPost(slug: string): BlogPost | null {
	return postsBySlug.get(slug) ?? null
}

/**
 * Collapse markdown blockquote markers and wrapping so phrase pins survive
 * oxfmt reflow. Use this instead of `post.body.includes('exact sentence')`
 * when the pin lives in a `>` blockquote.
 */
export function normalizeMarkdownPhraseSource(source: string) {
	return source.replaceAll(/^>\s?/gm, '').replace(/\s+/g, ' ')
}

/** Every post, newest first (ties by `order`). */
export function listBlogPosts(): ReadonlyArray<BlogPost> {
	return blogPosts
}

export function listBlogCategoryPosts(
	category: BlogCategorySlug,
): ReadonlyArray<BlogPost> {
	return blogPosts.filter((post) => post.category === category)
}

/** Series parts in reading order: oldest first. */
export function listBlogSeriesPosts(
	series: BlogSeriesSlug,
): ReadonlyArray<BlogPost> {
	return blogPosts.filter((post) => post.series === series).reverse()
}

/** Categories with at least one post, in taxonomy order, with counts. */
export function listBlogCategoriesWithPosts() {
	return blogCategories
		.map((category) => ({
			slug: category.slug,
			label: category.label,
			count: listBlogCategoryPosts(category.slug).length,
		}))
		.filter((category) => category.count > 0)
}

/**
 * The index hero: the post pinned with `featured: true`, else the newest
 * post outside `updates` (weekly notes would otherwise always win).
 */
export function getFeaturedBlogPost(): BlogPost | null {
	return (
		blogPosts.find((post) => post.featured) ??
		blogPosts.find((post) => post.category !== 'updates') ??
		blogPosts[0] ??
		null
	)
}

/** Index / API summary shape (no markdown body). */
export type BlogPostSummary = {
	slug: string
	title: string
	date: string
	updated: string | null
	description: string
	category: BlogCategorySlug
	series: BlogSeriesSlug | null
	readingMinutes: number
	image: string | null
	imageAlt: string | null
}

export function toBlogPostSummary(post: BlogPost): BlogPostSummary {
	return {
		slug: post.slug,
		title: post.title,
		date: post.date,
		updated: post.updated,
		description: post.description,
		category: post.category,
		series: post.series,
		readingMinutes: post.readingMinutes,
		image: post.image,
		imageAlt: post.imageAlt,
	}
}

export type BlogSeriesNav = {
	slug: BlogSeriesSlug
	title: string
	/** 1-based position of the current post. */
	part: number
	parts: Array<{ slug: string; title: string }>
}

export function getBlogSeriesNav(slug: string): BlogSeriesNav | null {
	const post = getBlogPost(slug)
	const series = post?.series ? getBlogSeries(post.series) : null
	if (!post || !series) return null
	const parts = listBlogSeriesPosts(series.slug).map((part) => ({
		slug: part.slug,
		title: part.title,
	}))
	return {
		slug: series.slug,
		title: series.title,
		part: parts.findIndex((part) => part.slug === slug) + 1,
		parts,
	}
}

function daysApart(a: BlogPost, b: BlogPost) {
	return Math.abs(Date.parse(a.date) - Date.parse(b.date))
}

/**
 * Up to `limit` posts to read next: the same category first, then anything
 * outside `updates`, nearest in date. Series siblings are left out because
 * the series nav already lists them.
 */
export function getRelatedBlogPosts(
	slug: string,
	limit = 3,
): Array<BlogPostSummary> {
	const post = getBlogPost(slug)
	if (!post) return []
	const candidates = blogPosts.filter(
		(other) =>
			other.slug !== post.slug &&
			(post.series === null || other.series !== post.series),
	)
	const byDistance = (a: BlogPost, b: BlogPost) =>
		daysApart(a, post) - daysApart(b, post) || compareBlogPosts(a, b)
	const sameCategory = candidates
		.filter((other) => other.category === post.category)
		.sort(byDistance)
	const fallback = candidates
		.filter(
			(other) =>
				other.category !== post.category && other.category !== 'updates',
		)
		.sort(byDistance)
	return [...sameCategory, ...fallback].slice(0, limit).map(toBlogPostSummary)
}
