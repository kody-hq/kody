import {
	ownerIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'

/**
 * Inbound delivery effects (usage + `email.message.received` subscription
 * dispatch) ride the package events dispatch Queue so they run in their own
 * consumer invocation with a full CPU budget. Running them inside the
 * `email()` handler's `waitUntil` shares the Email Routing invocation budget:
 * a package handler that runs for a few seconds of CPU killed the whole
 * invocation and left the effect to the five-minute reconciliation sweep.
 */
export const inboundDeliveryEffectsQueueMessageKind = 'inbound-delivery-effects'

export type InboundDeliveryEffectsQueueMessage = {
	kind: typeof inboundDeliveryEffectsQueueMessageKind
	userId: OwnerId
	deliveryId: string
	expectedFinalizationToken?: string
	durationMs?: number
}

export function buildInboundDeliveryEffectsQueueMessage(input: {
	userId: OwnerId
	deliveryId: string
	expectedFinalizationToken?: string
	durationMs?: number
}): InboundDeliveryEffectsQueueMessage {
	return {
		kind: inboundDeliveryEffectsQueueMessageKind,
		userId: input.userId,
		deliveryId: input.deliveryId,
		...(input.expectedFinalizationToken != null
			? { expectedFinalizationToken: input.expectedFinalizationToken }
			: {}),
		...(input.durationMs != null ? { durationMs: input.durationMs } : {}),
	}
}

export function isInboundDeliveryEffectsQueueBody(body: unknown) {
	return (
		!!body &&
		typeof body === 'object' &&
		!Array.isArray(body) &&
		(body as Record<string, unknown>)['kind'] ===
			inboundDeliveryEffectsQueueMessageKind
	)
}

export function parseInboundDeliveryEffectsQueueMessage(
	body: unknown,
): InboundDeliveryEffectsQueueMessage | null {
	if (!isInboundDeliveryEffectsQueueBody(body)) return null
	const record = body as Record<string, unknown>
	const userId = record['userId']
	const deliveryId = record['deliveryId']
	const expectedFinalizationToken = record['expectedFinalizationToken']
	const durationMs = record['durationMs']
	if (
		typeof userId !== 'string' ||
		!userId.trim() ||
		typeof deliveryId !== 'string' ||
		!deliveryId.trim() ||
		(expectedFinalizationToken !== undefined &&
			typeof expectedFinalizationToken !== 'string') ||
		(durationMs !== undefined &&
			(typeof durationMs !== 'number' || !Number.isFinite(durationMs)))
	) {
		return null
	}
	return buildInboundDeliveryEffectsQueueMessage({
		userId: ownerIdFromStored(userId),
		deliveryId,
		expectedFinalizationToken,
		durationMs,
	})
}
