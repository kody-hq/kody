import { chunkArray } from '@kody-internal/shared/chunk.ts'
import {
	personIdFromStored,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { mcpEventsExtensionFlagKey } from '#universal/feature-flags/registry.ts'
import {
	checkPermission,
	computeEffectivePermissions,
	packageResource,
	type EffectivePermissions,
} from '#worker/authorization/authorize.ts'
import { deriveRequestContext } from '#worker/request-context/request-context.ts'
import { isFeatureEnabled } from '#worker/feature-flags/service.ts'
import { type PackageEventsDispatchQueueMessage } from '#worker/package-events/dispatch-queue-producer.ts'
import { listPackageEmittedEvents } from '#worker/package-registry/manifest.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { loadPackageManifestBySourceId } from '#worker/package-registry/source.ts'
import { mcpEventDeliveryConcurrency } from './constants.ts'
import {
	buildMcpEventId,
	deliverMcpEventOccurrence,
	serializeMcpEventOccurrence,
	type McpEventOccurrence,
} from './deliver.ts'
import {
	listDeliverableMcpEventSubscriptions,
	readMcpEventSubscriptionSigningSecrets,
	recordMcpEventDeliveryOutcome,
	type McpEventSubscriptionRecord,
} from './subscriptions-repo.ts'

import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
export type McpEventFanOutResult = {
	status:
		| 'skipped_not_mcp'
		| 'no_subscriptions'
		| 'skipped_flag_off'
		| 'fanned_out'
	delivered: number
	failed: number
	/** Subscriptions whose credential or profile can no longer read the source package. */
	denied: number
}

async function isMcpEventsExtensionEnabledForUser(input: {
	db: D1Database
	userId: OwnerId
}): Promise<boolean> {
	const row = await input.db
		.prepare(
			`SELECT id FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId)
		.first<{ id: number }>()
	if (!row) return false
	return await isFeatureEnabled(input.db, mcpEventsExtensionFlagKey, row.id)
}

/**
 * Re-check the live package manifest so a topic that withdrew `mcp: true`
 * after enqueue does not still reach webhooks. Fail closed on load errors.
 */
async function sourcePackageStillExposesTopicOverMcp(input: {
	env: Env
	baseUrl: string
	message: PackageEventsDispatchQueueMessage
}): Promise<boolean> {
	try {
		const saved = await getSavedPackageById(input.env.APP_DB, {
			userId: input.message.userId,
			packageId: input.message.source.packageId,
		})
		if (!saved) return false
		const loaded = await loadPackageManifestBySourceId({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.message.userId,
			sourceId: saved.sourceId,
		})
		return listPackageEmittedEvents(loaded.manifest).some(
			(event) => event.topic === input.message.topic && event.mcp === true,
		)
	} catch (error) {
		console.warn('mcp-events-live-mcp-check-failed', {
			packageId: input.message.source.packageId,
			topic: input.message.topic,
			error,
		})
		return false
	}
}

/**
 * Owned OAuth clients that were revoked must not receive deliveries even when
 * subscription cleanup lagged. Third-party clients (no ownership row) stay
 * eligible; revoke paths delete those rows and retry on already-revoked.
 */
async function isOwnedOauthClientRevoked(input: {
	db: D1Database
	oauthClientId: string
}): Promise<boolean> {
	const row = await input.db
		.prepare(
			`SELECT revoked_at FROM user_mcp_oauth_clients WHERE client_id = ?`,
		)
		.bind(input.oauthClientId)
		.first<{ revoked_at: string | null }>()
	return Boolean(row?.revoked_at)
}

/**
 * MCP Events leg of package event delivery. Runs inside the same
 * `kody-package-events-dispatch` consumer message as package subscribers
 * (`deliverPackageEventWithToolFactories`), so there is one dispatch path.
 *
 * Delivery-time re-checks: the emitter still declares `mcp: true` on the live
 * manifest (not only the enqueue stamp), the user still has the flag, the
 * subscription is live and verified, its OAuth client is not an owned revoked
 * client, and its credential (and profile, when bound) still allows `read` on the emitting
 * package. Per-subscription failures are recorded as `last_error` and never
 * thrown, so a dead callback cannot force a queue redelivery that would
 * replay every other subscriber.
 */
export async function fanOutPackageEventToMcpSubscriptions(input: {
	env: Env
	baseUrl: string
	message: PackageEventsDispatchQueueMessage
	now?: Date
}): Promise<McpEventFanOutResult> {
	const { message } = input
	const result: McpEventFanOutResult = {
		status: 'skipped_not_mcp',
		delivered: 0,
		failed: 0,
		denied: 0,
	}
	if (message.mcp !== true) return result
	if (
		!(await sourcePackageStillExposesTopicOverMcp({
			env: input.env,
			baseUrl: input.baseUrl,
			message,
		}))
	) {
		return result
	}

	const db = input.env.APP_DB
	const now = input.now ?? new Date()
	// Read-only on the hot path: expired rows are filtered here and pruned by
	// events/subscribe, which keeps each principal's row count bounded.
	const subscriptions = await listDeliverableMcpEventSubscriptions({
		db,
		userId: message.userId,
		eventName: message.topic,
		now,
	})
	if (subscriptions.length === 0) {
		result.status = 'no_subscriptions'
		return result
	}

	if (
		!(await isMcpEventsExtensionEnabledForUser({ db, userId: message.userId }))
	) {
		result.status = 'skipped_flag_off'
		return result
	}

	const accessByProfile = new Map<string, Promise<EffectivePermissions>>()
	const subscriberAccess = (profileId: string | null) => {
		const key = profileId ?? ''
		let pending = accessByProfile.get(key)
		if (!pending) {
			pending = computeEffectivePermissions({
				env: input.env,
				request: deriveRequestContext({
					user: { userId: personIdFromStored(message.userId as string) },
					source: { kind: 'mcp-oauth' },
					profileId,
				}),
			})
			accessByProfile.set(key, pending)
		}
		return pending
	}
	const revokedClientCache = new Map<string, Promise<boolean>>()
	const allowed: Array<McpEventSubscriptionRecord> = []
	for (const subscription of subscriptions) {
		let revokedPending = revokedClientCache.get(subscription.oauthClientId)
		if (!revokedPending) {
			revokedPending = isOwnedOauthClientRevoked({
				db,
				oauthClientId: subscription.oauthClientId,
			})
			revokedClientCache.set(subscription.oauthClientId, revokedPending)
		}
		if (await revokedPending) {
			result.denied += 1
			continue
		}
		const access = await subscriberAccess(subscription.profileId)
		const decision = checkPermission(
			access,
			'package:read',
			packageResource({
				id: message.source.packageId,
				userId: message.userId,
			}),
		)
		if (decision.allowed) {
			allowed.push(subscription)
		} else {
			result.denied += 1
		}
	}

	result.status = 'fanned_out'
	const occurrence: McpEventOccurrence = {
		eventId: await buildMcpEventId({
			sourcePackageId: message.source.packageId,
			topic: message.topic,
			idempotencyKey: message.idempotencyKey,
		}),
		name: message.topic,
		timestamp: message.emittedAt ?? now.toISOString(),
		data: message.payload,
		cursor: null,
	}
	const body = serializeMcpEventOccurrence(occurrence)

	for (const chunk of chunkArray(allowed, mcpEventDeliveryConcurrency)) {
		const settled = await Promise.allSettled(
			chunk.map(async (subscription) => {
				const secrets = await readMcpEventSubscriptionSigningSecrets({
					db,
					env: input.env,
					userId: message.userId,
					id: subscription.id,
					now,
				})
				const delivery = await deliverMcpEventOccurrence({
					subscriptionId: subscription.id,
					callbackUrl: subscription.callbackUrl,
					secrets,
					occurrence,
					body,
				})
				await recordMcpEventDeliveryOutcome({
					db,
					userId: message.userId,
					id: subscription.id,
					now: new Date(),
					outcome: delivery.ok
						? { ok: true }
						: { ok: false, error: delivery.error },
				})
				return delivery
			}),
		)
		for (const [index, settledResult] of settled.entries()) {
			if (settledResult.status === 'fulfilled' && settledResult.value.ok) {
				result.delivered += 1
				continue
			}
			result.failed += 1
			console.warn('mcp-event-delivery-failed', {
				subscriptionId: chunk[index]?.id,
				topic: message.topic,
				eventId: occurrence.eventId,
				...(settledResult.status === 'fulfilled'
					? {
							error: settledResult.value.ok ? null : settledResult.value.error,
							attempts: settledResult.value.attempts,
						}
					: { error: settledResult.reason }),
			})
		}
	}
	return result
}
