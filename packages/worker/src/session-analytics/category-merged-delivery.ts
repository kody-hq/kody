import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { dispatchAdminPackageSubscriptionEvent } from '#worker/package-invocations/admin-package-subscriptions.ts'

export const sessionCategoryMergedTopic = 'session.category.merged'

export const sessionCategoryMergedQueueMessageKind = 'session-category-merged'

const sessionCategoryMergedActorTokenId = 'internal:session-analytics-events'

export type SessionCategoryMergedEvent = {
	event: typeof sessionCategoryMergedTopic
	from: { id: string; name: string }
	into: { id: string; name: string }
	observed_at: string
}

/** The whole event rides in the message: it is category metadata only. */
type SessionCategoryMergedQueueMessage = {
	kind: typeof sessionCategoryMergedQueueMessageKind
	event: SessionCategoryMergedEvent
}

type DeliveryEnv = Pick<
	Env,
	'APP_DB' | 'BUNDLE_ARTIFACTS_KV' | 'APP_BASE_URL'
> &
	Partial<Pick<Env, 'PACKAGE_EVENTS_DISPATCH_QUEUE'>>

export function isSessionCategoryMergedQueueBody(body: unknown) {
	return (
		!!body &&
		typeof body === 'object' &&
		!Array.isArray(body) &&
		(body as Record<string, unknown>)['kind'] ===
			sessionCategoryMergedQueueMessageKind
	)
}

function parseCategory(value: unknown) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	const { id, name } = value as Record<string, unknown>
	if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) {
		return null
	}
	return { id, name }
}

export function parseSessionCategoryMergedQueueMessage(
	body: unknown,
): SessionCategoryMergedQueueMessage | null {
	if (!isSessionCategoryMergedQueueBody(body)) return null
	const event = (body as Record<string, unknown>)['event']
	if (!event || typeof event !== 'object' || Array.isArray(event)) return null
	const record = event as Record<string, unknown>
	const from = parseCategory(record['from'])
	const into = parseCategory(record['into'])
	const observedAt = record['observed_at']
	if (!from || !into || typeof observedAt !== 'string' || !observedAt) {
		return null
	}
	return {
		kind: sessionCategoryMergedQueueMessageKind,
		event: {
			event: sessionCategoryMergedTopic,
			from,
			into,
			observed_at: observedAt,
		},
	}
}

/**
 * Deliver one merge to admin package subscribers. Throws when discovery or
 * the invocation infrastructure failed, so the Queue consumer retries. The
 * idempotency key is the merged category and the package, the same on every
 * attempt, so a subscriber that already handled the merge is not run again.
 */
export async function deliverSessionCategoryMerged(input: {
	env: DeliveryEnv
	event: SessionCategoryMergedEvent
	waitUntil?: (promise: Promise<unknown>) => void
}) {
	return await dispatchAdminPackageSubscriptionEvent({
		env: input.env,
		baseUrl: getAppBaseUrl({ env: input.env }),
		topic: sessionCategoryMergedTopic,
		getParams: () => input.event as Record<string, unknown>,
		source: 'session-analytics',
		buildIdempotencyKey: (savedPackage) =>
			`${sessionCategoryMergedTopic}:${input.event.from.id}:${savedPackage.id}`,
		actorTokenId: sessionCategoryMergedActorTokenId,
		retryDiscoveryFailures: true,
		retryInvocationInfrastructureFailures: true,
		waitUntil: input.waitUntil,
	})
}

/**
 * Hand a merge to the package-events Queue, whose consumer retries a failed
 * delivery. Without the Queue binding (local dev, previews), or when the send
 * fails, deliver once inline. Never throws: the merge is already stored.
 */
export async function enqueueSessionCategoryMerged(input: {
	env: DeliveryEnv
	event: SessionCategoryMergedEvent
}) {
	const queue = input.env.PACKAGE_EVENTS_DISPATCH_QUEUE
	if (queue) {
		try {
			await queue.send({
				kind: sessionCategoryMergedQueueMessageKind,
				event: input.event,
			} satisfies SessionCategoryMergedQueueMessage)
			return
		} catch (error) {
			// Subscribers lose the retries and the dead letter: the merge gets
			// one inline attempt below instead.
			console.warn('session-category-merged-enqueue-failed', {
				categoryId: input.event.from.id,
				retried: false,
				error: String(error),
			})
		}
	}
	try {
		await deliverSessionCategoryMerged(input)
	} catch (error) {
		// Subscribers never hear about this merge: nothing retries it.
		console.warn('session-analytics-event-dispatch-failed', {
			topic: sessionCategoryMergedTopic,
			categoryId: input.event.from.id,
			retried: false,
			error: String(error),
		})
	}
}
