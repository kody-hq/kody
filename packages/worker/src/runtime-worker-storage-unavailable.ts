import {
	classifyRetryableD1Error,
	isRetryableD1StorageUnavailabilityError,
	readD1RetryAttempts,
	transientDatabaseUnavailableMessage,
} from '#worker/d1-retry.ts'
import { reportInfraHiccup } from '#worker/infra-hiccup-sentry.ts'

const retryAfterSeconds = '5'

/**
 * Runs a `kody-runtime` request and answers a D1 storage blip (overload,
 * lock, export, network drop) with a retryable 503 instead of an uncaught
 * exception, which Cloudflare renders as a 1101 page through the origin
 * forward. Every other error still throws.
 */
export async function respondToRuntimeStorageUnavailable(
	run: () => Promise<Response>,
): Promise<Response> {
	try {
		return await run()
	} catch (error) {
		if (!isRetryableD1StorageUnavailabilityError(error)) throw error
		void reportInfraHiccup({
			kind: 'd1_transient',
			operation: 'runtime_worker_fetch',
			attempts: readD1RetryAttempts(error),
			errorClass: classifyRetryableD1Error(error) ?? 'unknown',
		})
		return new Response(transientDatabaseUnavailableMessage, {
			status: 503,
			headers: {
				'Cache-Control': 'no-store',
				'Content-Type': 'text/plain; charset=utf-8',
				'Retry-After': retryAfterSeconds,
			},
		})
	}
}
