import type { WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	recordUsage,
	type DynamicWorkerCacheReuse,
	type UsageEnv,
	type UsageOutcome,
} from '#worker/usage/record-usage.ts'
import type { DynamicWorkerDaySurface } from './dynamic-worker-day-surface.ts'
import type { ExecuteThinGlueClass } from './execute-thin-glue.ts'

const workerModuleTextKeys = ['js', 'cjs', 'text'] as const

function hasNonEmptyParamsObject(params: unknown): boolean {
	if (params === null || typeof params !== 'object' || Array.isArray(params)) {
		return false
	}
	return Object.keys(params).length > 0
}

/**
 * Character length of a key-sorted JSON serialization of `params`.
 * Returns 0 for null, undefined, non-objects, arrays, and empty `{}`
 * (not 2 from stringifying `{}`). Never returns the JSON itself.
 */
export function countEvaluateInvocationParamsChars(params: unknown): number {
	if (!hasNonEmptyParamsObject(params)) return 0
	try {
		return JSON.stringify(canonicalizeJson(params)).length
	} catch {
		return 0
	}
}

function canonicalizeJson(value: unknown): unknown {
	if (value === null || typeof value !== 'object') return value
	if (Array.isArray(value)) return value.map((entry) => canonicalizeJson(entry))
	const record = value as Record<string, unknown>
	return Object.fromEntries(
		Object.keys(record)
			.sort((left, right) => left.localeCompare(right))
			.map((key) => [key, canonicalizeJson(record[key])]),
	)
}

/**
 * Character length of the module-graph text that participates in the
 * Dynamic Worker id. Counts string modules and `js` / `cjs` / `text`
 * fields only — never names, params, or binary payloads.
 */
export function countDynamicWorkerModuleGraphChars(
	modules: WorkerLoaderModules,
): number {
	let total = 0
	for (const moduleValue of Object.values(modules)) {
		if (typeof moduleValue === 'string') {
			total += moduleValue.length
			continue
		}
		if (moduleValue === null || typeof moduleValue !== 'object') continue
		const record = moduleValue as Record<string, unknown>
		for (const key of workerModuleTextKeys) {
			const value = record[key]
			if (typeof value === 'string') total += value.length
		}
	}
	return total
}

/**
 * Record one observe-only `dynamic_worker_invoke` for a LOADER evaluate.
 * Hits and misses both write. Payload is numbers and closed enums only.
 *
 * Never throws.
 */
export async function recordDynamicWorkerInvoke(input: {
	env: UsageEnv
	userId: string | null | undefined
	durationMs: number
	outcome: UsageOutcome
	surface: DynamicWorkerDaySurface
	cacheReuse: DynamicWorkerCacheReuse
	codeChars: number
	executeShape?: ExecuteThinGlueClass | null
	paramsChars?: number
	actorUserId?: string | null
	automationSource?: string | null
	connectionKey?: string | null
	waitUntil?: (promise: Promise<unknown>) => void
}): Promise<void> {
	try {
		if (!input.userId) return
		await recordUsage(
			input.env,
			{
				userId: input.userId,
				eventType: 'dynamic_worker_invoke',
				durationMs: input.durationMs,
				outcome: input.outcome,
				surface: input.surface,
				cacheReuse: input.cacheReuse,
				codeChars: input.codeChars,
				paramsChars: input.paramsChars ?? 0,
				...(input.executeShape ? { executeShape: input.executeShape } : {}),
				...(input.actorUserId != null
					? { actorUserId: input.actorUserId }
					: {}),
				...(input.automationSource != null
					? { automationSource: input.automationSource }
					: {}),
				...(input.connectionKey ? { connectionKey: input.connectionKey } : {}),
			},
			{ waitUntil: input.waitUntil },
		)
	} catch (error) {
		console.warn('dynamic-worker-invoke-record-failed', error)
	}
}
