import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	type ConnectedMcpAgent,
	labelInboundMcpClient,
	oauthGrantCreatedAtIso,
} from '#universal/connected-mcp-agents.ts'
import { type UserMeterEnv } from '#worker/entitlements/user-meter-client.ts'
import {
	forgetInboundMcpConnectionLastUsed,
	listInboundMcpConnectionLastUsed,
} from '#worker/inbound-mcp-connection-last-used.ts'
import {
	listUserOAuthGrants,
	listUserOAuthGrantsForClient,
	revokeOAuthGrant,
	type OAuthClientInfo,
	type OAuthGrantHelpers,
	type OAuthGrantListHelpers,
	type OAuthGrantListItem,
} from '#worker/oauth-grants.ts'
import { grantMatchesConsentOrg } from '#worker/orgs/oauth-grant.ts'

export type ConnectedMcpAgentListItem = ConnectedMcpAgent & {
	grantIds: Array<string>
}

export type InboundMcpConnectionState = {
	uniqueClientCount: number
	agents: Array<ConnectedMcpAgentListItem>
	listingFailed?: boolean
}

/**
 * Grants live under the person who approved them. Each one is bound to the org
 * chosen on the approval screen; grants from before org stamping belong to the
 * person's signup org.
 */
function grantsBoundToOrg(
	grants: Array<OAuthGrantListItem>,
	userId: OwnerId,
	orgId: OwnerId | undefined,
) {
	if (!orgId) return grants
	return grants.filter((grant) =>
		grantMatchesConsentOrg({ metadata: grant.metadata, userId, orgId }),
	)
}

export async function loadInboundMcpConnectionState(
	helpers: OAuthGrantListHelpers | undefined,
	userId: OwnerId,
	options?: {
		env?: UserMeterEnv
		/** Only agents whose grants are bound to this org. */
		orgId?: OwnerId
	},
): Promise<InboundMcpConnectionState> {
	if (!helpers) {
		return { uniqueClientCount: 0, agents: [] }
	}
	try {
		const [grants, lastUsedByClientId] = await Promise.all([
			listUserOAuthGrants(helpers, userId).then((all) =>
				grantsBoundToOrg(all, userId, options?.orgId),
			),
			options?.env
				? listInboundMcpConnectionLastUsed({
						env: options.env,
						userId,
					}).catch(() => new Map<string, string>())
				: Promise.resolve(new Map<string, string>()),
		])
		return await labelInboundMcpGrants(helpers, grants, lastUsedByClientId)
	} catch {
		return { uniqueClientCount: 0, agents: [], listingFailed: true }
	}
}

/**
 * Revoke the person's grants for `clientId`. With `orgId`, only grants bound
 * to that org go; `clientRemains` reports grants the same client still holds
 * in other orgs, so per-client state is kept for them.
 */
export async function revokeConnectedMcpAgent(input: {
	helpers: OAuthGrantHelpers
	userId: OwnerId
	clientId: string
	orgId?: OwnerId
	env?: UserMeterEnv
}): Promise<
	| { revoked: number; clientRemains: boolean }
	| { error: 'not_found'; clientRemains: boolean }
> {
	const clientGrants = await listUserOAuthGrantsForClient(
		input.helpers,
		input.userId,
		input.clientId,
	)
	const grants = grantsBoundToOrg(clientGrants, input.userId, input.orgId)
	if (grants.length === 0) {
		return { error: 'not_found', clientRemains: clientGrants.length > 0 }
	}
	for (const grant of grants) {
		await revokeOAuthGrant(input.helpers, grant.id, input.userId)
	}
	const clientRemains = clientGrants.length > grants.length
	if (clientRemains) return { revoked: grants.length, clientRemains }
	if (input.env) {
		await forgetInboundMcpConnectionLastUsed({
			env: input.env,
			userId: input.userId,
			clientId: input.clientId,
		}).catch(() => undefined)
	}
	return { revoked: grants.length, clientRemains }
}

async function labelInboundMcpGrants(
	helpers: OAuthGrantListHelpers,
	grants: Array<OAuthGrantListItem>,
	lastUsedByClientId: ReadonlyMap<string, string>,
): Promise<InboundMcpConnectionState> {
	const byClient = new Map<string, Array<OAuthGrantListItem>>()
	for (const grant of grants) {
		if (!grant.clientId) continue
		const existing = byClient.get(grant.clientId)
		if (existing) existing.push(grant)
		else byClient.set(grant.clientId, [grant])
	}

	const clientCache = new Map<string, OAuthClientInfo | null>()
	const agents = new Array<ConnectedMcpAgentListItem>()
	for (const [clientId, clientGrants] of byClient) {
		const client = await lookupClientBestEffort(helpers, clientCache, clientId)
		const labeled = labelInboundMcpClient({
			clientId,
			clientName: client?.clientName,
			redirectUris: client?.redirectUris,
			clientUri: client?.clientUri,
			grantRedirectUri: firstGrantRedirectUri(clientGrants),
		})
		agents.push({
			clientId,
			grantIds: clientGrants.map((grant) => grant.id),
			label: labeled.label,
			kind: labeled.kind,
			connectedAt: earliestGrantCreatedAt(clientGrants),
			lastUsedAt: lastUsedByClientId.get(clientId) ?? null,
		})
	}

	agents.sort(compareConnectedAgents)
	return {
		uniqueClientCount: byClient.size,
		agents,
	}
}

async function lookupClientBestEffort(
	helpers: OAuthGrantListHelpers,
	cache: Map<string, OAuthClientInfo | null>,
	clientId: string,
): Promise<OAuthClientInfo | null> {
	if (cache.has(clientId)) return cache.get(clientId) ?? null
	if (!helpers.lookupClient) {
		cache.set(clientId, null)
		return null
	}
	try {
		const client = await helpers.lookupClient(clientId)
		cache.set(clientId, client)
		return client
	} catch {
		cache.set(clientId, null)
		return null
	}
}

function firstGrantRedirectUri(grants: Array<OAuthGrantListItem>) {
	for (const grant of grants) {
		if (grant.redirectUri) return grant.redirectUri
	}
	return undefined
}

function earliestGrantCreatedAt(grants: Array<OAuthGrantListItem>) {
	let earliest: number | undefined
	for (const grant of grants) {
		if (typeof grant.createdAt !== 'number') continue
		if (earliest === undefined || grant.createdAt < earliest) {
			earliest = grant.createdAt
		}
	}
	return oauthGrantCreatedAtIso(earliest)
}

function compareConnectedAgents(
	left: ConnectedMcpAgentListItem,
	right: ConnectedMcpAgentListItem,
) {
	const leftUsed = left.lastUsedAt ?? ''
	const rightUsed = right.lastUsedAt ?? ''
	if (leftUsed !== rightUsed) return rightUsed.localeCompare(leftUsed)
	const leftAt = left.connectedAt ?? ''
	const rightAt = right.connectedAt ?? ''
	if (leftAt !== rightAt) return rightAt.localeCompare(leftAt)
	return left.label.localeCompare(right.label)
}
