import {
	credentialPlacementRefusedCode,
	readCredentialPlacementRefusalFromInvocationBody,
} from '#worker/credentials/placement-refusal.ts'
import { backgroundExecutorTimeoutMs } from '#mcp/executor-budgets.ts'
import { readPreExecutionPackageInvocationInfrastructureCode } from '#worker/package-invocations/infrastructure-codes.ts'
import { getRunRecord } from '#worker/run-records/service.ts'
import { reportConsumerError } from '@kody-internal/shared/consumer-errors.ts'
import {
	type QueueDisposition,
	settleQueueBatch,
} from '@kody-internal/shared/queue-settlement.ts'
import {
	outboundTimeoutMs,
	withDeadline,
} from '@kody-internal/shared/with-deadline.ts'
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

export async function processWebhookDispatch(
	message: WebhookDispatchQueueMessage,
	env: Env,
	options?: { attempts?: number },
): Promise<'terminal' | 'retry'> {
	const dispatchStartedAt = new Date().toISOString()
	const attempts = options?.attempts ?? 0
	const resolved = resolveWebhookDispatchInvocation(message)
	if (!resolved.ok) {
		await withDeadline(runLogDeadline('record outcome'), () =>
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
		return 'terminal'
	}
	const response = await withDeadline(
		{
			label: 'webhook dispatch: invoke export',
			timeoutMs: webhookInvokeTimeoutMs,
		},
		() =>
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
			await withDeadline(runLogDeadline('record outcome'), () =>
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
			return 'terminal'
		}
		await withDeadline(runLogDeadline('mark retry'), () =>
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
		return 'retry'
	}

	const ok = response.status >= 200 && response.status < 300
	const invocationError = readWebhookInvocationError(response.body)
	const placementRefused =
		!ok &&
		Boolean(readCredentialPlacementRefusalFromInvocationBody(response.body))
	await withDeadline(runLogDeadline('record outcome'), () =>
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
	return 'terminal'
}

const runLogDeadline = (label: string) => ({
	label: `webhook dispatch: ${label}`,
	timeoutMs: outboundTimeoutMs.durableObject,
})
const kvDeadline = (label: string) => ({
	label: `webhook dispatch: ${label}`,
	timeoutMs: outboundTimeoutMs.kv,
})
const queueSendTimeoutMs = 30_000
/** The executor has its own timeout; this only catches a call that never settles. */
const webhookInvokeTimeoutMs = backgroundExecutorTimeoutMs + 60_000

type DispatchAttempt = {
	queueMessage: Message<unknown>
	message: WebhookDispatchQueueMessage
	delivery: AckWebhookDelivery
	attempts: number
	attemptStartedAt: string
}

const retryDispatch: QueueDisposition = {
	kind: 'retry',
	delaySeconds: webhookDispatchRetryDelaySeconds,
}

export async function handleWebhookDispatchQueue(
	batch: MessageBatch<unknown>,
	env: Env,
) {
	await settleQueueBatch({
		consumer: 'webhook-dispatch',
		messages: batch.messages,
		failureRetryDelaySeconds: webhookDispatchRetryDelaySeconds,
		decide: (queueMessage) => decideWebhookDispatch(queueMessage, env),
		onDecideFailure: async (queueMessage, error) => {
			reportConsumerError('webhook-dispatch-queue-processing-failed', {
				queueMessageId: queueMessage.id,
				error,
			})
			return retryDispatch
		},
	})
}

async function decideWebhookDispatch(
	queueMessage: Message<unknown>,
	env: Env,
): Promise<QueueDisposition> {
	const message = parseWebhookDispatchQueueMessage(queueMessage.body)
	if (!message) {
		reportConsumerError('webhook-dispatch-message-invalid', {
			queueMessageId: queueMessage.id,
		})
		return { kind: 'ack' }
	}
	const attempt: DispatchAttempt = {
		queueMessage,
		message,
		delivery: ackDeliveryFromMessage(message),
		attemptStartedAt: new Date().toISOString(),
		attempts: (message.priorAttempts ?? 0) + queueMessage.attempts,
	}
	const started = await withDeadline(runLogDeadline('start attempt'), () =>
		startAckWebhookDeliveryAttempt({
			env,
			delivery: attempt.delivery,
			attempts: attempt.attempts,
		}),
	)
	if (!started) return deferForOwnerCap(attempt, env)
	try {
		return await dispatchAttempt(attempt, env)
	} catch (error) {
		return processingFailure(attempt, env, error)
	}
}

async function deferForOwnerCap(
	{ queueMessage, message, delivery, attempts }: DispatchAttempt,
	env: Env,
): Promise<QueueDisposition> {
	// Re-send instead of retry(): a retry counts toward max_retries, so a
	// long wait behind the owner's own backlog would dead-letter it.
	const deferrals = message.deferrals ?? 0
	try {
		await withDeadline(
			{
				label: 'webhook dispatch: re-send deferred message',
				timeoutMs: queueSendTimeoutMs,
			},
			() =>
				env.WEBHOOK_DISPATCH_QUEUE.send(
					{
						...message,
						deferrals: deferrals + 1,
						priorAttempts: attempts - 1,
					} satisfies WebhookDispatchQueueMessage,
					{ delaySeconds: ownerCapDeferralDelaySeconds(deferrals) },
				),
		)
	} catch (error) {
		reportConsumerError('webhook-dispatch-deferral-send-failed', {
			queueMessageId: queueMessage.id,
			endpointId: message.endpoint.id,
			error,
		})
		return retryDispatch
	}
	await withDeadline(runLogDeadline('mark deferred'), () =>
		markAckWebhookDelivery({
			env,
			delivery,
			state: 'queued',
			holdMs: webhookAckQueuedHoldMs,
			attempts: attempts - 1,
		}),
	)
	return { kind: 'ack' }
}

async function dispatchAttempt(
	attempt: DispatchAttempt,
	env: Env,
): Promise<QueueDisposition> {
	const { queueMessage, message, attempts } = attempt
	const hydrated = await withDeadline(kvDeadline('load payload'), () =>
		hydrateWebhookDispatchQueueMessage({
			message,
			kv: env.BUNDLE_ARTIFACTS_KV,
		}),
	)
	if (!hydrated) return payloadMissing(attempt, env)
	const outcome = await processWebhookDispatch(hydrated, env, { attempts })
	if (outcome === 'retry') return retryDispatch
	const payloadKvKey = message.payloadKvKey
	if (!payloadKvKey) return { kind: 'ack' }
	return {
		kind: 'ack',
		afterAck: async () => {
			withDeadline(kvDeadline('delete payload'), () =>
				deleteWebhookDispatchPayload({
					kv: env.BUNDLE_ARTIFACTS_KV,
					key: payloadKvKey,
				}),
			).catch((error: unknown) => {
				reportConsumerError('webhook-dispatch-payload-delete-failed', {
					queueMessageId: queueMessage.id,
					endpointId: message.endpoint.id,
					error,
				})
			})
		},
	}
}

async function payloadMissing(
	{ queueMessage, message, attempts }: DispatchAttempt,
	env: Env,
): Promise<QueueDisposition> {
	// A redelivery after success finds its spill already deleted; the
	// finished row is the answer, not a missing payload.
	let existing: Awaited<ReturnType<typeof getRunRecord>>
	try {
		existing = await withDeadline(runLogDeadline('read run record'), () =>
			getRunRecord({
				env,
				userId: message.endpoint.userId,
				runId: message.deliveryId,
			}),
		)
	} catch (error) {
		// Without the row we cannot tell a finished delivery from a lost
		// payload; recording a failure here would overwrite a delivered row.
		reportConsumerError('webhook-dispatch-run-record-read-failed', {
			queueMessageId: queueMessage.id,
			endpointId: message.endpoint.id,
			error,
		})
		return retryDispatch
	}
	if (existing && existing.run.status !== 'running') return { kind: 'ack' }
	reportConsumerError('webhook-dispatch-payload-missing', {
		queueMessageId: queueMessage.id,
		endpointId: message.endpoint.id,
		deliveryId: message.deliveryId,
	})
	const missingStartedAt = new Date().toISOString()
	try {
		await withDeadline(runLogDeadline('record missing payload'), () =>
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
		)
	} catch (error) {
		reportConsumerError('webhook-dispatch-payload-missing-record-failed', {
			queueMessageId: queueMessage.id,
			endpointId: message.endpoint.id,
			error,
		})
		return retryDispatch
	}
	return { kind: 'ack' }
}

async function processingFailure(
	{
		queueMessage,
		message,
		delivery,
		attempts,
		attemptStartedAt,
	}: DispatchAttempt,
	env: Env,
	error: unknown,
): Promise<QueueDisposition> {
	reportConsumerError('webhook-dispatch-queue-processing-failed', {
		queueMessageId: queueMessage.id,
		endpointId: message.endpoint.id,
		error,
	})
	const lastError = `dispatch_processing_failed: ${
		error instanceof Error ? error.message : String(error)
	}`.slice(0, 500)
	if (attempts >= webhookDispatchMaxRetries) {
		try {
			await withDeadline(runLogDeadline('record exhausted'), () =>
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
			)
			return { kind: 'ack' }
		} catch (recordError) {
			reportConsumerError('webhook-dispatch-exhausted-record-failed', {
				queueMessageId: queueMessage.id,
				endpointId: message.endpoint.id,
				error: recordError,
			})
		}
	}
	await withDeadline(runLogDeadline('mark retry'), () =>
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
}

export { webhookDispatchQueueName }
