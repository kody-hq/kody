import type { McpUserContext } from '@kody-internal/shared/chat.ts'
import type {
	OwnerId,
	PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { getMcpUserPackageScope } from './user-scope.ts'

/**
 * The acting-user / owning-org pair for a package operation.
 *
 * `ownerUserId` (an `OwnerId`) is the only id that may be used for
 * storage: `saved_packages.user_id`, `entity_sources.user_id`, Vectorize
 * metadata, repo-session RPC ownership, entitlements, and community listing
 * ownership. `actorUserId` (a `PersonId`) is the signed-in caller and is used
 * for audit and attribution only.
 */
export type PackageOwnerContext = {
	ownerUserId: OwnerId
	ownerScope: string
	ownerEmail: string
	actorUserId: PersonId
	/** Actor's personal org id (stamped when available). */
	actorPersonalOrgId: OwnerId
}

/**
 * Resolve the package owner for a capability call: the org the request is
 * bound to. Members author an org's packages through a connection bound to
 * that org; there is no per-call scope override.
 */
export async function resolvePackageOwnerContext(
	env: Pick<Env, 'APP_DB'>,
	input: { user: McpUserContext; request: RequestContext },
): Promise<PackageOwnerContext> {
	const { user, request } = input
	const actorPersonalOrgId = personalOrgIdForPerson(user)
	const isPersonalOrg = request.org.id === actorPersonalOrgId
	// A personal org's package scope is the (permanent) username.
	const ownerScope = isPersonalOrg
		? await getMcpUserPackageScope(env.APP_DB, user)
		: request.org.slug
	if (!ownerScope) {
		throw new Error(
			`Org ${request.org.id} has no slug, so it has no package scope.`,
		)
	}
	return {
		ownerUserId: request.org.id,
		ownerScope,
		ownerEmail: user.email,
		actorUserId: user.userId,
		actorPersonalOrgId,
	}
}

/**
 * Email to pass into plan / entitlement lookups for this owner.
 *
 * Personal orgs keep the actor email so a mismatched caller context cannot
 * inherit another account's plan (`getUserEntitlement` requires email +
 * stable id). Team orgs have no `users` row at `ownerUserId`, so the same
 * pair always misses and falls through to public free — pass a blank email
 * so lookup reverse-resolves the org plan by OwnerId, matching background
 * job paths.
 */
export function packageOwnerEntitlementEmail(
	owner: PackageOwnerContext,
): string | null {
	if (owner.ownerUserId === owner.actorPersonalOrgId) {
		return owner.ownerEmail
	}
	return null
}
