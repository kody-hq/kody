import { canonicalJsonStringify } from '@kody-internal/shared/canonical-json.ts'
import { toHex } from '@kody-internal/shared/hex.ts'
import { buildJsonErrorResponse } from './responses.ts'
import type { PackageInvocationStoredResponse } from './repo.ts'

/**
 * The fields `resolveExistingInvocation` needs from a RunLog DO ledger
 * record (mapped from `PackageInvocationLedgerRecord` at the call site).
 */
export type ResolvableInvocationRecord = {
	requestHash: string
	status: string
	storedResponse: PackageInvocationStoredResponse | null
}

export function markStoredResponseAsReplayed(
	response: PackageInvocationStoredResponse,
) {
	const body = structuredClone(response.body)
	const record = body as Record<string, unknown>
	const existingIdempotency = record['idempotency']
	if (existingIdempotency && typeof existingIdempotency === 'object') {
		record['idempotency'] = {
			...(existingIdempotency as Record<string, unknown>),
			replayed: true,
		}
	} else {
		record['idempotency'] = { replayed: true }
	}
	return {
		status: response.status,
		body,
	} satisfies PackageInvocationStoredResponse
}

export async function createRequestHash(input: {
	packageId: string
	exportName: string
	params?: Record<string, unknown>
	source: string | null
	topic: string | null
}) {
	const canonical = canonicalJsonStringify(input)
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonical),
	)
	return toHex(new Uint8Array(digest))
}

function buildIdempotencyResponseUnavailable(input: {
	idempotencyKey: string
}) {
	return buildJsonErrorResponse({
		status: 409,
		code: 'idempotency_response_unavailable',
		message:
			'This idempotency key already has a terminal invocation record, but its stored response could not be replayed.',
		idempotencyKey: input.idempotencyKey,
	})
}

export function resolveExistingInvocation(input: {
	record: ResolvableInvocationRecord
	requestHash: string
	idempotencyKey: string
	paramsHash?: 'include' | 'ignore'
}): PackageInvocationStoredResponse {
	if (
		input.paramsHash !== 'ignore' &&
		input.record.requestHash !== input.requestHash
	) {
		return buildJsonErrorResponse({
			status: 409,
			code: 'idempotency_mismatch',
			message:
				'This idempotency key has already been used for a different package invocation request.',
			idempotencyKey: input.idempotencyKey,
		})
	}
	if (input.record.status === 'in_progress') {
		return buildJsonErrorResponse({
			status: 409,
			code: 'invocation_in_progress',
			message:
				'This idempotency key is already processing for the requested package export.',
			idempotencyKey: input.idempotencyKey,
		})
	}
	if (input.record.storedResponse) {
		if (input.paramsHash === 'ignore') {
			return input.record.storedResponse
		}
		return markStoredResponseAsReplayed(input.record.storedResponse)
	}
	return buildIdempotencyResponseUnavailable({
		idempotencyKey: input.idempotencyKey,
	})
}
