import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'

/**
 * R2 object key for a message's raw MIME payload in the EMAIL_BLOBS
 * bucket. The userId prefix is part of the per-user isolation contract:
 * account deletion enumerates and deletes a user's blobs by these stored
 * keys, and the key can never be forged to point at another user's mail.
 * Writers always store this canonical key in `raw_mime_key`.
 */
export function emailRawMimeKey(userId: OwnerId, messageId: string) {
	return `email-raw:v1:${userId}/${messageId}`
}

/**
 * R2 object key for an attachment stored on its own (storage_kind
 * 'external'), used by outbound mail whose bytes never exist as raw MIME.
 * The userId prefix follows the same per-user isolation contract as
 * emailRawMimeKey.
 */
export function emailAttachmentBlobKey(
	userId: OwnerId,
	messageId: string,
	attachmentId: string,
) {
	return `email-attachment:v1:${userId}/${messageId}/${attachmentId}`
}
