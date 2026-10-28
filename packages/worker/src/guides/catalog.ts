import { sortGuidesByAuthoredOrder } from './guide-order.ts'
import { parseGuideMarkdown, type Guide } from './parse-frontmatter.ts'
import {
	rewriteRelativeGuideLinks,
	type GuideSourceDir,
} from './rewrite-relative-links.ts'
import {
	docsIntroSlug,
	docsNav,
	isReservedDocsIndexSlug,
	visibleDocsNav,
	type DocsNavSection,
} from '#universal/docs-nav.ts'
import accountSecretSetup from '../../../../docs/guides/account-secret-setup.md'
import adminEvents from '../../../../docs/guides/admin-events.md'
import connectYourAgent from '../../../../docs/guides/connect-your-agent.md'
import firstWin from '../../../../docs/guides/first-win.md'
import flakeHunter from '../../../../docs/guides/flake-hunter.md'
import sentryIssues from '../../../../docs/guides/sentry-issues.md'
import agentInbox from '../../../../docs/guides/agent-inbox.md'
import purchaseThanks from '../../../../docs/guides/purchase-thanks.md'
import howKodyWorks from '../../../../docs/guides/how-kody-works.md'
import searchAndExecute from '../../../../docs/guides/search-and-execute.md'
import googleOauth from '../../../../docs/guides/google-oauth.md'
import kodyFactory from '../../../../docs/guides/kody-factory.md'
import localMcpTunnels from '../../../../docs/guides/local-mcp-tunnels.md'
import heavyWorkOffload from '../../../../docs/guides/heavy-work-offload.md'
import memory from '../../../../docs/guides/memory.md'
import agentGuidance from '../../../../docs/guides/agent-guidance.md'
import quickExample from '../../../../docs/guides/quick-example.md'
import integrationBootstrap from '../../../../docs/guides/integration-bootstrap.md'
import lockedGmailDrafts from '../../../../docs/guides/locked-gmail-drafts.md'
import lockedMcpServer from '../../../../docs/guides/locked-mcp-server.md'
import oauth from '../../../../docs/guides/oauth.md'
import openapiIntegrations from '../../../../docs/guides/openapi-integrations.md'
import packageAuthoring from '../../../../docs/guides/package-authoring.md'
import organizations from '../../../../docs/guides/organizations.md'
import packageSharing from '../../../../docs/guides/package-sharing.md'
import sharedPackages from '../../../../docs/guides/shared-packages.md'
import packageSkills from '../../../../docs/guides/package-skills.md'
import packageApps from '../../../../docs/guides/package-apps.md'
import packageAppCustomDomains from '../../../../docs/guides/package-app-custom-domains.md'
import packageLifecycle from '../../../../docs/guides/package-lifecycle.md'
import platformEfficiency from '../../../../docs/guides/platform-efficiency.md'
import localExecute from '../../../../docs/guides/local-execute.md'
import authSetupGit from '../../../../docs/guides/auth-setup-git.md'
import openApi from '../../../../docs/guides/open-api.md'
import apiVersioning from '../../../../docs/guides/api-versioning.md'
import packagesIntegrationsMcp from '../../../../docs/guides/packages-integrations-mcp.md'
import packageSubscriptions from '../../../../docs/guides/package-subscriptions.md'
import mcpEvents from '../../../../docs/guides/mcp-events.md'
import wakeYourAgent from '../../../../docs/guides/wake-your-agent.md'
import textYourAgent from '../../../../docs/guides/text-your-agent.md'
import openmuse from '../../../../docs/guides/openmuse.md'
import cantOpenOrGetMail from '../../../../docs/guides/cant-open-or-get-mail.md'
import platformFriction from '../../../../docs/guides/platform-friction.md'
import providerDiscord from '../../../../docs/guides/providers/discord.md'
import providerDropbox from '../../../../docs/guides/providers/dropbox.md'
import providerFigma from '../../../../docs/guides/providers/figma.md'
import providerGithub from '../../../../docs/guides/providers/github.md'
import providerGoogle from '../../../../docs/guides/providers/google.md'
import providerNotion from '../../../../docs/guides/providers/notion.md'
import providerOrigin from '../../../../docs/guides/providers/origin.md'
import providerSalesforce from '../../../../docs/guides/providers/salesforce.md'
import providerSlack from '../../../../docs/guides/providers/slack.md'
import providerSpotify from '../../../../docs/guides/providers/spotify.md'
import secretBackedIntegration from '../../../../docs/guides/secret-backed-integration.md'
import secretProviders from '../../../../docs/guides/secret-providers.md'
import credentials from '../../../../docs/guides/credentials.md'
import secrets from '../../../../docs/guides/secrets.md'
import triggers from '../../../../docs/guides/triggers.md'
import whatIsKody from '../../../../docs/guides/what-is-kody.md'
import onboarding from '../../../../docs/guides/onboarding.md'
import portability from '../../../../docs/guides/portability.md'

/**
 * Static doc sources. The canonical markdown lives in `docs/guides/` (also
 * readable on GitHub); this catalog bundles it so the MCP `guide:{id}`
 * search entity, the `/docs` web pages, and the raw `text/markdown`
 * responses all serve exactly the same deployed content. When adding a doc,
 * drop a `.md` file with the frontmatter contract (see
 * `parse-frontmatter.ts`) under `docs/guides/`, add one import + entry
 * here, and place it in `#universal/docs-nav.ts`. Slug = filename minus
 * `.md`.
 */
const guideSources: Array<{ slug: string; raw: string }> = [
	{ slug: 'what-is-kody', raw: whatIsKody },
	{ slug: 'search-and-execute', raw: searchAndExecute },
	{ slug: 'how-kody-works', raw: howKodyWorks },
	{ slug: 'kody-factory', raw: kodyFactory },
	{ slug: 'connect-your-agent', raw: connectYourAgent },
	{ slug: 'onboarding', raw: onboarding },
	{ slug: 'quick-example', raw: quickExample },
	{ slug: 'portability', raw: portability },
	{ slug: 'first-win', raw: firstWin },
	{ slug: 'memory', raw: memory },
	{ slug: 'agent-guidance', raw: agentGuidance },
	{ slug: 'credentials', raw: credentials },
	{ slug: 'secrets', raw: secrets },
	{ slug: 'secret-providers', raw: secretProviders },
	{ slug: 'packages-integrations-mcp', raw: packagesIntegrationsMcp },
	{ slug: 'organizations', raw: organizations },
	{ slug: 'text-your-agent', raw: textYourAgent },
	{ slug: 'openmuse', raw: openmuse },
	{ slug: 'triggers', raw: triggers },
	{ slug: 'platform-efficiency', raw: platformEfficiency },
	{ slug: 'local-execute', raw: localExecute },
	{ slug: 'auth-setup-git', raw: authSetupGit },
	{ slug: 'open-api', raw: openApi },
	{ slug: 'api-versioning', raw: apiVersioning },
	{ slug: 'flake-hunter', raw: flakeHunter },
	{ slug: 'sentry-issues', raw: sentryIssues },
	{ slug: 'agent-inbox', raw: agentInbox },
	{ slug: 'purchase-thanks', raw: purchaseThanks },
	{ slug: 'package-lifecycle', raw: packageLifecycle },
	{ slug: 'package-authoring', raw: packageAuthoring },
	{ slug: 'package-sharing', raw: packageSharing },
	{ slug: 'shared-packages', raw: sharedPackages },
	{ slug: 'package-skills', raw: packageSkills },
	{ slug: 'package-apps', raw: packageApps },
	{ slug: 'package-app-custom-domains', raw: packageAppCustomDomains },
	{ slug: 'package-subscriptions', raw: packageSubscriptions },
	{ slug: 'mcp-events', raw: mcpEvents },
	{ slug: 'wake-your-agent', raw: wakeYourAgent },
	{ slug: 'heavy-work-offload', raw: heavyWorkOffload },
	{ slug: 'integration-bootstrap', raw: integrationBootstrap },
	{ slug: 'oauth', raw: oauth },
	{ slug: 'google-oauth', raw: googleOauth },
	{ slug: 'secret-backed-integration', raw: secretBackedIntegration },
	{ slug: 'account-secret-setup', raw: accountSecretSetup },
	{ slug: 'openapi-integrations', raw: openapiIntegrations },
	{ slug: 'local-mcp-tunnels', raw: localMcpTunnels },
	{ slug: 'locked-mcp-server', raw: lockedMcpServer },
	{ slug: 'locked-gmail-drafts', raw: lockedGmailDrafts },
	{ slug: 'discord', raw: providerDiscord },
	{ slug: 'dropbox', raw: providerDropbox },
	{ slug: 'figma', raw: providerFigma },
	{ slug: 'github', raw: providerGithub },
	{ slug: 'google', raw: providerGoogle },
	{ slug: 'notion', raw: providerNotion },
	{ slug: 'origin', raw: providerOrigin },
	{ slug: 'salesforce', raw: providerSalesforce },
	{ slug: 'slack', raw: providerSlack },
	{ slug: 'spotify', raw: providerSpotify },
	{ slug: 'cant-open-or-get-mail', raw: cantOpenOrGetMail },
	{ slug: 'platform-friction', raw: platformFriction },
	{ slug: 'admin-events', raw: adminEvents },
]

function buildCatalog(): ReadonlyArray<Guide> {
	const parsed = guideSources.map(({ slug, raw }) =>
		parseGuideMarkdown(slug, raw),
	)
	const ids = new Set<string>()
	for (const guide of parsed) {
		if (ids.has(guide.id)) {
			throw new Error(`Duplicate guide id "${guide.id}".`)
		}
		ids.add(guide.id)
		if (isReservedDocsIndexSlug(guide.slug)) {
			throw new Error(
				`Guide slug "${guide.slug}" is reserved for a /docs index route.`,
			)
		}
	}
	// Authored bodies keep GitHub-relative links; the bundled copies rewrite
	// them so every serving surface gets resolvable targets.
	const knownSlugs = new Set(parsed.map((guide) => guide.slug))
	const rewritten = parsed.map((guide) => {
		const sourceDir: GuideSourceDir =
			guide.category === 'provider' ? 'docs/guides/providers' : 'docs/guides'
		return {
			...guide,
			body: rewriteRelativeGuideLinks({
				body: guide.body,
				sourceDir,
				knownSlugs,
			}),
		}
	})
	// `guideSources` above is already written in reading order, but sorting
	// through the shared `guide-order.ts` helper (rather than relying on that
	// literal array order) makes the order an explicit, enforced invariant
	// shared with the generated catalog modules — see guide-order.ts.
	return sortGuidesByAuthoredOrder(rewritten)
}

export const guides: ReadonlyArray<Guide> = buildCatalog()

const guidesBySlug = new Map(guides.map((guide) => [guide.slug, guide]))
const guidesById = new Map(guides.map((guide) => [guide.id, guide]))

export function getGuideBySlug(slug: string): Guide | null {
	return guidesBySlug.get(slug) ?? null
}

export function getGuideById(id: string): Guide | null {
	return guidesById.get(id) ?? null
}

/** The introduction article rendered at `/docs`. */
export function getIntroGuide(): Guide {
	const intro = guidesBySlug.get(docsIntroSlug)
	if (!intro) {
		throw new Error(`Missing introduction doc "${docsIntroSlug}".`)
	}
	return intro
}

type ListGuidesOptions = {
	/** When true, include admin-only docs. Default is public docs only. */
	includeAdmin?: boolean
}

function guideIsAdvertised(guide: Guide, includeAdmin: boolean): boolean {
	if (guide.unadvertised) return false
	if (guide.adminOnly && !includeAdmin) return false
	return true
}

/** Advertised platform docs in reading order. */
export function listPlatformGuides(
	options?: ListGuidesOptions,
): ReadonlyArray<Guide> {
	const includeAdmin = options?.includeAdmin === true
	return guides.filter(
		(guide) =>
			guideIsAdvertised(guide, includeAdmin) && guide.category === 'platform',
	)
}

/**
 * Advertised provider (connection) docs, alphabetically by provider name —
 * the order `/docs/connect` renders.
 */
export function listProviderGuides(): ReadonlyArray<Guide> {
	return guides
		.filter((guide) => !guide.unadvertised && guide.category === 'provider')
		.toSorted((a, b) => (a.provider ?? '').localeCompare(b.provider ?? ''))
}

/**
 * Every advertised doc in reading order (sidebar order: platform sections,
 * then providers, then help). Used by sitemap, `llms.txt`, and surfaces that
 * need every advertised doc. Admin-only docs stay out unless `includeAdmin`.
 */
export function listGuides(options?: ListGuidesOptions): ReadonlyArray<Guide> {
	const includeAdmin = options?.includeAdmin === true
	return guides.filter((guide) => guideIsAdvertised(guide, includeAdmin))
}

export type GuidesBySection = {
	section: DocsNavSection
	guides: ReadonlyArray<Guide>
}

/** Advertised docs grouped by docs-nav section, in reading order. */
export function listGuidesBySection(
	options?: ListGuidesOptions,
): ReadonlyArray<GuidesBySection> {
	const includeAdmin = options?.includeAdmin === true
	return visibleDocsNav(includeAdmin).map((section) => ({
		section,
		guides: section.items
			.map((item) => guidesBySlug.get(item.slug))
			.filter((guide): guide is Guide =>
				Boolean(guide && guideIsAdvertised(guide, includeAdmin)),
			),
	}))
}

/** Index / API summary shape (no markdown body). */
export type GuideSummary = {
	slug: string
	id: string
	title: string
	summary: string
	category: Guide['category']
	audience: Guide['audience']
	section: string | null
	provider: string | null
	lastVerified: string | null
}

export function toGuideSummary(guide: Guide): GuideSummary {
	const section = docsNav.find((candidate) =>
		candidate.items.some((item) => item.slug === guide.slug),
	)
	return {
		slug: guide.slug,
		id: guide.id,
		title: guide.title,
		summary: guide.summary,
		category: guide.category,
		audience: guide.audience,
		section: section?.id ?? null,
		provider: guide.provider,
		lastVerified: guide.lastVerified,
	}
}
