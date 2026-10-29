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
import { recordRunRecord } from '#worker/run-records/service.ts'
import { type RunRecordLogInput } from '#worker/run-records/types.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	type WebhookDeliveryOutcome,
	type WebhookEndpointRecord,
} from './types.ts'
import { describeWebhookNotOn } from './approval.ts'

export async function recordWebhookDelivery(input: {
	env: Env
	endpoint: Pick<
		WebhookEndpointRecord,
		'id' | 'userId' | 'packageId' | 'webhookName'
	>
	kodyId: string
	outcome: WebhookDeliveryOutcome
	httpStatus: number
	error?: string | null
	payloadBytes: number
	invocationId?: string
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
	const record = await recordRunRecord({
		env: input.env,
		userId: input.endpoint.userId,
		request,
		context: {
			surface: 'webhook',
			name: input.endpoint.webhookName,
			packageId: input.endpoint.packageId,
			kodyId: input.kodyId,
			invocationId: input.invocationId ?? crypto.randomUUID(),
			metadata: {
				endpointId: input.endpoint.id,
				httpStatus: input.httpStatus,
				payloadBytes: input.payloadBytes,
				outcome: input.outcome,
				...(input.receivedAt ? { receivedAt: input.receivedAt } : {}),
				...(input.invocationErrorCode
					? { invocationErrorCode: input.invocationErrorCode }
					: {}),
				...(input.synthetic === true ? { synthetic: true } : {}),
			},
		},
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
