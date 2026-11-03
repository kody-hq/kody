import type {
	OwnerId,
	PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { personalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'

/**
 * Storage and usage billing key for a caller.
 *
 * Org-owned rows, Durable Object names, secret AAD, Vectorize metadata, and
 * usage rollups use this id. It is `request.org.id` when the request has an
 * org, and the acting person's personal org otherwise (legacy wire callers
 * without `request`). Prefer a stamped `user.personalOrgId` when present so
 * distinct signup org ids stay correct. Do not add another resolver:
 * background identity still goes through `resolveBackgroundMcpUser`. Does not
 * trim: a missing caller is still the empty string callers treat as absent.
 */
export function ownerIdFromCaller(caller: {
	request?: { org: { id: OwnerId } } | null
	user?: { userId: PersonId; personalOrgId?: OwnerId | null } | null
}): OwnerId {
	if (caller.request) return caller.request.org.id
	if (caller.user) return personalOrgIdForPerson(caller.user)
	return '' as OwnerId
}

/**
 * Email to pair with `ownerId` for entitlement lookup. Plan resolution
 * requires email and stable id to name one users row, so a team member's
 * email against the team org id would resolve Free. Only the caller's
 * personal org gets the email; other orgs resolve by id.
 */
export function entitlementEmailForOwner(
	caller: {
		user?: {
			userId: PersonId
			email: string
			personalOrgId?: OwnerId | null
		} | null
	},
	ownerId: OwnerId,
): string | null {
	if (!caller.user) return null
	return ownerId === personalOrgIdForPerson(caller.user)
		? caller.user.email
		: null
}
