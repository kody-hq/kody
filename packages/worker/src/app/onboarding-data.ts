import {
	buildDiscoveryPrompt,
	buildFirstWinPrompt,
	buildMcpServerUrl,
	buildOnboardingSetupPrompt,
	buildPersistFirstPackagePrompt,
} from '#worker/onboarding-prompts.ts'
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type OnboardingFeaturedListing } from '#universal/community-public-types.ts'
import { listDisconnectedOnboardingFeaturedMcpServers } from '#universal/onboarding-mcp-chooser.ts'
import { type ConnectedMcpAgent } from '#universal/connected-mcp-agents.ts'
import { type PlatformIntegrationCatalogItem } from '#universal/oauth-connect.ts'
import { hasSecondConnectedMcpClient } from '#universal/onboarding-agent-ecosystems.ts'
import {
	type OnboardingChecklistLoaderData,
	type OnboardingCustomMcpServer,
	type OnboardingFeaturedMcpServer,
	type OnboardingLoaderData,
} from '#universal/loader-data.ts'
import { describeSecondAgentStandardGift } from '#universal/second-agent-standard-gift.ts'
import { loadInboundMcpConnectionState } from '#worker/connected-mcp-agents.ts'
import { loadSecondAgentStandardGift } from '#worker/entitlements/second-agent-standard-gift.ts'
import { type OAuthGrantListHelpers } from '#worker/oauth-grants.ts'
export {
	buildDiscoveryPrompt,
	buildFirstWinPrompt,
	buildMcpServerUrl,
	buildOnboardingSetupPrompt,
	buildPersistFirstPackagePrompt,
}

type OnboardingEnv = {
	APP_BASE_URL?: string | null
	APP_DB?: D1Database
	OAUTH_PROVIDER?: OAuthGrantListHelpers
}

/**
 * Unique inbound MCP OAuth clients. Two grants for the same `clientId`
 * count as one host. Listing failures treat the user as still needing
 * onboarding so the banner stays available.
 */
export async function countUniqueMcpOAuthClients(
	env: OnboardingEnv,
	stableUserId: OwnerId,
) {
	const state = await loadInboundMcpConnectionState(
		env.OAUTH_PROVIDER,
		stableUserId,
	)
	return state.uniqueClientCount
}

/** Unique inbound MCP OAuth clients. Same as `countUniqueMcpOAuthClients`. */
export async function countMcpOAuthGrants(
	env: OnboardingEnv,
	stableUserId: OwnerId,
) {
	return countUniqueMcpOAuthClients(env, stableUserId)
}

/**
 * True when the user has at least one inbound MCP OAuth grant (an AI host
 * authorized against this account).
 */
export async function userHasMcpOAuthGrants(
	env: OnboardingEnv,
	stableUserId: OwnerId,
) {
	return (await countMcpOAuthGrants(env, stableUserId)) > 0
}

export function loadPublicOnboardingData(input: {
	env: Pick<OnboardingEnv, 'APP_BASE_URL'>
	requestUrl: string | URL
}): OnboardingLoaderData {
	return {
		ok: true,
		loggedIn: false,
		username: null,
		mcpServerUrl: buildMcpServerUrl({
			env: input.env,
			requestUrl: input.requestUrl,
		}),
		setupPrompt: buildOnboardingSetupPrompt(),
		discoveryPrompt: buildDiscoveryPrompt({
			env: input.env,
			requestUrl: input.requestUrl,
		}),
		persistPrompt: buildPersistFirstPackagePrompt({
			env: input.env,
			requestUrl: input.requestUrl,
		}),
		hasAccessWin: false,
		hasSecondMcpClient: false,
		hasMcpClient: false,
		connectedAgents: [],
		secondAgentStandardGift: describeSecondAgentStandardGift({}),
		emailVerified: false,
		needsOnboarding: true,
		featuredListings: [],
		featuredMcpServers: listDisconnectedOnboardingFeaturedMcpServers(),
		customMcpServers: [],
		persistedPackageName: null,
		accessWinMemorySubject: null,
		checklist: null,
	}
}

/**
 * Homepage SSR only needs login, email verification, and the discovery
 * prompt. Listing inbound MCP grants (and labeling each client) is for
 * `/onboarding`, not `/`.
 */
export function loadHomePageOnboardingData(input: {
	env: Pick<OnboardingEnv, 'APP_BASE_URL'>
	requestUrl: string | URL
	user?: { username: string; emailVerified: boolean } | null
}): OnboardingLoaderData {
	const publicData = loadPublicOnboardingData({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	if (!input.user) {
		return {
			...publicData,
			featuredMcpServers: [],
			setupPrompt: '',
			persistPrompt: '',
		}
	}
	return {
		...publicData,
		loggedIn: true,
		username: input.user.username,
		emailVerified: input.user.emailVerified,
		needsOnboarding: !input.user.emailVerified,
		featuredMcpServers: [],
		setupPrompt: '',
		persistPrompt: '',
	}
}

export async function loadOnboardingData(input: {
	env: OnboardingEnv
	requestUrl: string | URL
	personId: OwnerId
	username: string
	emailVerified: boolean
	/**
	 * Featured starter packages loaded by the handler (which has the full
	 * worker Env); this module stays narrow so it is trivially testable.
	 */
	featuredListings?: Array<OnboardingFeaturedListing>
	/** Official workspace MCP chooser cards, loaded by the handler. */
	featuredMcpServers?: Array<OnboardingFeaturedMcpServer>
	/** Non-featured MCP servers the viewer added, loaded by the handler. */
	customMcpServers?: Array<OnboardingCustomMcpServer>
	/** Published built-ins from the onboarding allowlist, loaded by the handler. */
	featuredPlatformIntegrations?: Array<PlatformIntegrationCatalogItem>
	/** Contextual persist prompt, computed by the handler. */
	persistContext?: {
		connectedWorkspaceLabel?: string | null
		installedExampleName?: string | null
	}
	/** Most recently updated saved-package user-facing name, loaded by the handler. */
	persistedPackageName?: string | null
	/** Most recently updated active memory subject, loaded by the handler. */
	accessWinMemorySubject?: string | null
	/** Derived progress checklist, computed by the handler. */
	checklist?: OnboardingChecklistLoaderData | null
	/** First search, memory, execute, or saved package — a Step 2 win. */
	hasAccessWin?: boolean
}): Promise<OnboardingLoaderData> {
	const inbound = await loadInboundMcpConnectionState(
		input.env.OAUTH_PROVIDER,
		input.personId,
	)
	const connectedAgents = toOnboardingConnectedAgents(inbound.agents)
	const secondAgentStandardGift =
		typeof input.env.APP_DB?.prepare === 'function'
			? await loadSecondAgentStandardGift(
					input.env.APP_DB,
					input.personId,
				).catch((error: unknown) => {
					console.warn('second-agent-standard-gift-read-failed', error)
					return describeSecondAgentStandardGift({})
				})
			: describeSecondAgentStandardGift({})
	const hasMcpClient = inbound.uniqueClientCount > 0
	// Known ecosystems, not raw grant count and not clientId count. Two
	// Cursor auth contexts are one ecosystem.
	const hasSecondMcpClient = hasSecondConnectedMcpClient(connectedAgents)
	// Incomplete setup means either the account email is still unverified or no
	// MCP host has authorized yet. An unverified account with a leftover grant
	// still needs onboarding until verification is finished.
	const needsOnboarding = !input.emailVerified || !hasMcpClient
	// Keep MCP URL/setup out of unverified responses so SSR and JSON clients
	// cannot push users into the authorize → 403 loop before verification.
	const mcpServerUrl = input.emailVerified
		? buildMcpServerUrl({
				env: input.env,
				requestUrl: input.requestUrl,
			})
		: ''
	const setupPrompt = input.emailVerified ? buildOnboardingSetupPrompt() : ''
	return {
		ok: true,
		loggedIn: true,
		username: input.username,
		mcpServerUrl,
		setupPrompt,
		// The discovery prompt needs no MCP connection or verified email, so it
		// stays available even while setup fields are gated.
		discoveryPrompt: buildDiscoveryPrompt({
			env: input.env,
			requestUrl: input.requestUrl,
		}),
		persistPrompt: input.emailVerified
			? buildPersistFirstPackagePrompt({
					env: input.env,
					requestUrl: input.requestUrl,
					connectedWorkspaceLabel:
						input.persistContext?.connectedWorkspaceLabel,
					installedExampleName: input.persistContext?.installedExampleName,
				})
			: '',
		hasAccessWin: input.hasAccessWin ?? false,
		hasSecondMcpClient,
		hasMcpClient,
		connectedAgents,
		secondAgentStandardGift,
		emailVerified: input.emailVerified,
		needsOnboarding,
		featuredListings: input.emailVerified ? (input.featuredListings ?? []) : [],
		featuredMcpServers: input.emailVerified
			? (input.featuredMcpServers ??
				listDisconnectedOnboardingFeaturedMcpServers())
			: [],
		customMcpServers: input.emailVerified ? (input.customMcpServers ?? []) : [],
		featuredPlatformIntegrations: input.emailVerified
			? (input.featuredPlatformIntegrations ?? [])
			: [],
		persistedPackageName: input.emailVerified
			? (input.persistedPackageName ?? null)
			: null,
		accessWinMemorySubject: input.emailVerified
			? (input.accessWinMemorySubject ?? null)
			: null,
		checklist: input.checklist ?? null,
	}
}

function toOnboardingConnectedAgents(
	agents: Array<ConnectedMcpAgent & { grantIds?: Array<string> }>,
): Array<ConnectedMcpAgent> {
	return agents.map((agent) => ({
		clientId: agent.clientId,
		label: agent.label,
		kind: agent.kind,
		connectedAt: agent.connectedAt,
		lastUsedAt: agent.lastUsedAt ?? null,
	}))
}
