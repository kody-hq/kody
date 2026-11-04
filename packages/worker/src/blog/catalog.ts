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
import aiAgentRepoAccessWithoutYourGithubToken from './posts/ai-agent-repo-access-without-your-github-token.md'
import teamLeadGuideToAiAgentCredentials from './posts/team-lead-guide-to-ai-agent-credentials.md'
import stopPastingApiKeysIntoAgentConfigs from './posts/stop-pasting-api-keys-into-agent-configs.md'
import leastPrivilegeTokensForAiAgents from './posts/least-privilege-tokens-for-ai-agents.md'
import revokeAiAgentAccessInOnePlace from './posts/revoke-ai-agent-access-in-one-place.md'
import mcpSecurityChecklistForEngineeringManagers from './posts/mcp-security-checklist-for-engineering-managers.md'
import whatYourTeamsAgentsDidWithProductionAccess from './posts/what-your-teams-agents-did-with-production-access.md'
import guardrailsOnAgentAutonomyForTeams from './posts/guardrails-on-agent-autonomy-for-teams.md'
import whyYourAiAgentBillKeepsGrowing from './posts/why-your-ai-agent-bill-keeps-growing.md'
import hiddenCostOfEveryoneBuildingAgentTooling from './posts/hidden-cost-of-everyone-building-agent-tooling.md'
import teamAiWorkflowsWhenSomeoneQuits from './posts/team-ai-workflows-when-someone-quits.md'
import shareAiAgentWorkflowsAcrossATeam from './posts/share-ai-agent-workflows-across-a-team.md'
import skillsVsPackagesAgentPromptsToCode from './posts/skills-vs-packages-agent-prompts-to-code.md'
import shareCredentialsAcrossClaudeCodeCursorCodex from './posts/share-credentials-across-claude-code-cursor-codex.md'
import bringYourOwnKeySharedAgentTools from './posts/bring-your-own-key-shared-agent-tools.md'
import buildOnceUseFromAnyAgent from './posts/build-once-use-from-any-agent.md'
import whyAwsLambdaBreaksDownForAiAgentTeams from './posts/why-aws-lambda-breaks-down-for-ai-agent-teams.md'
import agentBuiltInternalAppsReuseTeamCredentials from './posts/agent-built-internal-apps-reuse-team-credentials.md'
import rollingOutAiAgentsToANonAiForwardTeam from './posts/rolling-out-ai-agents-to-a-non-ai-forward-team.md'

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
		slug: 'ai-agent-repo-access-without-your-github-token',
		raw: aiAgentRepoAccessWithoutYourGithubToken,
	},
	{
		slug: 'team-lead-guide-to-ai-agent-credentials',
		raw: teamLeadGuideToAiAgentCredentials,
	},
	{
		slug: 'stop-pasting-api-keys-into-agent-configs',
		raw: stopPastingApiKeysIntoAgentConfigs,
	},
	{
		slug: 'least-privilege-tokens-for-ai-agents',
		raw: leastPrivilegeTokensForAiAgents,
	},
	{
		slug: 'revoke-ai-agent-access-in-one-place',
		raw: revokeAiAgentAccessInOnePlace,
	},
	{
		slug: 'mcp-security-checklist-for-engineering-managers',
		raw: mcpSecurityChecklistForEngineeringManagers,
	},
	{
		slug: 'what-your-teams-agents-did-with-production-access',
		raw: whatYourTeamsAgentsDidWithProductionAccess,
	},
	{
		slug: 'guardrails-on-agent-autonomy-for-teams',
		raw: guardrailsOnAgentAutonomyForTeams,
	},
	{
		slug: 'why-your-ai-agent-bill-keeps-growing',
		raw: whyYourAiAgentBillKeepsGrowing,
	},
	{
		slug: 'hidden-cost-of-everyone-building-agent-tooling',
		raw: hiddenCostOfEveryoneBuildingAgentTooling,
	},
	{
		slug: 'team-ai-workflows-when-someone-quits',
		raw: teamAiWorkflowsWhenSomeoneQuits,
	},
	{
		slug: 'share-ai-agent-workflows-across-a-team',
		raw: shareAiAgentWorkflowsAcrossATeam,
	},
	{
		slug: 'skills-vs-packages-agent-prompts-to-code',
		raw: skillsVsPackagesAgentPromptsToCode,
	},
	{
		slug: 'share-credentials-across-claude-code-cursor-codex',
		raw: shareCredentialsAcrossClaudeCodeCursorCodex,
	},
	{
		slug: 'bring-your-own-key-shared-agent-tools',
		raw: bringYourOwnKeySharedAgentTools,
	},
	{ slug: 'build-once-use-from-any-agent', raw: buildOnceUseFromAnyAgent },
	{
		slug: 'why-aws-lambda-breaks-down-for-ai-agent-teams',
		raw: whyAwsLambdaBreaksDownForAiAgentTeams,
	},
	{
		slug: 'agent-built-internal-apps-reuse-team-credentials',
		raw: agentBuiltInternalAppsReuseTeamCredentials,
	},
	{
		slug: 'rolling-out-ai-agents-to-a-non-ai-forward-team',
		raw: rollingOutAiAgentsToANonAiForwardTeam,
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
