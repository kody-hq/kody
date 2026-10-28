/**
 * Generation counters for request-scoped credential read caches (KODY-BF).
 * Writes that can change a usable set or mapping snapshot bump the matching
 * counter so the next open on the same request re-reads instead of serving a
 * pre-write snapshot. Counters are per `APP_DB` (per isolate), not cross-user.
 */

const usableCredentialsGeneration = new WeakMap<D1Database, number>()
const credentialMappingGeneration = new WeakMap<D1Database, number>()

/** Call after a write that can change which credentials an actor can Use. */
export function bumpUsableCredentialsGeneration(db: D1Database) {
	usableCredentialsGeneration.set(
		db,
		(usableCredentialsGeneration.get(db) ?? 0) + 1,
	)
}

export function usableCredentialsGenerationOf(db: D1Database) {
	return usableCredentialsGeneration.get(db) ?? 0
}

/** Call after a write that changes stored credential mappings. */
export function bumpCredentialMappingGeneration(db: D1Database) {
	credentialMappingGeneration.set(
		db,
		(credentialMappingGeneration.get(db) ?? 0) + 1,
	)
}

export function credentialMappingGenerationOf(db: D1Database) {
	return credentialMappingGeneration.get(db) ?? 0
}
