import { inviteState } from '#worker/orgs/invite-state.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

const revokeInviteGuard = inviteState.guard({ from: 'pending', to: 'revoked' })

/**
 * Removes what names a credential by id before the credential row goes:
 * org access grants (soft-deleted, as a revoke does), pending grant invites
 * (revoked), and personal-credential org grants. Run these first in the same
 * D1 batch as the delete; `credentialIdSql` selects the live row's id, so the
 * cleanup matches nothing when the delete matches nothing. Grants only ever
 * name a credential in the org that owns it, so `ownerId` is that org.
 */
export function credentialGrantCleanupStatements(
	db: D1Database,
	input: {
		ownerId: string
		credentialIdSql: string
		credentialIdBindings: ReadonlyArray<unknown>
	},
): Array<D1PreparedStatement> {
	const now = new Date().toISOString()
	const grantBindings = [input.ownerId, ...input.credentialIdBindings]
	return [
		db
			.prepare(
				`UPDATE orgs
				SET access_epoch = access_epoch + 1, updated_at = ?
				WHERE id = ?${andLiveDeletedAtSql()}
					AND EXISTS (
						SELECT 1 FROM grants
						WHERE org_id = ? AND resource_type = 'credential'
							AND resource_id IN (${input.credentialIdSql})${andLiveDeletedAtSql()}
					)`,
			)
			.bind(now, input.ownerId, ...grantBindings),
		db
			.prepare(
				`UPDATE grants SET deleted_at = ?, updated_at = ?
				WHERE org_id = ? AND resource_type = 'credential'
					AND resource_id IN (${input.credentialIdSql})${andLiveDeletedAtSql()}`,
			)
			.bind(now, now, ...grantBindings),
		db
			.prepare(
				`UPDATE invites SET status = 'revoked'
				WHERE org_id = ? AND kind = 'grant' AND resource_type = 'credential'
					AND status IN ${revokeInviteGuard} AND resource_id IN (${input.credentialIdSql})`,
			)
			.bind(input.ownerId, ...input.credentialIdBindings),
		db
			.prepare(
				`DELETE FROM credential_org_grants
				WHERE user_id = ? AND credential_id IN (${input.credentialIdSql})`,
			)
			.bind(input.ownerId, ...input.credentialIdBindings),
	]
}
