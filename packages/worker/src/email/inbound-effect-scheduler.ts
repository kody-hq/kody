import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { processInboundDeliveryEffects } from './inbound-effects.ts'

export async function scheduleInboundDeliveryEffects(input: {
	env: Parameters<typeof processInboundDeliveryEffects>[0]['env']
	userId: OwnerId
	deliveryId: string
	expectedFinalizationToken?: string
	durationMs?: number
	ctx?: ExecutionContext
	logLabel: string
}) {
	const waitUntil = input.ctx
		? (promise: Promise<unknown>) => input.ctx!.waitUntil(promise)
		: undefined
	const promise = processInboundDeliveryEffects({
		env: input.env,
		userId: input.userId,
		deliveryId: input.deliveryId,
		expectedFinalizationToken: input.expectedFinalizationToken,
		durationMs: input.durationMs,
		waitUntil,
	})
	if (input.ctx) {
		input.ctx.waitUntil(
			promise.catch((error) => {
				console.error(input.logLabel, error)
			}),
		)
		return
	}
	await promise.catch((error) => {
		console.error(input.logLabel, error)
	})
}
