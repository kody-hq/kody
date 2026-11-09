import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import {
	loadAdminUserByTarget,
	type AdminUserTarget,
} from '#worker/admin/users-data.ts'
import { listInboundMcpConnectionLastUsed } from '#worker/inbound-mcp-connection-last-used.ts'
import { resolveOAuthHelpers } from '#worker/oauth-helpers.ts'
import {
	listUserOAuthGrants,
	type OAuthGrantListHelpers,
	type OAuthGrantListItem,
} from '#worker/oauth-grants.ts'
import { oauthGrantCreatedAtIso } from '#universal/connected-mcp-agents.ts'
import { readOrgIdFromGrantMetadata } from '#worker/orgs/oauth-grant.ts'

export type AdminUserOauthGrant = {
	grantId: string
	clientId: string
	/** Org id stamped on the grant (metadata.orgId), or personal-org fallback. */
	boundOrgId: string | null
	createdAt: string | null
	lastUsedAt: string | null
	scope: Array<string>
}

export type AdminUserOauthGrantsResult = {
	stableUserId: string
	username: string
	email: string
	grants: Array<AdminUserOauthGrant>
	listingFailed: boolean
}

/**
 * List one person's MCP OAuth grants with the org each grant is bound to.
 * Bound org is the stamped `metadata.orgId`. Last-used is per client id from
 * UserMeter when available.
 */
export async function loadAdminUserOauthGrants(input: {
	env: Env
	target: AdminUserTarget
}): Promise<AdminUserOauthGrantsResult | null> {
	const user = await loadAdminUserByTarget(input.env.APP_DB, input.target)
	if (!user) return null
	// AdminUser.stableUserId is branded OwnerId (personal org). The person id
	// is the same string; last-used lives on the personal-org owner key.
	const stableUserId = personIdFromStored(user.stableUserId as string)
	const meterOwnerId = user.stableUserId
	const helpers = await resolveOAuthHelpers<OAuthGrantListHelpers>(input.env)
	if (!helpers) {
		return {
			stableUserId,
			username: user.username,
			email: user.email,
			grants: [],
			listingFailed: true,
		}
	}

	try {
		const [grants, lastUsedByClientId] = await Promise.all([
			listUserOAuthGrants(helpers, stableUserId),
			listInboundMcpConnectionLastUsed({
				env: input.env,
				userId: meterOwnerId,
			}).catch(() => new Map<string, string>()),
		])
		return {
			stableUserId,
			username: user.username,
			email: user.email,
			grants: grants.map((grant) => toAdminGrant(grant, lastUsedByClientId)),
			listingFailed: false,
		}
	} catch {
		return {
			stableUserId,
			username: user.username,
			email: user.email,
			grants: [],
			listingFailed: true,
		}
	}
}

function toAdminGrant(
	grant: OAuthGrantListItem,
	lastUsedByClientId: ReadonlyMap<string, string>,
): AdminUserOauthGrant {
	return {
		grantId: grant.id,
		clientId: grant.clientId,
		boundOrgId: readOrgIdFromGrantMetadata(grant.metadata),
		createdAt: oauthGrantCreatedAtIso(grant.createdAt),
		lastUsedAt: grant.clientId
			? (lastUsedByClientId.get(grant.clientId) ?? null)
			: null,
		scope: grant.scope,
	}
}
