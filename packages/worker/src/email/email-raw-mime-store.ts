import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { emailRawMimeKey } from './blob-keys.ts'

export class RetryableInboundStorageError extends Error {
	override name = 'RetryableInboundStorageError'
	constructor(message: string, cause?: unknown) {
		super(message, { cause })
	}
}

export class EmailRawMimeStorageError extends RetryableInboundStorageError {
	override name = 'EmailRawMimeStorageError'
	constructor(messageId: string, cause?: unknown) {
		super(
			`Failed to store email raw MIME in EMAIL_BLOBS (message ${messageId}); delivery should be retried.`,
			cause,
		)
	}
}

export async function putEmailRawMime(input: {
	blobs: R2Bucket
	userId: OwnerId
	messageId: string
	rawMime: string
}) {
	const key = emailRawMimeKey(input.userId, input.messageId)
	try {
		await input.blobs.put(key, input.rawMime)
		return key
	} catch (error) {
		throw new EmailRawMimeStorageError(input.messageId, error)
	}
}
