import {
	credentialPlacementRefusedCode,
	readCredentialPlacementRefusalFromInvocationBody,
} from '#worker/credentials/placement-refusal.ts'
import { backgroundExecutorTimeoutMs } from '#mcp/executor-budgets.ts'
import { readPreExecutionPackageInvocationInfrastructureCode } from '#worker/package-invocations/infrastructure-codes.ts'
import { getRunRecord } from '#worker/run-records/service.ts'
import { runEdge } from '@kody-internal/shared/effect/edge.ts'
import {
	OutboundCallError,
	outbound,
	outboundCause,
	outboundTimeout,
} from '@kody-internal/shared/effect/outbound.ts'
import {
	type QueueDisposition,
	settleQueueBatch,
} from '@kody-internal/shared/effect/queue.ts'
import { Cause, Clock, Duration, Effect } from 'effect'
import {
	type AckWebhookDelivery,
	buildWebhookDispatchFailureLogs,
	dispatchWebhookInvocation,
	markAckWebhookDelivery,
	startAckWebhookDeliveryAttempt,
	webhookAckQueuedHoldMs,
	readWebhookInvocationError,
	readWebhookInvocationResult,
	recordWebhookDelivery,
} from './delivery.ts'
import {
	deleteWebhookDispatchPayload,
	hydrateWebhookDispatchQueueMessage,
} from './dispatch-payload-store.ts'
import { ownerCapDeferralDelaySeconds } from '#worker/owner-cap-deferral.ts'
import { webhookDispatchQueueName } from './dispatch-queue-names.ts'
import {
	parseWebhookDispatchQueueMessage,
	type WebhookDispatchQueueMessage,
} from './dispatch-queue-producer.ts'
import {
	buildWebhookCallerIdempotencyHashParams,
	resolveWebhookParamsModeFirstArg,
} from './params.ts'
import { stripUntrustedWebhookSyntheticFields } from './synthetic.ts'

const webhookDispatchRetryDelaySeconds = 30
/** Matches `kody-webhook-dispatch` consumer `max_retries` in wrangler.jsonc. */
export const webhookDispatchMaxRetries = 10
/** Past this many owner-cap deferrals a delivery runs anyway, so a busy owner cannot starve it. */
const webhookDispatchMaxDeferrals = 10

function resolveWebhookDispatchInvocation(
	message: WebhookDispatchQueueMessage,
):
	| {
			ok: true
			params: Record<string, unknown>
			idempotencyHashParams?: Record<string, unknown>
	  }
	| { ok: false; code: 'invalid_params' } {
	if (message.inputMode === 'params') {
		const resolved = resolveWebhookParamsModeFirstArg(
			message.params.request.json,
		)
		if (!resolved.ok) return resolved
		return {
			ok: true,
			params: stripUntrustedWebhookSyntheticFields(resolved.params),
		}
	}
	return {
		ok: true,
		params: message.params,
		...(message.callerIdempotency
			? {
					idempotencyHashParams: buildWebhookCallerIdempotencyHashParams({
						json: message.params.request.json,
						bodyText: message.params.request.body,
					}),
				}
			: {}),
	}
}

function ackDeliveryFromMessage(
	message: WebhookDispatchQueueMessage,
): AckWebhookDelivery {
	return {
		endpoint: message.endpoint,
		kodyId: message.packageKodyId,
		deliveryId: message.deliveryId,
		payloadBytes: message.payloadBytes,
		receivedAt: message.receivedAt,
	}
}

function asInvocationResponseBody(body: unknown): Record<string, unknown> {
	if (body && typeof body === 'object' && !Array.isArray(body)) {
		return body as Record<string, unknown>
	}
	return {}
}

export function processWebhookDispatch(
	message: WebhookDispatchQueueMessage,
	env: Env,
	options?: { attempts?: number },
): Promise<'terminal' | 'retry'> {
	return runEdge(processWebhookDispatchEffect(message, env, options))
}

const processWebhookDispatchEffect = Effect.fn('webhookDispatch.process')(
	function* (
		message: WebhookDispatchQueueMessage,
		env: Env,
		options?: { attempts?: number },
	) {
		const dispatchStartedAt = yield* nowIso
		const attempts = options?.attempts ?? 0
		const resolved = resolveWebhookDispatchInvocation(message)
		if (!resolved.ok) {
			yield* runLog('record outcome', () =>
				recordWebhookDelivery({
					env,
					endpoint: message.endpoint,
					kodyId: message.packageKodyId,
					outcome: 'rejected',
					httpStatus: 400,
					error: resolved.code,
					payloadBytes: message.payloadBytes,
					invocationId: message.deliveryId,
					attempts,
					startedAt: dispatchStartedAt,
					receivedAt: message.receivedAt,
					logs: [
						{
							level: 'error',
							message: `Webhook dispatch rejected before invoke: ${resolved.code}`,
						},
					],
					requirePersistence: true,
				}),
			)
			return 'terminal' as const
		}
		const response = yield* invokeExport(() =>
			dispatchWebhookInvocation({
				env,
				endpoint: message.endpoint,
				packageKodyId: message.packageKodyId,
				exportName: message.exportName,
				params: resolved.params,
				idempotencyKey: message.idempotencyKey,
				claimOwner: message.deliveryId,
				...(message.idempotencyParamsHash === 'ignore'
					? { idempotencyParamsHash: 'ignore' as const }
					: {}),
				...(resolved.idempotencyHashParams
					? { idempotencyHashParams: resolved.idempotencyHashParams }
					: {}),
				executorTimeoutMs: backgroundExecutorTimeoutMs,
			}),
		)
		const retryableCode = readPreExecutionPackageInvocationInfrastructureCode({
			status: response.status,
			body: asInvocationResponseBody(response.body),
		})
		if (retryableCode) {
			if (attempts >= webhookDispatchMaxRetries) {
				const invocationError = readWebhookInvocationError(response.body)
				// Exhausted ack deliveries must land as a visible Activity failure
				// (not only a consumer log). requirePersistence throws into the
				// queue handler retry path when the write does not stick.
				yield* runLog('record outcome', () =>
					recordWebhookDelivery({
						env,
						endpoint: message.endpoint,
						kodyId: message.packageKodyId,
						outcome: 'failed',
						httpStatus: 502,
						error: 'invocation_retry_exhausted',
						payloadBytes: message.payloadBytes,
						invocationId: message.deliveryId,
						attempts,
						startedAt: dispatchStartedAt,
						receivedAt: message.receivedAt,
						invocationErrorCode: invocationError.code ?? retryableCode,
						invocationBody: response.body,
						logs: buildWebhookDispatchFailureLogs({
							httpStatus: response.status,
							body: response.body,
							exhausted: true,
							attempts,
						}),
						requirePersistence: true,
						request: response.request,
					}),
				)
				return 'terminal' as const
			}
			yield* runLog('mark retry', () =>
				markAckWebhookDelivery({
					env,
					delivery: ackDeliveryFromMessage(message),
					state: 'queued',
					holdMs: webhookAckQueuedHoldMs,
					attempts,
					lastError:
						readWebhookInvocationError(response.body).code ?? retryableCode,
				}),
			)
			return 'retry' as const
		}

		const ok = response.status >= 200 && response.status < 300
		const invocationError = readWebhookInvocationError(response.body)
		const placementRefused =
			!ok &&
			Boolean(readCredentialPlacementRefusalFromInvocationBody(response.body))
		yield* runLog('record outcome', () =>
			recordWebhookDelivery({
				env,
				endpoint: message.endpoint,
				kodyId: message.packageKodyId,
				outcome: ok ? 'delivered' : 'failed',
				httpStatus: ok ? 202 : 502,
				error: ok
					? null
					: placementRefused
						? credentialPlacementRefusedCode
						: `invocation_status_${response.status}`,
				payloadBytes: message.payloadBytes,
				invocationId: message.deliveryId,
				attempts,
				result: readWebhookInvocationResult(response.body),
				startedAt: dispatchStartedAt,
				receivedAt: message.receivedAt,
				...(ok
					? {}
					: {
							invocationErrorCode: placementRefused
								? credentialPlacementRefusedCode
								: invocationError.code,
							invocationBody: response.body,
							logs: buildWebhookDispatchFailureLogs({
								httpStatus: response.status,
								body: response.body,
							}),
						}),
				requirePersistence: true,
				request: response.request,
			}),
		)
		return 'terminal' as const
	},
)

const runLog = <A>(label: string, evaluate: () => PromiseLike<A> | A) =>
	outbound(`webhook dispatch: ${label}`, evaluate, {
		timeout: outboundTimeout.durableObject,
	})
const kv = <A>(label: string, evaluate: () => PromiseLike<A> | A) =>
	outbound(`webhook dispatch: ${label}`, evaluate, {
		timeout: outboundTimeout.kv,
	})
/** The executor has its own timeout; this only catches a call that never settles. */
const invokeExport = <A>(evaluate: () => PromiseLike<A> | A) =>
	outbound('webhook dispatch: invoke export', evaluate, {
		timeout: Duration.millis(backgroundExecutorTimeoutMs + 60_000),
	})
const nowIso = Effect.map(Clock.currentTimeMillis, (ms) =>
	new Date(ms).toISOString(),
)

type DispatchAttempt = {
	readonly queueMessage: Message<unknown>
	readonly message: WebhookDispatchQueueMessage
	readonly delivery: AckWebhookDelivery
	readonly attempts: number
	readonly attemptStartedAt: string
}

const retryDispatch: QueueDisposition = {
	kind: 'retry',
	delaySeconds: webhookDispatchRetryDelaySeconds,
}
const ackDispatch: QueueDisposition = { kind: 'ack' }

export function handleWebhookDispatchQueue(
	batch: MessageBatch<unknown>,
	env: Env,
) {
	return runEdge(
		settleQueueBatch({
			consumer: 'webhook-dispatch',
			messages: batch.messages,
			failureRetryDelaySeconds: webhookDispatchRetryDelaySeconds,
			decide: (queueMessage) => decideWebhookDispatch(queueMessage, env),
			onDecideFailure: (queueMessage, error) =>
				Effect.logError('webhook-dispatch-queue-processing-failed', {
					queueMessageId: queueMessage.id,
					error,
				}).pipe(Effect.as(retryDispatch)),
		}),
	)
}

const decideWebhookDispatch = Effect.fn('webhookDispatch.decide')(function* (
	queueMessage: Message<unknown>,
	env: Env,
) {
	const message = parseWebhookDispatchQueueMessage(queueMessage.body)
	if (!message) {
		yield* Effect.logError('webhook-dispatch-message-invalid', {
			queueMessageId: queueMessage.id,
		})
		return ackDispatch
	}
	const attempt: DispatchAttempt = {
		queueMessage,
		message,
		delivery: ackDeliveryFromMessage(message),
		attemptStartedAt: yield* nowIso,
		attempts: (message.priorAttempts ?? 0) + queueMessage.attempts,
	}
	const started = yield* runLog('start attempt', () =>
		startAckWebhookDeliveryAttempt({
			env,
			delivery: attempt.delivery,
			attempts: attempt.attempts,
		}),
	)
	if (!started && (message.deferrals ?? 0) < webhookDispatchMaxDeferrals) {
		return yield* deferForOwnerCap(attempt, env)
	}
	return yield* dispatchAttempt(attempt, env).pipe(
		Effect.catchCause((cause) =>
			processingFailure(attempt, env, Cause.squash(cause)),
		),
	)
})

const deferForOwnerCap = Effect.fn('webhookDispatch.deferForOwnerCap')(
	function* (
		{ queueMessage, message, delivery, attempts }: DispatchAttempt,
		env: Env,
	) {
		// Re-send instead of retry(): a retry counts toward max_retries, so a
		// long wait behind the owner's own backlog would dead-letter it.
		const deferrals = message.deferrals ?? 0
		const sent = yield* Effect.tryPromise({
			try: async () =>
				env.WEBHOOK_DISPATCH_QUEUE.send(
					{
						...message,
						deferrals: deferrals + 1,
						priorAttempts: attempts - 1,
					} satisfies WebhookDispatchQueueMessage,
					{ delaySeconds: ownerCapDeferralDelaySeconds(deferrals) },
				),
			catch: (cause) =>
				new OutboundCallError({
					operation: 'webhook dispatch: re-send deferred message',
					reason: 'failed',
					message: cause instanceof Error ? cause.message : String(cause),
					cause,
				}),
		}).pipe(
			Effect.as(true),
			Effect.catchTag('OutboundCallError', (error) =>
				Effect.logError('webhook-dispatch-deferral-send-failed', {
					queueMessageId: queueMessage.id,
					endpointId: message.endpoint.id,
					error: outboundCause(error),
				}).pipe(Effect.as(false)),
			),
		)
		if (!sent) return retryDispatch
		yield* runLog('mark deferred', () =>
			markAckWebhookDelivery({
				env,
				delivery,
				state: 'queued',
				holdMs: webhookAckQueuedHoldMs,
				attempts: attempts - 1,
			}),
		)
		return ackDispatch
	},
)

const dispatchAttempt = Effect.fn('webhookDispatch.dispatchAttempt')(function* (
	attempt: DispatchAttempt,
	env: Env,
) {
	const { queueMessage, message, attempts } = attempt
	const hydrated = yield* kv('load payload', () =>
		hydrateWebhookDispatchQueueMessage({
			message,
			kv: env.BUNDLE_ARTIFACTS_KV,
		}),
	)
	if (!hydrated) return yield* payloadMissing(attempt, env)
	const outcome = yield* processWebhookDispatchEffect(hydrated, env, {
		attempts,
	})
	if (outcome === 'retry') return retryDispatch
	const payloadKvKey = message.payloadKvKey
	if (!payloadKvKey) return ackDispatch
	return {
		kind: 'ack',
		afterAck: kv('delete payload', () =>
			deleteWebhookDispatchPayload({
				kv: env.BUNDLE_ARTIFACTS_KV,
				key: payloadKvKey,
			}),
		).pipe(
			Effect.catchTag('OutboundCallError', (error) =>
				Effect.logError('webhook-dispatch-payload-delete-failed', {
					queueMessageId: queueMessage.id,
					endpointId: message.endpoint.id,
					error: outboundCause(error),
				}),
			),
			Effect.forkDetach,
			Effect.asVoid,
		),
	} satisfies QueueDisposition
})

const payloadMissing = Effect.fn('webhookDispatch.payloadMissing')(function* (
	{ queueMessage, message, attempts }: DispatchAttempt,
	env: Env,
) {
	// A redelivery after success finds its spill already deleted; the
	// finished row is the answer, not a missing payload.
	const lookup = yield* runLog('read run record', () =>
		getRunRecord({
			env,
			userId: message.endpoint.userId,
			runId: message.deliveryId,
		}),
	).pipe(Effect.result)
	if (lookup._tag === 'Failure') {
		// Without the row we cannot tell a finished delivery from a lost
		// payload; recording a failure here would overwrite a delivered row.
		yield* Effect.logError('webhook-dispatch-run-record-read-failed', {
			queueMessageId: queueMessage.id,
			endpointId: message.endpoint.id,
			error: outboundCause(lookup.failure),
		})
		return retryDispatch
	}
	const existing = lookup.success
	if (existing && existing.run.status !== 'running') return ackDispatch
	yield* Effect.logError('webhook-dispatch-payload-missing', {
		queueMessageId: queueMessage.id,
		endpointId: message.endpoint.id,
		deliveryId: message.deliveryId,
	})
	const missingStartedAt = yield* nowIso
	return yield* runLog('record missing payload', () =>
		recordWebhookDelivery({
			env,
			endpoint: message.endpoint,
			kodyId: message.packageKodyId,
			outcome: 'failed',
			httpStatus: 502,
			error: 'ack_queue_payload_missing',
			payloadBytes: message.payloadBytes,
			invocationId: message.deliveryId,
			attempts,
			startedAt: missingStartedAt,
			receivedAt: message.receivedAt,
			logs: [
				{
					level: 'error',
					message:
						'Ack-queue spilled webhook body was missing from ephemeral storage.',
				},
			],
			requirePersistence: true,
		}),
	).pipe(
		Effect.as(ackDispatch),
		Effect.catchTag('OutboundCallError', (error) =>
			Effect.logError('webhook-dispatch-payload-missing-record-failed', {
				queueMessageId: queueMessage.id,
				endpointId: message.endpoint.id,
				error: outboundCause(error),
			}).pipe(Effect.as(ackDispatch)),
		),
	)
})

const processingFailure = Effect.fn('webhookDispatch.processingFailure')(
	function* (
		{
			queueMessage,
			message,
			delivery,
			attempts,
			attemptStartedAt,
		}: DispatchAttempt,
		env: Env,
		failure: unknown,
	) {
		const error =
			failure instanceof OutboundCallError ? outboundCause(failure) : failure
		yield* Effect.logError('webhook-dispatch-queue-processing-failed', {
			queueMessageId: queueMessage.id,
			endpointId: message.endpoint.id,
			error,
		})
		const lastError = `dispatch_processing_failed: ${
			error instanceof Error ? error.message : String(error)
		}`.slice(0, 500)
		if (attempts >= webhookDispatchMaxRetries) {
			const recorded = yield* runLog('record exhausted', () =>
				recordWebhookDelivery({
					env,
					endpoint: message.endpoint,
					kodyId: message.packageKodyId,
					outcome: 'failed',
					httpStatus: 502,
					error: 'invocation_retry_exhausted',
					payloadBytes: message.payloadBytes,
					invocationId: message.deliveryId,
					attempts,
					startedAt: attemptStartedAt,
					receivedAt: message.receivedAt,
					invocationErrorCode: 'dispatch_processing_failed',
					logs: [{ level: 'error', message: lastError }],
					requirePersistence: true,
				}),
			).pipe(
				Effect.as(true),
				Effect.catchTag('OutboundCallError', (recordError) =>
					Effect.logError('webhook-dispatch-exhausted-record-failed', {
						queueMessageId: queueMessage.id,
						endpointId: message.endpoint.id,
						error: outboundCause(recordError),
					}).pipe(Effect.as(false)),
				),
			)
			if (recorded) return ackDispatch
		}
		yield* runLog('mark retry', () =>
			markAckWebhookDelivery({
				env,
				delivery,
				state: 'queued',
				holdMs: webhookAckQueuedHoldMs,
				attempts,
				lastError,
			}),
		)
		return retryDispatch
	},
)

export { webhookDispatchQueueName }
