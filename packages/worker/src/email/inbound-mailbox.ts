import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { isSystemEmailOwner } from './email-owner.ts'
import { processInboundDeliveryEffects } from './inbound-effects.ts'
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
 * 2) run Mailbox-authoritative inbound delivery effects
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
