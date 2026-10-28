import { checkPermission } from '#worker/authorization/authorize.ts'
import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { getOrgCredential } from '#worker/credentials/credential-ids.ts'
import { runQueueableDynamicWorkerWork } from '#worker/dynamic-worker-evaluation-budget.ts'
import { getEnablementById } from '#worker/enablements/repo.ts'
import { type EnablementAudience } from '#worker/enablements/run-gate.ts'
import { type OrgAuditOutboxPayload } from '#worker/orgs/org-audit-outbox.ts'
import { getOrgById } from '#worker/orgs/repo.ts'
import {
	loadMatchingPackageSubscriptions,
	readPreExecutionPackageInvocationInfrastructureCode,
	type LoadedPackageSubscription,
} from '#worker/package-invocations/admin-package-subscriptions.ts'
import { invokePackageSubscription } from '#worker/package-invocations/service.ts'
import { listSavedPackagesByIds } from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { recordRunRecord } from '#worker/run-records/service.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	buildResourceChangeEvent,
	maxResourceEventDepth,
	projectResourceChange,
	type ResourceChangeEvent,
	type ResourceChangeProjection,
} from './projection.ts'

const resourceEventsActorTokenId = 'internal:resource-events'
const resourceEventsSource = 'resource-events'

export type ResourceEventDropReason = 'own_change' | 'chain_limit'

export type ResourceEventDispatchHooks = {
	loadSubscriptions?: (input: {
		env: Env
		orgId: string
		topic: string
	}) => Promise<Array<LoadedPackageSubscription>>
	invoke?: typeof invokePackageSubscription
	recordDrop?: typeof recordDroppedResourceEvent
	loadPackage?: (input: {
		env: Env
		orgId: string
		packageId: string
	}) => Promise<SavedPackageRecord | null>
}

/**
 * Deliver the resource change event for one newly inserted, successful org
 * audit row to the org's packages that subscribe to its topic.
 *
 * - Each subscription runs once per on enablement whose enabler can see the
 *   resource, checked at delivery (the enablement audience rule). Memories
 *   reach only Owners, which in a personal org is the memory's owner.
 * - The actor is included only for enablers with `audit:read` in the org,
 *   also checked at delivery.
 * - A package never receives an event about a change it made, and a chain of
 *   events started by package changes stops after
 *   {@link maxResourceEventDepth} hops. Either drop writes a warning in the
 *   causing package's activity.
 * - Kody pays for routing; handler runs count toward the subscriber org's
 *   automation limits and credits, like follows.
 *
 * Best-effort: discovery and invocation failures are logged, never thrown.
 */
export async function dispatchResourceChangeEvent(input: {
	env: Env
	payload: OrgAuditOutboxPayload
	hooks?: ResourceEventDispatchHooks
}) {
	const { env, payload } = input
	if (payload.result !== 'success') return { delivered: 0, dropped: [] }
	const projection = projectResourceChange(payload)
	if (!projection) return { delivered: 0, dropped: [] }
	if (!input.hooks?.loadSubscriptions && !env.BUNDLE_ARTIFACTS_KV) {
		return { delivered: 0, dropped: [] }
	}
	const subscriptions = await loadSubscriptions({
		env,
		orgId: payload.orgId,
		topic: projection.topic,
		hooks: input.hooks,
	})
	if (subscriptions.length === 0) return { delivered: 0, dropped: [] }

	const cause = payload.cause ?? null
	const depth = (cause?.resourceEventDepth ?? 0) + 1
	const recordDrop = input.hooks?.recordDrop ?? recordDroppedResourceEvent
	const dropped: Array<{
		packageId: string
		reason: ResourceEventDropReason
	}> = []
	if (depth > maxResourceEventDepth) {
		const causingPackage = cause?.packageId
			? await loadCausingPackage({
					env,
					orgId: payload.orgId,
					packageId: cause.packageId,
					hooks: input.hooks,
				})
			: null
		if (causingPackage) {
			await recordDrop({
				env,
				savedPackage: causingPackage,
				topic: projection.topic,
				reason: 'chain_limit',
				auditId: payload.id,
			})
			dropped.push({ packageId: causingPackage.id, reason: 'chain_limit' })
		}
		return { delivered: 0, dropped }
	}

	const recipients: Array<LoadedPackageSubscription> = []
	for (const entry of subscriptions) {
		if (cause?.packageId && entry.savedPackage.id === cause.packageId) {
			await recordDrop({
				env,
				savedPackage: entry.savedPackage,
				topic: projection.topic,
				reason: 'own_change',
				auditId: payload.id,
			})
			dropped.push({ packageId: entry.savedPackage.id, reason: 'own_change' })
			continue
		}
		recipients.push(entry)
	}
	if (recipients.length === 0) return { delivered: 0, dropped }

	const [name, orgSlug, audience] = await Promise.all([
		resolveDisplayName(env, payload.orgId, projection),
		getOrgById(env.APP_DB, payload.orgId).then((org) => org?.slug ?? null),
		resolveAudience(env, payload.orgId, projection),
	])
	const event = buildResourceChangeEvent({
		projection,
		name,
		orgSlug,
		occurredAt: payload.createdAt,
		eventId: crypto.randomUUID(),
	})
	const actor: NonNullable<ResourceChangeEvent['actor']> = payload.actorUserId
		? { kind: 'person', username: payload.actorUsername ?? null }
		: { kind: 'automation', username: null }
	const baseUrl = getAppBaseUrl({ env })
	const invoke = input.hooks?.invoke ?? invokePackageSubscription
	const settled = await runQueueableDynamicWorkerWork(
		async () =>
			await Promise.allSettled(
				recipients.map(async ({ savedPackage }) => {
					const response = await invoke({
						env,
						baseUrl,
						savedPackage,
						topic: projection.topic,
						params: event as unknown as Record<string, unknown>,
						paramsForRun: ({ access }) =>
							(access && checkPermission(access, 'audit:read').allowed
								? { ...event, actor }
								: event) as unknown as Record<string, unknown>,
						idempotencyKey: `resource-event:${payload.id}:${savedPackage.id}`,
						source: resourceEventsSource,
						request: { kind: 'platform-event', sourceId: resourceEventsSource },
						actorTokenId: resourceEventsActorTokenId,
						audience,
						resourceEventDepth: depth,
					})
					const retryableCode =
						readPreExecutionPackageInvocationInfrastructureCode(response)
					if (retryableCode) {
						throw new Error(
							`Package invocation infrastructure response: ${retryableCode}.`,
						)
					}
					return response
				}),
			),
	)
	let delivered = 0
	for (const result of settled) {
		if (result.status === 'fulfilled') {
			delivered += 1
			continue
		}
		console.warn('resource-change-event-invoke-failed', {
			topic: projection.topic,
			auditId: payload.id,
			error: result.reason,
		})
	}
	return { delivered, dropped }
}

async function loadSubscriptions(input: {
	env: Env
	orgId: string
	topic: string
	hooks?: ResourceEventDispatchHooks
}) {
	try {
		if (input.hooks?.loadSubscriptions) {
			return await input.hooks.loadSubscriptions(input)
		}
		const loaded = await loadMatchingPackageSubscriptions({
			env: input.env,
			baseUrl: getAppBaseUrl({ env: input.env }),
			userId: input.orgId,
			topic: input.topic,
		})
		if (loaded.discoveryErrors.length > 0) {
			console.warn('resource-change-event-discovery-incomplete', {
				topic: input.topic,
				errorCount: loaded.discoveryErrors.length,
				error: loaded.discoveryErrors[0],
			})
		}
		return loaded.subscriptions
	} catch (error) {
		console.warn('resource-change-event-discovery-failed', {
			topic: input.topic,
			error,
		})
		return []
	}
}

async function loadCausingPackage(input: {
	env: Env
	orgId: string
	packageId: string
	hooks?: ResourceEventDispatchHooks
}) {
	if (input.hooks?.loadPackage) return await input.hooks.loadPackage(input)
	const [savedPackage] = await listSavedPackagesByIds(input.env.APP_DB, {
		userId: input.orgId,
		packageIds: [input.packageId],
	})
	return savedPackage ?? null
}

/**
 * Who may receive the event: anyone who can see the resource. Membership
 * needs `member:read`; memories and anything unresolvable reach Owners only.
 */
async function resolveAudience(
	env: Env,
	orgId: string,
	projection: ResourceChangeProjection,
): Promise<EnablementAudience> {
	const id = projection.resourceId
	switch (projection.kind) {
		case 'credential':
		case 'package':
		case 'job':
			return { resource: id ? { type: projection.kind, id } : null }
		case 'membership':
			return { resource: null, orgPermission: 'member:read' }
		case 'trigger': {
			const enablement = id
				? await getEnablementById({ db: env.APP_DB, orgId, id })
				: null
			if (enablement?.triggerKind === 'subscription') {
				return { resource: { type: 'package', id: enablement.instanceId } }
			}
			if (enablement?.triggerKind === 'cron') {
				return { resource: { type: 'job', id: enablement.instanceId } }
			}
			return { resource: null }
		}
		case 'memory':
			return { resource: null }
		default: {
			const exhaustive: never = projection.kind
			throw new Error(`Unknown resource kind: ${String(exhaustive)}`)
		}
	}
}

/** The name people know the resource by. Never an internal id. */
async function resolveDisplayName(
	env: Env,
	orgId: string,
	projection: ResourceChangeProjection,
): Promise<string | null> {
	try {
		if (projection.kind === 'membership' && projection.targetUserId) {
			const row = await env.APP_DB.prepare(
				`SELECT username FROM users WHERE stable_user_id = ?${andLiveDeletedAtSql()} LIMIT 1`,
			)
				.bind(projection.targetUserId)
				.first<{ username: string | null }>()
			return row?.username ?? null
		}
		if (projection.name) return projection.name
		if (projection.kind === 'credential' && projection.resourceId) {
			const credential = await getOrgCredential(
				env.APP_DB,
				orgId,
				projection.resourceId,
			)
			return credential?.name ?? null
		}
		if (projection.kind === 'package' && projection.resourceId) {
			const [savedPackage] = await listSavedPackagesByIds(env.APP_DB, {
				userId: orgId,
				packageIds: [projection.resourceId],
			})
			return savedPackage?.kodyId ?? null
		}
	} catch (error) {
		console.warn('resource-change-event-name-failed', {
			topic: projection.topic,
			error,
		})
	}
	return null
}

const dropMessages: Record<ResourceEventDropReason, string> = {
	own_change:
		'this package made the change itself, and a package never receives events about its own changes.',
	chain_limit: `it came from a chain of more than ${maxResourceEventDepth} resource change events started by changes packages made, and Kody stops a chain after ${maxResourceEventDepth}.`,
}

/**
 * A warning in the package's activity naming the event Kody dropped and why,
 * so a package author can see why a handler did not run.
 */
export async function recordDroppedResourceEvent(input: {
	env: Env
	savedPackage: SavedPackageRecord
	topic: string
	reason: ResourceEventDropReason
	auditId: string
}) {
	try {
		await recordRunRecord({
			env: input.env,
			userId: input.savedPackage.userId,
			context: {
				surface: 'subscription',
				name: input.topic,
				packageId: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
				sourceId: input.savedPackage.sourceId,
				idempotencyKey: `resource-event-dropped:${input.auditId}:${input.savedPackage.id}`,
				metadata: {
					dropped_event: input.topic,
					drop_reason: input.reason,
				},
			},
			status: 'success',
			logs: [
				{
					level: 'warn',
					message: `Kody did not deliver ${input.topic} to this package: ${dropMessages[input.reason]}`,
					fields: { event: input.topic, reason: input.reason },
				},
			],
		})
	} catch (error) {
		console.warn('resource-change-event-drop-record-failed', {
			topic: input.topic,
			error,
		})
	}
}
