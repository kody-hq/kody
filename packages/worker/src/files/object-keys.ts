import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
export function fileBlobPrefix(ownerId: OwnerId, fileId?: string) {
	return `files:v1/${ownerId}/${fileId ? `${fileId}/` : ''}`
}
export function fileBlobKey(
	ownerId: OwnerId,
	fileId: string,
	revisionId: string,
) {
	return `${fileBlobPrefix(ownerId, fileId)}${revisionId}`
}
