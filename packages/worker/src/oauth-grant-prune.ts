import { auditDatabaseFromEnv, logAuditEvent } from '#worker/audit-log.ts'
import {
	listUserOAuthGrantsForClient,
	revokeOAuthGrant,
	type OAuthGrantHelpers,
	type OAuthGrantListItem,
} from '#worker/oauth-grants.ts'

/**
 * Concurrent MCP hosts that share one OAuth client_id (CIMD surfaces such as
 * ChatGPT and the Codex app) each need their own grant. The provider's
 * `completeAuthorization` default (`revokeExistingGrants: true`) deletes every
 * older grant for the same user+client, so reconnecting one surface 401s the
 * other. Kody keeps concurrent grants and bounds buildup here instead.
 */
export const mcpOAuthMaxGrantsPerUserClient = 10

/** Grants older than this (by `createdAt`) are pruned as unused. */
export const mcpOAuthGrantMaxAgeSeconds = 90 * 24 * 60 * 60

export type OAuthGrantPruneReason = 'stale' | 'excess'

export type OAuthGrantPruneSelection = {
	id: string
	reason: OAuthGrantPruneReason
}

function grantCreatedAtSeconds(grant: OAuthGrantListItem) {
	return typeof grant.createdAt === 'number' ? grant.createdAt : 0
}

/**
 * Choose which grants to revoke for one user+client: drop grants older than
 * `maxAgeSeconds`, then if more than `maxGrants` remain, drop the oldest
 * excess. Newest grants win. `keepGrantIds` are never revoked (for example the
 * grant just minted by `completeAuthorization`).
 */
export function selectOAuthGrantsToPrune(input: {
	grants: ReadonlyArray<OAuthGrantListItem>
	nowSeconds: number
	maxGrants?: number
	maxAgeSeconds?: number
	keepGrantIds?: ReadonlySet<string>
}): Array<OAuthGrantPruneSelection> {
	const maxGrants = input.maxGrants ?? mcpOAuthMaxGrantsPerUserClient
	const maxAgeSeconds = input.maxAgeSeconds ?? mcpOAuthGrantMaxAgeSeconds
	const keepGrantIds = input.keepGrantIds ?? new Set<string>()

	const candidates = input.grants
		.filter((grant) => grant.id && !keepGrantIds.has(grant.id))
		.slice()
		.sort(
			(left, right) =>
				grantCreatedAtSeconds(right) - grantCreatedAtSeconds(left),
		)

	const toRevoke: Array<OAuthGrantPruneSelection> = []
	const retained: Array<OAuthGrantListItem> = []

	for (const grant of candidates) {
		const createdAt = grantCreatedAtSeconds(grant)
		const ageSeconds = input.nowSeconds - createdAt
		if (createdAt > 0 && ageSeconds > maxAgeSeconds) {
			toRevoke.push({ id: grant.id, reason: 'stale' })
			continue
		}
		retained.push(grant)
	}

	if (retained.length > maxGrants) {
		for (const grant of retained.slice(maxGrants)) {
			toRevoke.push({ id: grant.id, reason: 'excess' })
		}
	}

	return toRevoke
}

/**
 * Bound grant buildup for one user+client after a successful authorization.
 * Revoking a grant deletes its tokens via the provider helpers. Audits when
 * anything is pruned (`connection_pruned`); never logs tokens or secrets.
 */
export async function pruneUserClientOAuthGrants(input: {
	helpers: OAuthGrantHelpers
	userId: string
	clientId: string
	env: {
		AUDIT_DB?: D1Database
		SENTRY_ENVIRONMENT?: string
	}
	email?: string
	ip?: string
	nowSeconds?: number
	maxGrants?: number
	maxAgeSeconds?: number
	keepGrantIds?: ReadonlySet<string>
}): Promise<{ revoked: number; stale: number; excess: number }> {
	const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000)
	const grants = await listUserOAuthGrantsForClient(
		input.helpers,
		input.userId,
		input.clientId,
	)
	const selected = selectOAuthGrantsToPrune({
		grants,
		nowSeconds,
		maxGrants: input.maxGrants,
		maxAgeSeconds: input.maxAgeSeconds,
		keepGrantIds: input.keepGrantIds,
	})
	if (selected.length === 0) {
		return { revoked: 0, stale: 0, excess: 0 }
	}

	let stale = 0
	let excess = 0
	for (const item of selected) {
		await revokeOAuthGrant(input.helpers, item.id, input.userId)
		if (item.reason === 'stale') stale += 1
		else excess += 1
	}

	void logAuditEvent({
		db: auditDatabaseFromEnv(input.env),
		category: 'oauth',
		action: 'connection_pruned',
		result: 'success',
		email: input.email,
		ip: input.ip,
		clientId: input.clientId,
		reason: `revoked=${selected.length};stale=${stale};excess=${excess}`,
	})

	return { revoked: selected.length, stale, excess }
}
