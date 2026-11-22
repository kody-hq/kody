import { Duration, Effect, Schema } from 'effect'
import { decodeOutbound, outbound } from '#worker/effect/outbound.ts'
import { WorkerEnv } from '#worker/effect/worker-env.ts'
import { ChunkScanUnavailable } from './errors.ts'

const operation = 'publish_build.chunk_scan'
const chunkScanTimeout = Duration.seconds(10)

const ChunkScanVerdict = Schema.Union([
	Schema.Struct({ verdict: Schema.Literal('allow') }),
	Schema.Struct({ verdict: Schema.Literal('block'), reason: Schema.String }),
])

export function chunkBlockedMessage(sha256: string, reason: string) {
	return `chunk ${sha256} blocked: ${reason}`
}

/**
 * Asks the scanner at `PUBLISH_CHUNK_SCAN_URL` whether a verified chunk may
 * be stored. Unset or empty skips the scan. Anything but a 2xx answer with a
 * verdict fails as `ChunkScanUnavailable`.
 */
export const scanPublishChunk = Effect.fn('PublishBuildChunkScan.scan')(
	function* (input: { buildId: string; sha256: string; bytes: number }) {
		const url = (yield* WorkerEnv).PUBLISH_CHUNK_SCAN_URL?.trim()
		if (!url) return { verdict: 'allow' } as const
		const response = yield* outbound(
			operation,
			async (signal) => {
				const response = await fetch(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						buildId: input.buildId,
						sha256: input.sha256,
						bytes: input.bytes,
					}),
					signal,
				})
				if (!response.ok) {
					await response.body?.cancel()
					return { status: response.status, text: null }
				}
				return { status: response.status, text: await response.text() }
			},
			{ timeout: chunkScanTimeout },
		)
		if (response.text === null) {
			return yield* new ChunkScanUnavailable({
				status: response.status,
				cause: `${operation} answered HTTP ${response.status}.`,
			})
		}
		return yield* decodeOutbound(
			operation,
			Schema.fromJsonString(ChunkScanVerdict),
		)(response.text)
	},
	Effect.catchTag('OutboundCallError', (error) =>
		Effect.fail(
			new ChunkScanUnavailable({ status: null, cause: error.message }),
		),
	),
)
