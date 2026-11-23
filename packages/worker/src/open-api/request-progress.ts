import { withDeadline } from '#worker/outbound/with-deadline.ts'
import { reportHandledError } from '#worker/outbound/typed-failure.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import {
	apiRequestProgressKvKey,
	apiRequestProgressSteps,
	isApiRequestId,
	parseApiRequestProgress,
	type ApiRequestProgress,
} from '@kody-internal/shared/api-request-progress.ts'

const progressKvDeadlineMs = 2_000

type ApiRequestProgressScope = { requestId: string; kv: KVNamespace }

const apiRequestProgressStorage =
	new AsyncLocalStorage<ApiRequestProgressScope>()

/** Short-lived: only the edge's 503 right after an origin failure reads it. */
const progressTtlSeconds = 300

function progressKv(env: Env) {
	return (env as Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace })
		.BUNDLE_ARTIFACTS_KV
}

/**
 * Bind the edge's request id for this `KodyApi` request so long operations
 * can record their step with {@link recordApiRequestProgress}.
 */
export async function runWithApiRequestProgress<T>(
	input: { env: Env; requestId: string | null },
	callback: () => Promise<T>,
): Promise<T> {
	const kv = progressKv(input.env)
	if (!kv || !isApiRequestId(input.requestId)) return await callback()
	return await apiRequestProgressStorage.run(
		{ requestId: input.requestId, kv },
		callback,
	)
}

/**
 * Best effort and awaited, so the step is stored before the CPU-heavy work
 * after it starts. One key per step: KV allows one write per key per second.
 */
export async function recordApiRequestProgress(progress: ApiRequestProgress) {
	const scope = apiRequestProgressStorage.getStore()
	if (!scope) return
	try {
		await withDeadline(
			{ label: 'api_request_progress.write', timeoutMs: progressKvDeadlineMs },
			() =>
				scope.kv.put(
					apiRequestProgressKvKey(scope.requestId, progress.step),
					JSON.stringify(progress),
					{ expirationTtl: progressTtlSeconds },
				),
		)
	} catch (error) {
		reportHandledError('api_request_progress.write', error)
	}
}

/** The last step a request recorded, or null when it recorded none. */
export async function readApiRequestProgress(input: {
	env: Env
	requestId: string
}): Promise<ApiRequestProgress | null> {
	const kv = progressKv(input.env)
	if (!kv || !isApiRequestId(input.requestId)) return null
	const recorded = await Promise.all(
		apiRequestProgressSteps.map((step) =>
			withDeadline(
				{ label: 'api_request_progress.read', timeoutMs: progressKvDeadlineMs },
				() => kv.get(apiRequestProgressKvKey(input.requestId, step), 'json'),
			).catch((error: unknown) => {
				reportHandledError('api_request_progress.read', error)
				return null
			}),
		),
	)
	for (let index = recorded.length - 1; index >= 0; index -= 1) {
		const progress = parseApiRequestProgress(recorded[index])
		if (progress) return progress
	}
	return null
}
