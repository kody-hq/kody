import { ProtocolError } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { type McpCallerContext } from '@kody-internal/shared/chat.ts'
import {
	personalOrgId,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	mcpEventCallbackVerificationTtlMs,
	mcpEventSubscriptionDefaultTtlMs,
	mcpEventSubscriptionMaxTtlMs,
	mcpEventSubscriptionMinTtlMs,
	mcpEventSubscriptionsPerPrincipalMax,
	mcpEventsErrorCodes,
	type McpEventDeliveryErrorCategory,
} from './constants.ts'
import {
	McpEventCallbackVerificationError,
	verifyMcpEventCallback,
} from './deliver.ts'
import { listMcpEventSources } from './list-events.ts'
import { decodeWebhookSecret, InvalidWebhookSecretError } from './signing.ts'
import { assertMcpEventCallbackUrl, McpEventCallbackUrlError } from './ssrf.ts'
import {
	buildMcpEventSubscriptionId,
	countLiveMcpEventSubscriptionsForPrincipal,
	deleteExpiredMcpEventSubscriptions,
	getMcpEventSubscription,
	findRecentMcpEventCallbackVerification,
	mcpEventSubscriptionSecretMatches,
	upsertMcpEventSubscription,
	type McpEventSubscriptionKey,
} from './subscriptions-repo.ts'

export const mcpEventsSubscribeParamsSchema = z.looseObject({
	name: z.string().min(1),
	arguments: z.record(z.string(), z.unknown()).optional(),
	delivery: z.looseObject({
		mode: z.string().min(1),
		url: z.string().min(1),
		secret: z.string().optional(),
	}),
	cursor: z.string().nullable().optional(),
	ttlMs: z.number().nonnegative().nullable().optional(),
	maxAgeMs: z.number().nonnegative().nullable().optional(),
})

export const mcpEventsSubscribeResultSchema = z.object({
	id: z.string(),
	refreshBefore: z.string().nullable(),
	cursor: z.null(),
	truncated: z.boolean(),
	deliveryStatus: z
		.object({
			active: z.boolean(),
			lastDeliveryAt: z.string().nullable(),
			lastError: z.string().nullable(),
		})
		.optional(),
})

export type McpEventsSubscribeParams = z.infer<
	typeof mcpEventsSubscribeParamsSchema
>
export type McpEventsSubscribeResult = z.infer<
	typeof mcpEventsSubscribeResultSchema
>

export type McpEventsPrincipal = {
	env: Env
	callerContext: McpCallerContext
	oauthClientId: string
}

/**
 * Granted lifetime. Omitted → server default; finite → clamped to
 * [min, max]; `null` (no expiry) is refused with the max finite grant,
 * which the draft allows (`refreshBefore: null` only when granting it).
 */
function grantMcpEventSubscriptionTtlMs(
	ttlMs: number | null | undefined,
): number {
	if (ttlMs === undefined) return mcpEventSubscriptionDefaultTtlMs
	if (ttlMs === null) return mcpEventSubscriptionMaxTtlMs
	return Math.min(
		mcpEventSubscriptionMaxTtlMs,
		Math.max(mcpEventSubscriptionMinTtlMs, Math.floor(ttlMs)),
	)
}

export function requireMcpEventsUserId(principal: McpEventsPrincipal): OwnerId {
	const userId = principal.callerContext.user?.userId
	if (!userId || !principal.oauthClientId) {
		throw new ProtocolError(
			mcpEventsErrorCodes.forbidden,
			'Webhook event subscriptions require an authenticated OAuth principal.',
		)
	}
	// person-keyed (not personal org): subscription rows key on the OAuth
	// principal (person id branded as OwnerId), not the personal org.
	return personalOrgId(userId)
}

function invalidParams(message: string): ProtocolError {
	return new ProtocolError(mcpEventsErrorCodes.invalidParams, message)
}

function callbackEndpointError(
	reason: McpEventDeliveryErrorCategory,
): ProtocolError {
	return new ProtocolError(
		mcpEventsErrorCodes.callbackEndpointError,
		'CallbackEndpointError',
		{ reason },
	)
}

export async function subscribeMcpEvent(
	principal: McpEventsPrincipal,
	params: McpEventsSubscribeParams,
	now: Date = new Date(),
): Promise<McpEventsSubscribeResult> {
	const userId = requireMcpEventsUserId(principal)
	const db = principal.env.APP_DB
	if (params.delivery.mode !== 'webhook') {
		throw new ProtocolError(mcpEventsErrorCodes.unsupported, 'Unsupported', {
			feature: 'deliveryMode',
			value: params.delivery.mode,
		})
	}
	const secret = params.delivery.secret
	if (!secret) {
		throw invalidParams('delivery.secret is required for webhook delivery.')
	}
	let callbackUrl: string
	try {
		decodeWebhookSecret(secret)
		callbackUrl = assertMcpEventCallbackUrl(params.delivery.url).href
	} catch (error) {
		if (
			error instanceof InvalidWebhookSecretError ||
			error instanceof McpEventCallbackUrlError
		) {
			throw invalidParams(error.message)
		}
		throw error
	}
	const subscriptionArguments = params.arguments ?? {}
	if (Object.keys(subscriptionArguments).length > 0) {
		throw invalidParams(
			`Event "${params.name}" accepts no arguments; pass {} or omit arguments.`,
		)
	}
	const sources = await listMcpEventSources({
		env: principal.env,
		callerContext: principal.callerContext,
	})
	if (!sources.has(params.name)) {
		throw new ProtocolError(mcpEventsErrorCodes.notFound, 'NotFound', {
			kind: 'event',
			name: params.name,
		})
	}

	const connectionProfileName =
		principal.callerContext.request?.credential.profileName ?? null
	const key: McpEventSubscriptionKey = {
		userId,
		oauthClientId: principal.oauthClientId,
		connectionProfileName,
		profileId: principal.callerContext.request?.credential.profileId ?? null,
		eventName: params.name,
		arguments: subscriptionArguments,
		callbackUrl,
	}
	const id = await buildMcpEventSubscriptionId(key)
	await deleteExpiredMcpEventSubscriptions({ db, userId, now })
	const existing = await getMcpEventSubscription({ db, userId, id })
	if (!existing) {
		const live = await countLiveMcpEventSubscriptionsForPrincipal({
			db,
			userId,
			oauthClientId: principal.oauthClientId,
			now,
		})
		if (live >= mcpEventSubscriptionsPerPrincipalMax) {
			throw new ProtocolError(
				mcpEventsErrorCodes.resourceExhausted,
				'ResourceExhausted',
				{ limit: 'subscriptions', max: mcpEventSubscriptionsPerPrincipalMax },
			)
		}
	}

	const verifiedSince = new Date(
		now.getTime() - mcpEventCallbackVerificationTtlMs,
	)
	const existingSecretMatches = existing
		? await mcpEventSubscriptionSecretMatches({
				db,
				env: principal.env,
				userId,
				id,
				secret,
			})
		: false
	let verifiedAt: string
	if (
		existingSecretMatches &&
		existing?.verifiedAt &&
		existing.verifiedAt > verifiedSince.toISOString()
	) {
		verifiedAt = existing.verifiedAt
	} else {
		const cachedVerifiedAt = await findRecentMcpEventCallbackVerification({
			db,
			env: principal.env,
			userId,
			oauthClientId: principal.oauthClientId,
			callbackUrl,
			secret,
			verifiedSince,
		})
		if (cachedVerifiedAt) {
			verifiedAt = cachedVerifiedAt
		} else {
			try {
				await verifyMcpEventCallback({
					callbackUrl,
					subscriptionId: id,
					secret,
				})
			} catch (error) {
				if (error instanceof McpEventCallbackVerificationError) {
					throw callbackEndpointError(error.reason)
				}
				throw error
			}
			verifiedAt = now.toISOString()
		}
	}

	const refreshBefore = new Date(
		now.getTime() + grantMcpEventSubscriptionTtlMs(params.ttlMs),
	)
	await upsertMcpEventSubscription({
		db,
		env: principal.env,
		id,
		key,
		connectionProfileName,
		secret,
		refreshBefore,
		verifiedAt,
		now,
	})
	return {
		id,
		refreshBefore: refreshBefore.toISOString(),
		cursor: null,
		// Package events have no replay; a client-held cursor cannot resume.
		truncated: params.cursor != null,
		...(existing
			? {
					deliveryStatus: {
						active: existing.active,
						lastDeliveryAt: existing.lastDeliveryAt,
						lastError: existing.lastError,
					},
				}
			: {}),
	}
}
