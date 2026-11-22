import {
	deadlineFailure,
	parseJsonText,
} from '#worker/outbound/typed-failure.ts'
import {
	type DeadlineClock,
	withDeadline,
} from '#worker/outbound/with-deadline.ts'
import { publishBuildChunkScanDeadlineMs } from './policy.ts'

/** The scanner refused the chunk; the build is rejected. */
export type ChunkScanBlocked = {
	kind: 'chunk_scan_blocked'
	sha256: string
	reason: string
}

/** The scanner gave no usable verdict; the build stays `uploading`. */
export type ChunkScanUnavailable =
	| { kind: 'chunk_scan_unavailable'; cause: 'http_status'; status: number }
	| {
			kind: 'chunk_scan_unavailable'
			cause: 'network_error' | 'timeout' | 'malformed_verdict'
			detail: string
	  }

function readVerdict(
	value: unknown,
): { verdict: 'allow' } | { verdict: 'block'; reason: string } | null {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return null
	}
	const body = value as Record<string, unknown>
	if (body.verdict === 'allow') return { verdict: 'allow' }
	if (body.verdict === 'block' && typeof body.reason === 'string') {
		return { verdict: 'block', reason: body.reason }
	}
	return null
}

/**
 * Asks the chunk scanner at `PUBLISH_CHUNK_SCAN_URL` whether a verified chunk
 * may be stored. It answers `{"verdict":"allow"}` or
 * `{"verdict":"block","reason":"..."}`; anything else is unavailable.
 */
export async function scanPublishBuildChunk(input: {
	url: string
	buildId: string
	sha256: string
	bytes: number
	clock?: DeadlineClock
}): Promise<{ kind: 'allow' } | ChunkScanBlocked | ChunkScanUnavailable> {
	let answer: { ok: boolean; status: number; text: string }
	try {
		answer = await withDeadline(
			{
				label: 'publish_build_chunk.scan',
				timeoutMs: publishBuildChunkScanDeadlineMs,
				clock: input.clock,
			},
			async (signal) => {
				const response = await fetch(input.url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						buildId: input.buildId,
						sha256: input.sha256,
						bytes: input.bytes,
					}),
					signal,
				})
				return {
					ok: response.ok,
					status: response.status,
					text: await response.text(),
				}
			},
		)
	} catch (error) {
		const expired = deadlineFailure(error)
		if (expired) {
			return {
				kind: 'chunk_scan_unavailable',
				cause: 'timeout',
				detail: `no answer within ${expired.timeoutMs}ms`,
			}
		}
		return {
			kind: 'chunk_scan_unavailable',
			cause: 'network_error',
			detail: error instanceof Error ? error.message : String(error),
		}
	}
	if (!answer.ok) {
		return {
			kind: 'chunk_scan_unavailable',
			cause: 'http_status',
			status: answer.status,
		}
	}
	const parsed = parseJsonText(answer.text)
	const verdict = parsed.kind === 'ok' ? readVerdict(parsed.value) : null
	if (!verdict) {
		return {
			kind: 'chunk_scan_unavailable',
			cause: 'malformed_verdict',
			detail: 'the scanner answer is not a verdict',
		}
	}
	if (verdict.verdict === 'block') {
		return {
			kind: 'chunk_scan_blocked',
			sha256: input.sha256,
			reason: verdict.reason,
		}
	}
	return { kind: 'allow' }
}
