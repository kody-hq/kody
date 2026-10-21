import {
	maxRestorableTextColumnBytes,
	utf8ByteLength,
} from '@kody-internal/shared/backup-restore-safety.ts'

/**
 * Replay-cache ceiling for the ledger's `response_json`. The ledger lives in
 * the per-user RunLog Durable Object now, but the bound is kept at the
 * restore-safe D1 column ceiling it inherited: replay payloads above it were
 * never stored, so the DO rows stay small and export sections stay pageable.
 * Oversized terminal responses are stored as NULL; idempotent duplicates of
 * those invocations get the existing `idempotency_response_unavailable`
 * outcome instead of a replay.
 */
export const maxStoredInvocationResponseJsonBytes = maxRestorableTextColumnBytes

export type PackageInvocationStoredResponse = {
	status: number
	body: Record<string, unknown>
}

/**
 * Serialize a terminal response for the RunLog DO ledger's replay cache,
 * dropping it when oversized.
 */
export function boundedResponseJson(
	response: PackageInvocationStoredResponse,
): string | null {
	const responseJson = JSON.stringify({
		status: response.status,
		body: response.body,
	})
	if (utf8ByteLength(responseJson) > maxStoredInvocationResponseJsonBytes) {
		return null
	}
	return responseJson
}

/**
 * Non-null ledger marker when execute succeeded but the response was too large
 * to cache. Staging must never write SQL NULL for a completed execute: a null
 * `response_json` looks like an unfinished claim and same-owner reclaim would
 * re-run side effects. Promote strips this sentinel back to NULL on the
 * terminal completed row (same as a normal oversized finish).
 */
export const packageInvocationStagedOversizedFenceJson =
	'{"kody":"staged_oversized"}'

/** Always-non-null payload for staging an execute outcome onto `in_progress`. */
export function executionFenceResponseJson(bounded: string | null): string {
	return bounded ?? packageInvocationStagedOversizedFenceJson
}

/** Map a staged fence payload back to the terminal ledger `response_json`. */
export function terminalResponseJsonFromExecutionFence(
	value: string | null,
): string | null {
	if (value == null || value === packageInvocationStagedOversizedFenceJson) {
		return null
	}
	return value
}

export function parseStoredResponse(
	value: string | null,
): PackageInvocationStoredResponse | null {
	if (!value) return null
	try {
		const parsed = JSON.parse(value) as unknown
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return null
		}
		const record = parsed as Record<string, unknown>
		const status = record['status']
		const body = record['body']
		if (
			typeof status !== 'number' ||
			!Number.isInteger(status) ||
			!body ||
			typeof body !== 'object' ||
			Array.isArray(body)
		) {
			return null
		}
		return {
			status,
			body: body as Record<string, unknown>,
		}
	} catch {
		return null
	}
}
