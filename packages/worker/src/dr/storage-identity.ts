import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'

/**
 * Platform DR dumps address StorageRunner durable objects by a composite id
 * `userId/storageId`. Stable user ids are hex digests (no `/`); logical
 * storage ids may contain `:` but not unescaped `/`.
 */
export function encodeStorageIdentity(userId: string, storageId: string) {
	return `${userId}/${storageId}`
}

export function decodeStorageIdentity(identity: string): {
	userId: OwnerId
	storageId: string
} {
	const separator = identity.indexOf('/')
	if (separator <= 0 || separator === identity.length - 1) {
		throw new Error(`invalid storage identity: ${identity}`)
	}
	return {
		userId: identity.slice(0, separator) as OwnerId,
		storageId: identity.slice(separator + 1),
	}
}
