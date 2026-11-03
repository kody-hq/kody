import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { toJsonSafeValue } from '@kody-internal/shared/json-safe-value.ts'
import { getExecutionErrorDetails } from '#mcp/executor.ts'
import { isTransientDurableObjectResetError } from '#worker/durable-object-reset-retry.ts'
import type { SavedPackageRecord } from '#worker/package-registry/types.ts'
import { durableObjectResetInvocationErrorCode } from './infrastructure-codes.ts'
import type { PackageInvocationStoredResponse } from './repo.ts'

export function buildExecutionSuccessResponse(input: {
	savedPackage: SavedPackageRecord
	invocationName: string
	/** `null` for key-less (ephemeral) invocations, which have no ledger row. */
	idempotencyKey: string | null
	source: string | null
	topic: string | null
	result: unknown
	logs: Array<string>
	rawContent: Array<ContentBlock> | null
	rawContentOmitted: null | {
		note: string
		returnedBytes: number
		blockCount: number
	}
}): PackageInvocationStoredResponse {
	return {
		status: 200,
		body: {
			ok: true,
			package: {
				id: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
			},
			exportName: input.invocationName,
			source: input.source,
			topic: input.topic,
			...(input.idempotencyKey
				? {
						idempotency: {
							key: input.idempotencyKey,
							replayed: false,
						},
					}
				: {}),
			result: toJsonSafeValue(input.result),
			logs: input.logs,
			...(input.rawContent
				? { rawContent: toJsonSafeValue(input.rawContent) }
				: {}),
			...(input.rawContentOmitted
				? { rawContentOmitted: input.rawContentOmitted }
				: {}),
		},
	}
}

export function buildExecutionErrorResponse(input: {
	savedPackage: SavedPackageRecord
	invocationName: string
	/** `null` for key-less (ephemeral) invocations, which have no ledger row. */
	idempotencyKey: string | null
	source: string | null
	topic: string | null
	error: unknown
	logs: Array<string>
}): PackageInvocationStoredResponse {
	const message = getErrorMessage(input.error)
	const durableObjectReset = isTransientDurableObjectResetError(input.error)
	return {
		status: durableObjectReset ? 503 : 500,
		body: {
			ok: false,
			package: {
				id: input.savedPackage.id,
				kodyId: input.savedPackage.kodyId,
			},
			exportName: input.invocationName,
			source: input.source,
			topic: input.topic,
			...(input.idempotencyKey
				? {
						idempotency: {
							key: input.idempotencyKey,
							replayed: false,
						},
					}
				: {}),
			error: {
				code: durableObjectReset
					? durableObjectResetInvocationErrorCode
					: 'execution_failed',
				message,
				details: toJsonSafeValue(getExecutionErrorDetails(input.error)),
			},
			logs: input.logs,
		},
	}
}

export function buildJsonErrorResponse(input: {
	status: number
	code: string
	message: string
	idempotencyKey?: string
	replayed?: boolean
	details?: unknown
}) {
	return {
		status: input.status,
		body: {
			ok: false,
			error: {
				code: input.code,
				message: input.message,
				...(input.details !== undefined
					? { details: toJsonSafeValue(input.details) }
					: {}),
			},
			...(input.idempotencyKey
				? {
						idempotency: {
							key: input.idempotencyKey,
							replayed: input.replayed ?? false,
						},
					}
				: {}),
		},
	} satisfies PackageInvocationStoredResponse
}
