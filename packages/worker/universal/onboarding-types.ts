import { type ConnectedMcpAgent } from '#universal/connected-mcp-agents.ts'
import { type SecondAgentStandardGiftState } from '#universal/second-agent-standard-gift.ts'
import { type OnboardingFeaturedListing } from '#universal/community-public-types.ts'
import {
	type OnboardingChecklistLoaderData,
	type OnboardingCustomMcpServer,
	type OnboardingFeaturedMcpServer,
} from '#universal/loader-data.ts'
import { type HighlightedCode } from '#universal/highlighted-code.ts'
import { type PlatformIntegrationCatalogItem } from '#universal/oauth-connect.ts'

/**
 * Shared onboarding status payload used by page data and the native route.
 */
export type OnboardingPayload = {
	ok: true
	loggedIn: boolean
	username: string | null
	mcpServerUrl: string
	mcpHighlights?: Record<string, HighlightedCode>
	setupPrompt: string
	discoveryPrompt: string
	persistPrompt: string
	hasAccessWin: boolean
	hasSecondMcpClient: boolean
	hasMcpClient: boolean
	connectedAgents: Array<ConnectedMcpAgent>
	secondAgentStandardGift: SecondAgentStandardGiftState
	emailVerified: boolean
	needsOnboarding: boolean
	featuredListings: Array<OnboardingFeaturedListing>
	featuredMcpServers: Array<OnboardingFeaturedMcpServer>
	customMcpServers: Array<OnboardingCustomMcpServer>
	featuredPlatformIntegrations?: Array<PlatformIntegrationCatalogItem>
	/**
	 * Most recently updated saved-package user-facing name (`@scope/kody-id`)
	 * after persist. Null when logged out, unverified, or the listing fails
	 * open.
	 */
	persistedPackageName: string | null
	/**
	 * Most recently updated active memory subject from a Step 2 access win.
	 * Null when logged out, unverified, none exist, or the listing fails open.
	 */
	accessWinMemorySubject: string | null
	checklist: OnboardingChecklistLoaderData | null
}
