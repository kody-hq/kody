/**
 * Distinct inbound MCP OAuth clientIds. Delegates to the official
 * Connected-agents helper (`loadInboundMcpConnectionState`) so campaign
 * state and Step 3 / account lists share one unique-`clientId` rule.
 */

import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { loadInboundMcpConnectionState } from '#worker/connected-mcp-agents.ts'
import type { OAuthGrantListHelpers } from '#worker/oauth-grants.ts'

export async function countDistinctInboundClientIds(
	helpers: OAuthGrantListHelpers | undefined,
	userId: OwnerId,
): Promise<{ uniqueClientCount: number; listingFailed: boolean }> {
	const state = await loadInboundMcpConnectionState(helpers, userId)
	return {
		uniqueClientCount: state.uniqueClientCount,
		listingFailed: state.listingFailed === true,
	}
}
