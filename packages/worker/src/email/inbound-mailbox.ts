import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { isSystemEmailOwner } from './email-owner.ts'
import { processInboundDeliveryEffects } from './inbound-effects.ts'
import { buildInboundDeliveryEffectsQueueMessage } from './inbound-effects-queue.ts'
import type { EmailReportingEnv } from './reporting-events.ts'

/**
 * Env surface for inbound Mailbox terminal coordination.
 * Mailbox owns USER inbound delivery state and graph storage.
 */
export type InboundMailboxEnv = Pick<
	Env,
	| 'APP_DB'
	| 'BUNDLE_ARTIFACTS_KV'
	| 'APP_BASE_URL'
	| 'USAGE_EVENTS'
	| 'USER_METER'
	| 'MAILBOX'
	| 'EMAIL_EVENTS'
> &
	Partial<Pick<Env, 'PACKAGE_EVENTS_DISPATCH_QUEUE'>> &
	EmailReportingEnv

export type InboundReceivedTerminalWorkInput = {
	env: InboundMailboxEnv
	userId: OwnerId
	messageId: string
	deliveryId: string
	expectedFinalizationToken?: string
	durationMs?: number
	ctx?: ExecutionContext
	logLabel: string
}

export type InboundRejectedTerminalWorkInput = {
	env: InboundMailboxEnv
	userId: OwnerId
	deliveryId: string
	ctx?: ExecutionContext
}

/**
 * One ordered received-terminal task:
 * 1) the graph and delivery terminal are already durable in Mailbox
 * 2) enqueue Mailbox-authoritative inbound delivery effects on the package
 *    events Queue so subscription handlers run in a consumer invocation
 *    instead of the Email Routing invocation; run them inline when the Queue
 *    binding is absent (local dev, preview) or the enqueue fails
 *
 * Attach to `ctx.waitUntil` when present; otherwise await. Catch/log once so
 * Mailbox/effects failures never throw into Email Routing.
 * `system:email` is skipped (caller keeps the effects-only system path).
 */
export async function scheduleInboundReceivedTerminalWork(
	input: InboundReceivedTerminalWorkInput,
) {
	if (isSystemEmailOwner(input.userId)) return

	const nestedWaitUntil = input.ctx
		? (promise: Promise<unknown>) => {
				input.ctx!.waitUntil(promise)
			}
		: undefined

	const task = (async () => {
		const queue = input.env.PACKAGE_EVENTS_DISPATCH_QUEUE
		if (queue) {
			try {
				await queue.send(
					buildInboundDeliveryEffectsQueueMessage({
						userId: input.userId,
						deliveryId: input.deliveryId,
						expectedFinalizationToken: input.expectedFinalizationToken,
						durationMs: input.durationMs,
					}),
				)
				return
			} catch (error) {
				console.error('inbound-delivery-effects-enqueue-failed', {
					userId: input.userId,
					deliveryId: input.deliveryId,
					error,
				})
			}
		}
		await processInboundDeliveryEffects({
			env: input.env,
			userId: input.userId,
			deliveryId: input.deliveryId,
			expectedFinalizationToken: input.expectedFinalizationToken,
			durationMs: input.durationMs,
			waitUntil: nestedWaitUntil,
		})
	})().catch((error: unknown) => {
		console.error(input.logLabel, error)
	})

	if (input.ctx) {
		input.ctx.waitUntil(task)
		return
	}
	await task
}

/**
 * Rejected USER delivery state is already durable in Mailbox. Keep this
 * no-op coordinator so callers can preserve their terminal scheduling shape.
 */
export async function scheduleInboundRejectedTerminalWork(
	input: InboundRejectedTerminalWorkInput,
) {
	if (isSystemEmailOwner(input.userId)) return

	const task = Promise.resolve()

	if (input.ctx) {
		input.ctx.waitUntil(task)
		return
	}
	await task
}
