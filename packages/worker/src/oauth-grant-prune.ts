import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
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
 *
 * Age-by-`createdAt` is intentionally not used: refresh tokens do not expire,
 * so a grant minted months ago can still be actively refreshed. Pruning it on
 * a sibling authorize would recreate the concurrent-host failure this path
 * exists to prevent.
 */
export const mcpOAuthMaxGrantsPerUserClient = 10

export type OAuthGrantPruneReason = 'excess'

export type OAuthGrantPruneSelection = {
	id: string
	reason: OAuthGrantPruneReason
}

function grantCreatedAtSeconds(grant: OAuthGrantListItem) {
	return typeof grant.createdAt === 'number' ? grant.createdAt : 0
}

/**
 * Choose which grants to revoke for one user+client: if more than `maxGrants`
 * remain, drop the oldest excess. Newest grants win. Grants that share the
 * newest positive `createdAt` stay (same-second concurrent CIMD auths).
 * `keepGrantIds` are never revoked (for example the grant just minted by
 * `completeAuthorization`).
 */
export function selectOAuthGrantsToPrune(input: {
	grants: ReadonlyArray<OAuthGrantListItem>
	maxGrants?: number
	keepGrantIds?: ReadonlySet<string>
}): Array<OAuthGrantPruneSelection> {
	const maxGrants = input.maxGrants ?? mcpOAuthMaxGrantsPerUserClient
	const keepGrantIds = input.keepGrantIds ?? new Set<string>()

	const retained = input.grants
		.filter((grant) => grant.id && !keepGrantIds.has(grant.id))
		.slice()
		.sort(
			(left, right) =>
				grantCreatedAtSeconds(right) - grantCreatedAtSeconds(left),
		)

	if (retained.length <= maxGrants) return []

	const newestPositiveCreatedAt = retained.reduce((newest, grant) => {
		const createdAt = grantCreatedAtSeconds(grant)
		return createdAt > 0 && createdAt > newest ? createdAt : newest
	}, 0)
	const excessCandidates = retained.filter(
		(grant) => grantCreatedAtSeconds(grant) !== newestPositiveCreatedAt,
	)
	const protectedCount = retained.length - excessCandidates.length
	const olderToKeep = Math.max(0, maxGrants - protectedCount)
	// retained is newest-first; excessCandidates keeps that order, so the
	// oldest excess are at the end.
	return excessCandidates.slice(olderToKeep).map((grant) => ({
		id: grant.id,
		reason: 'excess' as const,
	}))
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
	maxGrants?: number
	keepGrantIds?: ReadonlySet<string>
}): Promise<{ revoked: number; excess: number }> {
	// Best-effort: authorize already minted the new grant. A list/revoke
	// failure must not turn the success redirect into handleAuthorizeRouteException.
	try {
		const grants = await listUserOAuthGrantsForClient(
			input.helpers,
			input.userId,
			input.clientId,
		)
		const selected = selectOAuthGrantsToPrune({
			grants,
			maxGrants: input.maxGrants,
			keepGrantIds: input.keepGrantIds,
		})
		if (selected.length === 0) {
			return { revoked: 0, excess: 0 }
		}

		let excess = 0
		try {
			for (const item of selected) {
				await revokeOAuthGrant(input.helpers, item.id, input.userId)
				excess += 1
			}
		} catch (error) {
			console.info(
				'oauth-grant-prune-failed',
				JSON.stringify({
					clientId: input.clientId,
					message: getErrorMessage(error),
					revoked: excess,
					excess,
				}),
			)
			await logAuditEvent({
				db: auditDatabaseFromEnv(input.env),
				category: 'oauth',
				action: 'connection_pruned',
				result: 'failure',
				email: input.email,
				ip: input.ip,
				clientId: input.clientId,
				reason:
					excess > 0
						? `prune_failed;revoked=${excess};excess=${excess}`
						: 'prune_failed',
			})
			return { revoked: excess, excess }
		}

		await logAuditEvent({
			db: auditDatabaseFromEnv(input.env),
			category: 'oauth',
			action: 'connection_pruned',
			result: 'success',
			email: input.email,
			ip: input.ip,
			clientId: input.clientId,
			reason: `revoked=${selected.length};excess=${excess}`,
		})

		return { revoked: selected.length, excess }
	} catch (error) {
		console.info(
			'oauth-grant-prune-failed',
			JSON.stringify({
				clientId: input.clientId,
				message: getErrorMessage(error),
			}),
		)
		await logAuditEvent({
			db: auditDatabaseFromEnv(input.env),
			category: 'oauth',
			action: 'connection_pruned',
			result: 'failure',
			email: input.email,
			ip: input.ip,
			clientId: input.clientId,
			reason: 'prune_failed',
		})
		return { revoked: 0, excess: 0 }
	}
}
