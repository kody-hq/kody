import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	webhookDefaultRateLimitPerMinute as defaultRateLimitPerMinute,
	webhookMaxRateLimitPerMinute as maxRateLimitPerMinute,
} from '#worker/package-registry/types.ts'

export type WebhookResponseMode = 'ack' | 'sync'

export type WebhookInputMode = 'request' | 'params'

export type WebhookHmacAlgorithm = 'hmac-sha256' | 'hmac-sha1'

export type WebhookSignatureEncoding = 'hex' | 'base64'

export type WebhookSignedPayload = 'body' | 'timestamp.body'

export type WebhookTimestampFormat =
	| 'unix-seconds'
	| 'unix-millis'
	| 'iso-8601'
	| 'stripe-signature'

export type WebhookVerificationConfig = {
	type: WebhookHmacAlgorithm
	header: string
	/**
	 * Optional legacy / provider-issued secret-store name. Omit for
	 * package-owned HMAC minted onto the webhook endpoint record.
	 */
	secretName?: string
	encoding: WebhookSignatureEncoding
	prefix?: string
	signedPayload?: WebhookSignedPayload
}

export type WebhookReplayConfig = {
	timestampHeader?: string
	timestampFormat?: WebhookTimestampFormat
	toleranceSeconds?: number
	deliveryIdHeader?: string
}

export const webhookDefaultReplayToleranceSeconds = 300

/** Minted URL state for a declared package webhook. */
export type WebhookEndpointRecord = {
	id: string
	userId: OwnerId
	packageId: string
	webhookName: string
	urlSecretHash: string
	urlSecretEncrypted: string | null
	/** Package-owned HMAC signing material (not listed in user secrets). */
	hmacSecretEncrypted: string | null
	/**
	 * Last-seen `verification.secretName` identity. Null when the webhook
	 * uses package-owned HMAC (no secretName) or has never reconciled.
	 */
	hmacSecretName: string | null
	/**
	 * Last-seen declared signing value (platform ciphertext). Used to detect
	 * value rotation and to populate previous_* — not for apply injection.
	 */
	hmacVerificationSecretEncrypted: string | null
	previousUrlSecretHash: string | null
	previousUrlSecretExpiresAt: string | null
	/** Previous `verification.secretName` during the signing-secret grace. */
	previousHmacSecretName: string | null
	/** Previous signing value ciphertext during the signing-secret grace. */
	previousHmacSecretEncrypted: string | null
	previousHmacSecretExpiresAt: string | null
	createdAt: string
	rotatedAt: string
	/**
	 * Short user-set label when several URLs share one declared webhook name.
	 * Null for older mints and for the first URL when no label was given.
	 */
	instanceLabel: string | null
}

/**
 * Rotate overlap fallback. Ack-queue spilled payloads already live for 24h
 * (`webhookDispatchPayloadTtlSeconds`); GitHub-style provider retries cover
 * about the same window. The first POST on the new URL that is accepted for
 * dispatch retires the previous secret earlier.
 *
 * Signing-secret rotation (`verification.secretName` rename or value change)
 * uses the same window so provider retries that still sign with the old key
 * keep verifying.
 */
export const webhookUrlRotationGraceMs = 24 * 60 * 60 * 1000

/** Alias: signing-secret grace matches URL rotate overlap. */
export const webhookHmacSecretRotationGraceMs = webhookUrlRotationGraceMs

export function webhookUrlRotationGraceExpiresAt(now: Date | string) {
	const nowMs = typeof now === 'string' ? Date.parse(now) : now.getTime()
	return new Date(nowMs + webhookUrlRotationGraceMs).toISOString()
}

export const webhookHmacSecretRotationGraceExpiresAt =
	webhookUrlRotationGraceExpiresAt

export function isWebhookPreviousUrlLive(
	endpoint: {
		previousUrlSecretHash: string | null
		previousUrlSecretExpiresAt: string | null
	},
	now: Date | string = new Date(),
) {
	if (!endpoint.previousUrlSecretHash || !endpoint.previousUrlSecretExpiresAt) {
		return false
	}
	const nowMs = typeof now === 'string' ? Date.parse(now) : now.getTime()
	return Date.parse(endpoint.previousUrlSecretExpiresAt) > nowMs
}

export function isWebhookPreviousHmacLive(
	endpoint: {
		previousHmacSecretEncrypted: string | null
		previousHmacSecretExpiresAt: string | null
	},
	now: Date | string = new Date(),
) {
	if (
		!endpoint.previousHmacSecretEncrypted ||
		!endpoint.previousHmacSecretExpiresAt
	) {
		return false
	}
	const nowMs = typeof now === 'string' ? Date.parse(now) : now.getTime()
	return Date.parse(endpoint.previousHmacSecretExpiresAt) > nowMs
}

export type WebhookDeliveryOutcome = 'delivered' | 'rejected' | 'failed'

export type WebhookDeliveryRecord = {
	id: string
	endpointId: string
	userId: OwnerId
	packageId: string
	webhookName: string
	receivedAt: string
	outcome: WebhookDeliveryOutcome
	httpStatus: number
	error: string | null
	payloadBytes: number
}

export type WebhookExportParams = {
	webhook: {
		packageKodyId: string
		name: string
		receivedAt: string
	}
	request: {
		method: string
		contentType: string | null
		headers: Record<string, string>
		body: string
		json: unknown | null
	}
	/** Platform-only trust marker for interactive MCP synthetic dispatch. */
	synthetic?: true
}

export const webhookMaxPayloadBytes = 1 * 1024 * 1024
export const webhookDeliveriesRetainedPerEndpoint = 50
export const webhookDefaultRateLimitPerMinute = defaultRateLimitPerMinute
export const webhookMaxRateLimitPerMinute = maxRateLimitPerMinute
export const webhookRateLimitWindowSeconds = 60
export const webhookRateLimitConfig = {
	maxRequests: webhookDefaultRateLimitPerMinute,
	windowSeconds: webhookRateLimitWindowSeconds,
} as const
export const webhookIdempotencyKeyHeader = 'Idempotency-Key'

export function webhookRateLimitConfigFor(perMinute?: number) {
	return {
		maxRequests: perMinute ?? webhookDefaultRateLimitPerMinute,
		windowSeconds: webhookRateLimitWindowSeconds,
	}
}
export const webhookSyncInvocationTimeoutMs = 30_000
export const webhookDeliveryErrorMaxLength = 500
