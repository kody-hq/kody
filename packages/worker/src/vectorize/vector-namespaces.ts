import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'

/**
 * Stable user ids are lowercase SHA-256 hex strings. This reserved value
 * contains non-hex characters, so it cannot collide with an account namespace.
 */
export const BUILTIN_VECTOR_NAMESPACE = '__kody_builtin__'

export function userVectorNamespace(userId: OwnerId): OwnerId {
	return userId
}
