import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { emailRawMimeKey } from './blob-keys.ts'
import type { MailboxInboundDeliveryInsertInput } from './mailbox-inbound-ledger.ts'

export function insertInput(
	ownerId: OwnerId,
	overrides?: Partial<MailboxInboundDeliveryInsertInput>,
): MailboxInboundDeliveryInsertInput {
	const deliveryId =
		overrides?.deliveryId ?? `email-inbound-delivery:${crypto.randomUUID()}`
	const messageId =
		overrides?.messageId ?? `email-inbound-message:${crypto.randomUUID()}`
	const fingerprint =
		overrides?.fingerprint ?? crypto.randomUUID().replace(/-/g, '')
	return {
		fingerprint,
		deliveryId,
		messageId,
		threadId:
			overrides?.threadId ?? `email-inbound-thread:${crypto.randomUUID()}`,
		rawMimeKey: overrides?.rawMimeKey ?? emailRawMimeKey(ownerId, messageId),
		inboxId: overrides?.inboxId ?? `inbox-${crypto.randomUUID()}`,
		recipient: overrides?.recipient ?? 'owner@example.com',
		envelopeFrom: overrides?.envelopeFrom ?? 'sender@example.com',
		quotaDay: overrides?.quotaDay ?? '2026-07-22',
		dedupeExpiresAt: overrides?.dedupeExpiresAt ?? '2026-07-24T00:00:00.000Z',
		usageStartedAt: overrides?.usageStartedAt,
		provider: overrides?.provider,
	}
}
