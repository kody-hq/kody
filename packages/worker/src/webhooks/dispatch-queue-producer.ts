import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { WebhookExportParams } from './types.ts'

// Cloudflare Queues caps a message (body + metadata) at 128,000 bytes. Keep
// enough headroom for transport metadata and structured-clone framing.
export const webhookDispatchQueueMessageMaxBytes = 120_000

export const webhookDispatchPayloadKvPrefix = 'webhook-dispatch-payload:v1:'

/** Covers queue retries plus sandbox budget, with headroom for backlog. */
export const webhookDispatchPayloadTtlSeconds = 24 * 60 * 60

export type WebhookDispatchQueueMessage = {
	endpoint: {
		id: string
		userId: OwnerId
		packageId: string
		webhookName: string
	}
	packageKodyId: string
	exportName: string
	params: WebhookExportParams
	inputMode?: 'params'
	idempotencyKey: string
	idempotencyParamsHash?: 'ignore'
	/** Request-mode caller Idempotency-Key: hash the JSON body, not the envelope. */
	callerIdempotency?: true
	deliveryId: string
	payloadBytes: number
	receivedAt: string
	payloadKvKey?: string
}

export function webhookDispatchPayloadKvKey(
	userId: string,
	deliveryId: string,
) {
	return `${webhookDispatchPayloadKvPrefix}${userId}:${deliveryId}`
}

export function createWebhookDispatchQueueMessage(input: {
	endpoint: WebhookDispatchQueueMessage['endpoint']
	packageKodyId: string
	exportName: string
	params: WebhookExportParams
	inputMode?: 'params'
	idempotencyKey: string
	idempotencyParamsHash?: 'ignore'
	callerIdempotency?: true
	deliveryId: string
	payloadBytes: number
	receivedAt: string
}): WebhookDispatchQueueMessage {
	return {
		endpoint: input.endpoint,
		packageKodyId: input.packageKodyId,
		exportName: input.exportName,
		params: {
			webhook: input.params.webhook,
			request: {
				...input.params.request,
				json: null,
			},
		},
		...(input.inputMode === 'params' ? { inputMode: 'params' as const } : {}),
		idempotencyKey: input.idempotencyKey,
		...(input.idempotencyParamsHash === 'ignore'
			? { idempotencyParamsHash: 'ignore' as const }
			: {}),
		...(input.callerIdempotency ? { callerIdempotency: true as const } : {}),
		deliveryId: input.deliveryId,
		payloadBytes: input.payloadBytes,
		receivedAt: input.receivedAt,
	}
}

export function withSpilledWebhookDispatchPayload(
	message: WebhookDispatchQueueMessage,
	payloadKvKey: string,
): WebhookDispatchQueueMessage {
	return {
		...message,
		payloadKvKey,
		params: {
			...message.params,
			request: {
				...message.params.request,
				body: '',
				json: null,
			},
		},
	}
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0
}

export function parseWebhookDispatchQueueMessage(
	body: unknown,
): WebhookDispatchQueueMessage | null {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null
	const message = body as Record<string, unknown>
	const endpoint = message['endpoint']
	const params = message['params']
	if (
		!endpoint ||
		typeof endpoint !== 'object' ||
		Array.isArray(endpoint) ||
		!params ||
		typeof params !== 'object' ||
		Array.isArray(params)
	) {
		return null
	}
	const endpointRecord = endpoint as Record<string, unknown>
	const id = endpointRecord['id']
	const userId = endpointRecord['userId']
	const packageId = endpointRecord['packageId']
	const webhookName = endpointRecord['webhookName']
	const packageKodyId = message['packageKodyId']
	const exportName = message['exportName']
	const idempotencyKey = message['idempotencyKey']
	const deliveryId = message['deliveryId']
	const payloadBytes = message['payloadBytes']
	const receivedAt = message['receivedAt']
	if (
		!isNonEmptyString(id) ||
		!isNonEmptyString(userId) ||
		!isNonEmptyString(packageId) ||
		!isNonEmptyString(webhookName) ||
		!isNonEmptyString(packageKodyId) ||
		!isNonEmptyString(exportName) ||
		!isNonEmptyString(idempotencyKey) ||
		!isNonEmptyString(deliveryId) ||
		typeof payloadBytes !== 'number' ||
		!Number.isInteger(payloadBytes) ||
		payloadBytes < 0 ||
		!isNonEmptyString(receivedAt)
	) {
		return null
	}
	const payloadKvKey = message['payloadKvKey']
	if (payloadKvKey !== undefined) {
		if (
			!isNonEmptyString(payloadKvKey) ||
			payloadKvKey !== webhookDispatchPayloadKvKey(userId, deliveryId)
		) {
			return null
		}
	}
	const idempotencyParamsHash = message['idempotencyParamsHash']
	if (
		idempotencyParamsHash !== undefined &&
		idempotencyParamsHash !== 'ignore'
	) {
		return null
	}
	const inputMode = message['inputMode']
	if (inputMode !== undefined && inputMode !== 'params') {
		return null
	}
	const callerIdempotency = message['callerIdempotency']
	if (callerIdempotency !== undefined && callerIdempotency !== true) {
		return null
	}
	return {
		endpoint: {
			id,
			userId: userId as OwnerId,
			packageId,
			webhookName,
		},
		packageKodyId,
		exportName,
		params: params as WebhookExportParams,
		...(inputMode === 'params' ? { inputMode: 'params' as const } : {}),
		idempotencyKey,
		...(idempotencyParamsHash === 'ignore'
			? { idempotencyParamsHash: 'ignore' as const }
			: {}),
		...(callerIdempotency === true ? { callerIdempotency: true as const } : {}),
		deliveryId,
		payloadBytes,
		receivedAt,
		...(payloadKvKey ? { payloadKvKey } : {}),
	}
}

export function getWebhookDispatchQueueMessageBytes(
	message: WebhookDispatchQueueMessage,
) {
	return new TextEncoder().encode(JSON.stringify(message)).byteLength
}

export async function enqueueWebhookDispatch(input: {
	queue: Pick<Queue<WebhookDispatchQueueMessage>, 'send'>
	message: WebhookDispatchQueueMessage
}) {
	await input.queue.send(input.message)
}
