import { getAppBaseUrl } from '#worker/app-base-url.ts'
import { planEnablementRuns } from '#worker/enablements/run-gate.ts'
import { buildJsonErrorResponse } from '#worker/package-invocations/responses.ts'
import {
	invokePackageExport,
	type PackageInvocationResponse,
} from '#worker/package-invocations/service.ts'
import {
	deriveRequestContext,
	type EnablementRun,
} from '#worker/request-context/request-context.ts'
import { sanitizeInvocationErrorMessage } from '#worker/package-invocations/invocation-error-summary.ts'
import { resolveBackgroundMcpUser } from '#worker/identity/background-mcp-user.ts'
import { backgroundExecutorTimeoutMs } from '#mcp/executor-budgets.ts'
import {
	createRunRecordHandle,
	ensureRunRecordStarted,
	startWebhookDeliveryAttemptRecord,
	recordRunRecord,
	updateRunningRunRecordMetadata,
} from '#worker/run-records/service.ts'
import type {
	RunRecordContext,
	RunRecordLogInput,
} from '#worker/run-records/types.ts'
import type { RequestContext } from '@kody-internal/shared/request-context.ts'
import type {
	WebhookDeliveryInFlightState,
	WebhookDeliveryOutcome,
	WebhookDeliveryState,
	WebhookEndpointRecord,
} from './types.ts'
import { describeWebhookNotOn } from './approval.ts'

type WebhookDeliveryEndpoint = Pick<
	WebhookEndpointRecord,
	'id' | 'userId' | 'packageId' | 'webhookName'
>

const webhookDeliveryStateByOutcome = {
	delivered: 'succeeded',
	rejected: 'rejected',
	failed: 'failed',
} as const satisfies Record<WebhookDeliveryOutcome, WebhookDeliveryState>

/**
 * How long an accepted or queued ack delivery keeps its `running` row before
 * the RunLog marks it interrupted: shared-queue backlog plus the consumer's
 * retry budget. A late finish still replaces the interrupt with the outcome.
 */
export const webhookAckQueuedHoldMs = 60 * 60 * 1000
/** A started attempt runs at most the background budget, plus persistence. */
export const webhookAckStartedHoldMs =
	backgroundExecutorTimeoutMs + 5 * 60 * 1000

function webhookDeliveryRunContext(input: {
	endpoint: WebhookDeliveryEndpoint
	kodyId: string
	invocationId: string
	metadata: Record<string, unknown>
}): RunRecordContext {
	return {
		surface: 'webhook',
		name: input.endpoint.webhookName,
		packageId: input.endpoint.packageId,
		kodyId: input.kodyId,
		invocationId: input.invocationId,
		metadata: { endpointId: input.endpoint.id, ...input.metadata },
	}
}

export type AckWebhookDelivery = {
	endpoint: WebhookDeliveryEndpoint
	kodyId: string
	deliveryId: string
	payloadBytes: number
	receivedAt: string
}

/**
 * How many ack deliveries one owner may have started at once. The dispatch
 * consumer runs 16 at a time for everyone, so this leaves most of it to other
 * owners when one owner's webhook floods.
 */
export const webhookAckOwnerStartedLimit = 4

/**
 * Mark an ack delivery `started` unless the owner already has
 * {@link webhookAckOwnerStartedLimit} other deliveries started. Returns false
 * when the owner is at the limit; the row is left as it was. Never throws.
 */
export async function startAckWebhookDeliveryAttempt(input: {
	env: Env
	delivery: AckWebhookDelivery
	attempts?: number
}): Promise<boolean> {
	const handle = await ackWebhookDeliveryRunHandle({
		...input,
		state: 'started',
	})
	const { started } = await startWebhookDeliveryAttemptRecord({
		env: input.env,
		handle,
		staleAfter: new Date(Date.now() + webhookAckStartedHoldMs).toISOString(),
		limit: webhookAckOwnerStartedLimit,
	})
	return started
}

/**
 * Write an ack delivery's in-flight state onto its run row (id = deliveryId),
 * so Activity and `webhookDeliveryList` show it from the moment Kody accepts
 * it. `accepted` inserts the row; later states update it and extend its hold.
 * A row that already finished is left alone. Never throws.
 */
async function ackWebhookDeliveryRunHandle(input: {
	env: Env
	delivery: AckWebhookDelivery
	state: WebhookDeliveryInFlightState
	attempts?: number
	lastError?: string | null
	enablement?: EnablementRun
}) {
	const { delivery } = input
	const request = input.enablement
		? await webhookRequestForEnablement({
				env: input.env,
				endpoint: delivery.endpoint,
				enablement: input.enablement,
			}).catch(() => null)
		: null
	return createRunRecordHandle({
		env: input.env,
		userId: delivery.endpoint.userId,
		request,
		id: delivery.deliveryId,
		startedAt: delivery.receivedAt,
		context: webhookDeliveryRunContext({
			endpoint: delivery.endpoint,
			kodyId: delivery.kodyId,
			invocationId: delivery.deliveryId,
			metadata: {
				httpStatus: 202,
				payloadBytes: delivery.payloadBytes,
				receivedAt: delivery.receivedAt,
				state: input.state,
				...(input.attempts ? { attempts: input.attempts } : {}),
				...(input.lastError ? { lastError: input.lastError } : {}),
			},
		}),
	})
}

export async function markAckWebhookDelivery(input: {
	env: Env
	delivery: AckWebhookDelivery
	state: WebhookDeliveryInFlightState
	holdMs: number
	attempts?: number
	lastError?: string | null
	enablement?: EnablementRun
}): Promise<boolean> {
	const handle = await ackWebhookDeliveryRunHandle(input)
	const started = await ensureRunRecordStarted({
		env: input.env,
		handle,
		staleAfter: new Date(Date.now() + input.holdMs).toISOString(),
	})
	if (!started || input.state === 'accepted') return started
	return await updateRunningRunRecordMetadata({ env: input.env, handle })
}

export async function recordWebhookDelivery(input: {
	env: Env
	endpoint: WebhookDeliveryEndpoint
	kodyId: string
	outcome: WebhookDeliveryOutcome
	httpStatus: number
	error?: string | null
	payloadBytes: number
	/** Also the run id, so an ack delivery finishes the row it wrote at accept. */
	invocationId?: string
	/** Queue delivery attempt that reached this outcome. */
	attempts?: number
	/** Handler return value from the bound package export (bounded on finish). */
	result?: unknown
	startedAt: string
	/**
	 * Ingress receive time when it differs from `startedAt` (ack queue lag).
	 * Stored under metadata so Activity duration measures dispatch work, not
	 * provider→queue wait.
	 */
	receivedAt?: string
	/** Underlying package-invocation error code when the export failed. */
	invocationErrorCode?: string | null
	/**
	 * Bound export's invocation response body. On failure its error message
	 * (sanitized) is copied into the webhook run's error and logs, so
	 * Activity shows why the export failed instead of only the HTTP status.
	 */
	invocationBody?: unknown
	logs?: Array<RunRecordLogInput>
	waitUntil?: (promise: Promise<unknown>) => void
	requirePersistence?: boolean
	/** Platform-marked synthetic smoke test (interactive MCP only). */
	synthetic?: boolean
	/** Prefer an already-derived request when the caller has one. */
	request?: RequestContext | null
}) {
	const status = input.outcome === 'delivered' ? 'success' : 'error'
	const failure =
		status === 'error'
			? describeWebhookDeliveryFailure({
					error: input.error ?? null,
					invocationBody: input.invocationBody,
				})
			: null
	const request =
		input.request ??
		(await resolveWebhookDeliveryRequest({
			env: input.env,
			endpoint: input.endpoint,
		}))
	const invocationId = input.invocationId ?? crypto.randomUUID()
	const record = await recordRunRecord({
		env: input.env,
		userId: input.endpoint.userId,
		request,
		id: invocationId,
		context: webhookDeliveryRunContext({
			endpoint: input.endpoint,
			kodyId: input.kodyId,
			invocationId,
			metadata: {
				httpStatus: input.httpStatus,
				payloadBytes: input.payloadBytes,
				outcome: input.outcome,
				state: webhookDeliveryStateByOutcome[input.outcome],
				...(input.attempts ? { attempts: input.attempts } : {}),
				...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
				...(input.invocationErrorCode
					? { invocationErrorCode: input.invocationErrorCode }
					: {}),
				...(input.synthetic === true ? { synthetic: true } : {}),
			},
		}),
		status,
		error: failure?.error ?? input.error ?? undefined,
		result: input.result,
		logs:
			failure?.log != null ? [...(input.logs ?? []), failure.log] : input.logs,
		startedAt: input.startedAt,
		waitUntil: input.waitUntil,
	})
	if (!record && input.requirePersistence) {
		throw new Error('Webhook delivery record was not persisted.')
	}
	return record
}

/**
 * Request for a webhook delivery run. Prefer an enablement the caller already
 * chose (the one that invoked); only re-plan when recording a delivery that
 * never invoked (rejects, missing payload).
 */
async function resolveWebhookDeliveryRequest(input: {
	env: Env
	endpoint: Pick<WebhookEndpointRecord, 'id' | 'userId' | 'packageId'>
	enablement?: EnablementRun | null
}): Promise<RequestContext | null> {
	try {
		const enablement =
			input.enablement ??
			(
				await planEnablementRuns({
					env: input.env,
					orgId: input.endpoint.userId,
					packageId: input.endpoint.packageId,
					trigger: { kind: 'webhook', instanceId: input.endpoint.id },
				})
			).runs[0]
		if (!enablement) return null
		return await webhookRequestForEnablement({
			env: input.env,
			endpoint: input.endpoint,
			enablement,
		})
	} catch {
		return null
	}
}

async function webhookRequestForEnablement(input: {
	env: Env
	endpoint: Pick<WebhookEndpointRecord, 'id' | 'userId'>
	enablement: EnablementRun
}): Promise<RequestContext> {
	const user = await resolveBackgroundMcpUser(
		input.env.APP_DB,
		input.endpoint.userId,
	)
	return deriveRequestContext({
		user,
		source: {
			kind: 'webhook',
			sourceId: input.endpoint.id,
			enablement: input.enablement,
		},
	})
}

export function describeWebhookDeliveryFailure(input: {
	error: string | null
	invocationBody?: unknown
}): {
	error: { name: string; message: string }
	log: RunRecordLogInput
} | null {
	const invocationError = readWebhookInvocationError(input.invocationBody)
	if (!invocationError.message) return null
	const detail = sanitizeInvocationErrorMessage(invocationError.message)
	if (!detail) return null
	const code = input.error ?? invocationError.code ?? 'invocation_failed'
	return {
		error: { name: code, message: `${code}: ${detail}` },
		log: {
			level: 'error',
			message: `Export error: ${detail}`,
			...(invocationError.code
				? { fields: { code: invocationError.code } }
				: {}),
		},
	}
}

export function readWebhookInvocationResult(body: unknown): unknown {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined
	return (body as Record<string, unknown>)['result']
}

export function readWebhookInvocationError(body: unknown): {
	code: string | null
	message: string | null
} {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return { code: null, message: null }
	}
	const error = (body as Record<string, unknown>)['error']
	if (!error || typeof error !== 'object' || Array.isArray(error)) {
		return { code: null, message: null }
	}
	const record = error as Record<string, unknown>
	return {
		code: typeof record['code'] === 'string' ? record['code'] : null,
		message: typeof record['message'] === 'string' ? record['message'] : null,
	}
}

export function buildWebhookDispatchFailureLogs(input: {
	httpStatus: number
	body: unknown
	exhausted?: boolean
	attempts?: number
}): Array<RunRecordLogInput> {
	const invocationError = readWebhookInvocationError(input.body)
	const logs: Array<RunRecordLogInput> = [
		{
			level: 'error',
			message: input.exhausted
				? `Webhook dispatch gave up after ${input.attempts ?? 'max'} retries.`
				: `Webhook export invocation failed with HTTP ${input.httpStatus}.`,
		},
	]
	if (invocationError.code) {
		logs.push({
			level: 'error',
			message: `Invocation error code: ${invocationError.code}`,
			fields: {
				code: invocationError.code,
			},
		})
	}
	return logs
}

type WebhookInvocationInput = {
	env: Env
	baseUrl?: string
	endpoint: Pick<
		WebhookEndpointRecord,
		'id' | 'userId' | 'packageId' | 'webhookName'
	>
	packageKodyId: string
	exportName: string
	params: Record<string, unknown>
	idempotencyKey: string
	idempotencyParamsHash?: 'ignore'
	idempotencyHashParams?: Record<string, unknown>
	/**
	 * Ack-queue `deliveryId` (stable across Queue retries). Lets the same
	 * delivery take over its own dead idempotency claim without waiting the
	 * full ledger stale window; genuine sender duplicates keep distinct ids.
	 */
	claimOwner?: string | null
	/** Ack-queue deliveries pass the background budget; sync omits it. */
	executorTimeoutMs?: number
}

/**
 * Invocation response plus the request for the enablement that ran. Pass
 * `request` into {@link recordWebhookDelivery} so started_by matches the
 * invoke instead of re-planning (which can pick a different first enabler).
 */
export type WebhookInvocationDispatch = PackageInvocationResponse & {
	request: RequestContext | null
}

/**
 * Run a webhook's bound export as the endpoint's enabler. With no on
 * enablement (paused, off, or never approved) nothing runs and the delivery
 * fails with 409 `enablement_not_on`, carrying the approval link.
 */
export async function dispatchWebhookInvocation(
	input: WebhookInvocationInput,
): Promise<WebhookInvocationDispatch> {
	const plan = await planEnablementRuns({
		env: input.env,
		orgId: input.endpoint.userId,
		packageId: input.endpoint.packageId,
		trigger: { kind: 'webhook', instanceId: input.endpoint.id },
	})
	const [run] = plan.runs
	if (!run) {
		const notOn = await describeWebhookNotOn({
			env: input.env,
			baseUrl: input.baseUrl ?? getAppBaseUrl({ env: input.env }),
			endpoint: input.endpoint,
			packageKodyId: input.packageKodyId,
			plan,
		})
		return {
			...buildJsonErrorResponse({
				status: 409,
				code: 'enablement_not_on',
				message: notOn.message,
				idempotencyKey: input.idempotencyKey,
				...(notOn.approvalUrl
					? { details: { approvalUrl: notOn.approvalUrl } }
					: {}),
			}),
			request: null,
		}
	}
	const request = await webhookRequestForEnablement({
		env: input.env,
		endpoint: input.endpoint,
		enablement: run,
	}).catch(() => null)
	const response = await invokeWebhookExport(
		input,
		run,
		`${input.idempotencyKey}:enablement:${run.id}`,
	)
	return { ...response, request }
}

async function invokeWebhookExport(
	input: WebhookInvocationInput,
	enablement: EnablementRun,
	idempotencyKey: string,
) {
	return await invokePackageExport({
		env: input.env,
		baseUrl: input.baseUrl ?? getAppBaseUrl({ env: input.env }),
		token: {
			tokenId: `internal:webhook:${input.endpoint.id}`,
			userId: input.endpoint.userId,
			packageId: input.endpoint.packageId,
			exportNames: [input.exportName],
			request: {
				kind: 'webhook',
				sourceId: input.endpoint.id,
				enablement,
			},
		},
		request: {
			packageIdOrKodyId: input.endpoint.packageId,
			exportName: input.exportName,
			params: input.params,
			idempotencyKey,
			...(input.idempotencyParamsHash === 'ignore'
				? { idempotencyParamsHash: 'ignore' as const }
				: {}),
			...(input.idempotencyHashParams
				? { idempotencyHashParams: input.idempotencyHashParams }
				: {}),
			...(input.claimOwner ? { claimOwner: input.claimOwner } : {}),
			source: 'webhook',
			topic: `webhook:${input.packageKodyId}:${input.endpoint.webhookName}`,
		},
		executionTarget: { kind: 'webhook', name: input.endpoint.webhookName },
		...(input.executorTimeoutMs === undefined
			? {}
			: { executorTimeoutMs: input.executorTimeoutMs }),
	})
}
