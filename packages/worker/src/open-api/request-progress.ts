import { AsyncLocalStorage } from 'node:async_hooks'
import {
	apiRequestProgressKvKey,
	isApiRequestId,
	packageCheckProgressSteps,
	parseApiRequestProgress,
	type ApiRequestProgress,
} from '@kody-internal/shared/api-request-progress.ts'

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
		await scope.kv.put(
			apiRequestProgressKvKey(scope.requestId, progress.step),
			JSON.stringify(progress),
			{ expirationTtl: progressTtlSeconds },
		)
	} catch (error) {
		console.warn('api-request-progress-write-failed', error)
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
		packageCheckProgressSteps.map((step) =>
			kv
				.get(apiRequestProgressKvKey(input.requestId, step), 'json')
				.catch(() => null),
		),
	)
	for (let index = recorded.length - 1; index >= 0; index -= 1) {
		const progress = parseApiRequestProgress(recorded[index])
		if (progress) return progress
	}
	return null
}
