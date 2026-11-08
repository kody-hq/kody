/**
 * Who may hand out, change, or take away the Owner and Admin roles. Admin has
 * Owner authority, but only an Owner may touch an Owner (change, demote,
 * remove, or promote to Owner). A Member who was granted `member:write` or
 * `member:delete` cannot reach either role.
 */
import type { OrgRole } from '@kody-internal/shared/request-context.ts'
import { hasOwnerAuthority } from '#worker/authorization/authorize.ts'

type RoleActor = { isOwner: boolean; isAdmin?: boolean }

/** Roles that hold a paid seat. */
export function isSeatRole(role: string) {
	return role === 'owner' || role === 'admin' || role === 'member'
}

/** Why `actor` may not move a member from `currentRole` to `nextRole`, or null. */
export function roleChangeDenial(input: {
	actor: RoleActor
	currentRole: string
	nextRole: OrgRole
}): string | null {
	const { actor, currentRole, nextRole } = input
	if ((currentRole === 'owner' || nextRole === 'owner') && !actor.isOwner) {
		return 'Only an Owner can change the Owner role.'
	}
	if (
		(currentRole === 'admin' || nextRole === 'admin') &&
		!hasOwnerAuthority(actor)
	) {
		return 'Only an Owner or Admin can change the Admin role.'
	}
	return null
}

/** Why `actor` may not remove a member who has `targetRole`, or null. */
export function removalDenial(input: {
	actor: RoleActor
	targetRole: string
}): string | null {
	if (input.targetRole === 'owner' && !input.actor.isOwner) {
		return 'Only an Owner can remove an Owner.'
	}
	if (input.targetRole === 'admin' && !hasOwnerAuthority(input.actor)) {
		return 'Only an Owner or Admin can remove an Admin.'
	}
	return null
}

/** Why `actor` may not invite (or revoke an invite) for `role`, or null. */
export function inviteRoleDenial(input: {
	actor: RoleActor
	role: string
}): string | null {
	if (input.role === 'owner' && !input.actor.isOwner) {
		return 'Only an Owner can invite another Owner.'
	}
	if (input.role === 'admin' && !hasOwnerAuthority(input.actor)) {
		return 'Only an Owner or Admin can invite an Admin.'
	}
	return null
}
