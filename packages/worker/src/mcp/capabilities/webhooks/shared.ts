import { z } from 'zod'
import {
	packageIdLookupDescription,
	packageKodyIdOptionalCamelInput,
} from '#worker/package-registry/package-name.ts'
import {
	packageWebhookChallengeSchema,
	type PackageWebhookChallenge,
} from '#worker/package-registry/types.ts'

export const webhookPackageRefSchema = {
	packageId: z.string().min(1).optional().describe(packageIdLookupDescription),
	kodyId: packageKodyIdOptionalCamelInput(),
}

export const webhookVerificationPublicSchema = z
	.discriminatedUnion('type', [
		z.object({
			type: z.enum(['hmac-sha256', 'hmac-sha1']),
			header: z.string(),
			secretName: z.string().optional(),
			encoding: z.enum(['hex', 'base64']),
			prefix: z.string().optional(),
			signedPayload: z.enum(['body', 'timestamp.body']).optional(),
		}),
		z.object({ type: z.literal('url-secret') }),
	])
	.nullable()

export const webhookReplayPublicSchema = z
	.object({
		timestampHeader: z.string().optional(),
		timestampFormat: z
			.enum(['unix-seconds', 'unix-millis', 'iso-8601', 'stripe-signature'])
			.optional(),
		toleranceSeconds: z.number().int().optional(),
		deliveryIdHeader: z.string().optional(),
	})
	.nullable()

export const webhookChallengePublicSchema = packageWebhookChallengeSchema
	.nullable()
	.describe(
		'Platform-answered subscription challenge from package.json#kody.webhooks[].challenge (secretName is a secret-store name, never a value). Null when not declared.',
	)

export const listedWebhookSchema = z.object({
	package_id: z.string(),
	package_kody_id: z.string(),
	package_name: z.string(),
	name: z.string(),
	export_name: z.string(),
	description: z.string().nullable(),
	response_mode: z.enum(['ack', 'sync']),
	input_mode: z.enum(['request', 'params']),
	rate_limit_per_minute: z.number().int(),
	verification: webhookVerificationPublicSchema,
	replay: webhookReplayPublicSchema,
	challenge: webhookChallengePublicSchema,
	minted: z
		.boolean()
		.describe('True when a URL secret has been minted for this webhook.'),
	approved: z
		.boolean()
		.describe('True when this webhook has a live enablement.'),
	approval_url: z
		.string()
		.nullable()
		.describe(
			'Open this and click Approve to turn the webhook on. Null when approved or not minted.',
		),
	endpoint_id: z
		.string()
		.nullable()
		.describe(
			'Webhook endpoint id when minted. Pass to rotate when several URLs share the name. Turn it off with enablementDisable. Null when not minted.',
		),
	instance_label: z
		.string()
		.nullable()
		.describe(
			'Short label when several URLs share the declared webhook name. Null when unlabeled or not minted.',
		),
	handle: z
		.string()
		.nullable()
		.describe(
			'Opaque handle for webhookUrlApply. Null when not minted. Never a credential.',
		),
	url_host: z
		.string()
		.nullable()
		.describe('Public hostname of the ingress origin. Null when not minted.'),
	created_at: z.string().nullable(),
	rotated_at: z.string().nullable(),
	previous_url_active_until: z
		.string()
		.nullable()
		.describe(
			'ISO timestamp while the previous URL still accepts deliveries after rotate. Null when there is no live overlap.',
		),
})

export const mintedWebhookHandleSchema = z.object({
	package_id: z.string(),
	package_kody_id: z.string(),
	name: z.string(),
	endpoint_id: z
		.string()
		.describe('Webhook endpoint id. The URL identity for this mint.'),
	instance_label: z
		.string()
		.nullable()
		.describe(
			'Short label when several URLs share the declared webhook name. Null on the first mint without a label.',
		),
	handle: z
		.string()
		.describe(
			'Opaque handle for webhookUrlApply. Does not contain the URL secret.',
		),
	url_host: z
		.string()
		.describe('Public hostname of the ingress origin (no path or secret).'),
	created_at: z.string(),
	rotated_at: z.string(),
	previous_url_active_until: z
		.string()
		.nullable()
		.describe(
			'ISO timestamp while the previous URL still accepts deliveries after rotate. Null on first mint.',
		),
	approval_url: z
		.string()
		.nullable()
		.describe(
			'Send this to the person: deliveries run only after they open it and click Approve. Approve turns the webhook on. Null once the webhook is on (or paused) for someone.',
		),
})

export const webhookUrlApplyResultSchema = z.object({
	ok: z.boolean(),
	url_host: z.string(),
	http_status: z.number().int(),
	remote_id: z.string().nullable(),
	error: z.string().nullable(),
})

export const webhookDeliverySchema = z.object({
	id: z.string(),
	package_id: z.string(),
	webhook_name: z.string(),
	received_at: z.string(),
	outcome: z.enum(['delivered', 'rejected', 'failed']),
	http_status: z.number().int(),
	error: z.string().nullable(),
	payload_bytes: z.number().int(),
})

export function requirePackageRef(input: {
	packageId?: string
	kodyId?: string
}) {
	if (!input.packageId && !input.kodyId) {
		throw new Error('Provide packageId or kodyId.')
	}
}

export function toListedWebhookCapability(webhook: {
	packageId: string
	packageKodyId: string
	packageName: string
	name: string
	exportName: string
	description: string | null
	responseMode: 'ack' | 'sync'
	inputMode: 'request' | 'params'
	rateLimitPerMinute: number
	verification: z.infer<typeof webhookVerificationPublicSchema>
	replay?: z.infer<typeof webhookReplayPublicSchema>
	challenge: PackageWebhookChallenge | null
	minted: boolean
	approved: boolean
	approvalUrl: string | null
	endpointId: string | null
	instanceLabel: string | null
	handle: string | null
	urlHost: string | null
	createdAt: string | null
	rotatedAt: string | null
	previousUrlActiveUntil: string | null
}) {
	return {
		package_id: webhook.packageId,
		package_kody_id: webhook.packageKodyId,
		package_name: webhook.packageName,
		name: webhook.name,
		export_name: webhook.exportName,
		description: webhook.description,
		response_mode: webhook.responseMode,
		input_mode: webhook.inputMode,
		rate_limit_per_minute: webhook.rateLimitPerMinute,
		verification: webhook.verification,
		replay: webhook.replay ?? null,
		challenge: webhook.challenge,
		minted: webhook.minted,
		approved: webhook.approved,
		approval_url: webhook.approvalUrl,
		endpoint_id: webhook.endpointId,
		instance_label: webhook.instanceLabel,
		handle: webhook.handle,
		url_host: webhook.urlHost,
		created_at: webhook.createdAt,
		rotated_at: webhook.rotatedAt,
		previous_url_active_until: webhook.previousUrlActiveUntil,
	}
}

export function toMintedWebhookCapability(minted: {
	packageId: string
	packageKodyId: string
	name: string
	endpointId: string
	instanceLabel: string | null
	handle: string
	urlHost: string
	createdAt: string
	rotatedAt: string
	previousUrlActiveUntil: string | null
	approvalUrl: string | null
}) {
	return {
		package_id: minted.packageId,
		package_kody_id: minted.packageKodyId,
		name: minted.name,
		endpoint_id: minted.endpointId,
		instance_label: minted.instanceLabel,
		handle: minted.handle,
		url_host: minted.urlHost,
		created_at: minted.createdAt,
		rotated_at: minted.rotatedAt,
		previous_url_active_until: minted.previousUrlActiveUntil,
		approval_url: minted.approvalUrl,
	}
}

export function toAppliedWebhookCapability(applied: {
	ok: boolean
	urlHost: string
	httpStatus: number
	remoteId: string | null
	error: string | null
}) {
	return {
		ok: applied.ok,
		url_host: applied.urlHost,
		http_status: applied.httpStatus,
		remote_id: applied.remoteId,
		error: applied.error,
	}
}

export function toDeliveryCapability(delivery: {
	id: string
	packageId: string
	webhookName: string
	receivedAt: string
	outcome: 'delivered' | 'rejected' | 'failed'
	httpStatus: number
	error: string | null
	payloadBytes: number
}) {
	return {
		id: delivery.id,
		package_id: delivery.packageId,
		webhook_name: delivery.webhookName,
		received_at: delivery.receivedAt,
		outcome: delivery.outcome,
		http_status: delivery.httpStatus,
		error: delivery.error,
		payload_bytes: delivery.payloadBytes,
	}
}
