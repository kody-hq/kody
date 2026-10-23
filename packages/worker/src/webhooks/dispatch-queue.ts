import {
	credentialPlacementRefusedCode,
	readCredentialPlacementRefusalFromInvocationBody,
} from '#worker/credentials/placement-refusal.ts'
import { backgroundExecutorTimeoutMs } from '#mcp/executor-budgets.ts'
import { readPreExecutionPackageInvocationInfrastructureCode } from '#worker/package-invocations/infrastructure-codes.ts'
import {
	buildWebhookDispatchFailureLogs,
	dispatchWebhookInvocation,
	readWebhookInvocationError,
	readWebhookInvocationResult,
	recordWebhookDelivery,
} from './delivery.ts'
import {
	deleteWebhookDispatchPayload,
	hydrateWebhookDispatchQueueMessage,
} from './dispatch-payload-store.ts'
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
		await recordWebhookDelivery({
			env,
			endpoint: message.endpoint,
			kodyId: message.packageKodyId,
			outcome: 'rejected',
			httpStatus: 400,
			error: resolved.code,
			payloadBytes: message.payloadBytes,
			invocationId: message.deliveryId,
			startedAt: dispatchStartedAt,
			receivedAt: message.receivedAt,
			logs: [
				{
					level: 'error',
					message: `Webhook dispatch rejected before invoke: ${resolved.code}`,
				},
			],
			requirePersistence: true,
		})
		return 'terminal'
	}
	const response = await dispatchWebhookInvocation({
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
	})
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
			await recordWebhookDelivery({
				env,
				endpoint: message.endpoint,
				kodyId: message.packageKodyId,
				outcome: 'failed',
				httpStatus: 502,
				error: 'invocation_retry_exhausted',
				payloadBytes: message.payloadBytes,
				invocationId: message.deliveryId,
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
			})
			return 'terminal'
		}
		return 'retry'
	}

	const ok = response.status >= 200 && response.status < 300
	const invocationError = readWebhookInvocationError(response.body)
	const placementRefused =
		!ok &&
		Boolean(readCredentialPlacementRefusalFromInvocationBody(response.body))
	await recordWebhookDelivery({
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
	})
	return 'terminal'
}

export async function handleWebhookDispatchQueue(
	batch: MessageBatch<unknown>,
	env: Env,
) {
	for (const queueMessage of batch.messages) {
		const message = parseWebhookDispatchQueueMessage(queueMessage.body)
		if (!message) {
			console.error('webhook-dispatch-message-invalid', {
				queueMessageId: queueMessage.id,
			})
			queueMessage.ack()
			continue
		}
		try {
			const hydrated = await hydrateWebhookDispatchQueueMessage({
				message,
				kv: env.BUNDLE_ARTIFACTS_KV,
			})
			if (!hydrated) {
				console.error('webhook-dispatch-payload-missing', {
					queueMessageId: queueMessage.id,
					endpointId: message.endpoint.id,
					deliveryId: message.deliveryId,
				})
				const missingStartedAt = new Date().toISOString()
				try {
					await recordWebhookDelivery({
						env,
						endpoint: message.endpoint,
						kodyId: message.packageKodyId,
						outcome: 'failed',
						httpStatus: 502,
						error: 'ack_queue_payload_missing',
						payloadBytes: message.payloadBytes,
						invocationId: message.deliveryId,
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
					})
				} catch (error) {
					console.error('webhook-dispatch-payload-missing-record-failed', {
						queueMessageId: queueMessage.id,
						endpointId: message.endpoint.id,
						error,
					})
					queueMessage.retry({
						delaySeconds: webhookDispatchRetryDelaySeconds,
					})
					continue
				}
				queueMessage.ack()
				continue
			}
			const outcome = await processWebhookDispatch(hydrated, env, {
				attempts: queueMessage.attempts,
			})
			if (outcome === 'retry') {
				queueMessage.retry({ delaySeconds: webhookDispatchRetryDelaySeconds })
			} else {
				queueMessage.ack()
				if (message.payloadKvKey) {
					await deleteWebhookDispatchPayload({
						kv: env.BUNDLE_ARTIFACTS_KV,
						key: message.payloadKvKey,
					}).catch((error) => {
						console.error('webhook-dispatch-payload-delete-failed', {
							queueMessageId: queueMessage.id,
							endpointId: message.endpoint.id,
							error,
						})
					})
				}
			}
		} catch (error) {
			console.error('webhook-dispatch-queue-processing-failed', {
				queueMessageId: queueMessage.id,
				endpointId: message.endpoint.id,
				error,
			})
			queueMessage.retry({ delaySeconds: webhookDispatchRetryDelaySeconds })
		}
	}
}

export { webhookDispatchQueueName }
