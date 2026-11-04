import { parseBlogPostMarkdown, type BlogPost } from './parse-frontmatter.ts'
import earlyKodyUsers from './posts/early-kody-users.md'
import everyInstallIsAForkYouOwn from './posts/every-install-is-a-fork-you-own.md'
import gatewaysConnectHomesAccumulate from './posts/gateways-connect-homes-accumulate.md'
import howToTurnAgentWorkIntoSoftwareYouOwn from './posts/how-to-turn-agent-work-into-software-you-own.md'
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
 * and add one import + entry here. The client never imports this module.
 * After a human review, set `placeholder: false` in that post's frontmatter
 * to hide the AI-placeholder callout. Optional `image` / `imageAlt` are
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
]

function compareBlogPosts(a: BlogPost, b: BlogPost): number {
	if (a.date !== b.date) {
		return a.date < b.date ? 1 : -1
	}
	return a.order - b.order
}

function buildCatalog(): ReadonlyArray<BlogPost> {
	const posts = postSources.map(({ slug, raw }) =>
		parseBlogPostMarkdown(slug, raw),
	)
	return posts.sort(compareBlogPosts)
}

export const blogPosts: ReadonlyArray<BlogPost> = buildCatalog()

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

export function listBlogPosts(): ReadonlyArray<BlogPost> {
	return blogPosts
}

/** Slug + title pointer for the post foot's "Read next" link. */
export type BlogPostPointer = {
	slug: string
	title: string
}

/**
 * The post that follows `slug` in catalog order (newest → oldest, then
 * `order`). Wraps from the last post back to the first so every post foot has
 * somewhere to send the reader; null only when the post is unknown or alone.
 */
export function getReadNextBlogPost(slug: string): BlogPostPointer | null {
	const index = blogPosts.findIndex((post) => post.slug === slug)
	if (index === -1 || blogPosts.length < 2) return null
	const next = blogPosts[(index + 1) % blogPosts.length]
	if (!next) return null
	return { slug: next.slug, title: next.title }
}

/** Index / API summary shape (no markdown body). */
export type BlogPostSummary = {
	slug: string
	title: string
	date: string
	description: string
	order: number
}

export function toBlogPostSummary(post: BlogPost): BlogPostSummary {
	return {
		slug: post.slug,
		title: post.title,
		date: post.date,
		description: post.description,
		order: post.order,
	}
}
