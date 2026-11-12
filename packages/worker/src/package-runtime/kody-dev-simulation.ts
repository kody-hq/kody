/**
 * Opt-in `kody dev` simulations. Each reads a var that only the local
 * `@kodycodes/dev-runtime` stack sets, and only when the stack is a
 * `kody dev` mock (`KODY_DEV_MOCK_SECRETS=true`). Production never sets them.
 * These approximate Cloudflare behavior; they are not exact timing.
 */
type KodyDevSimulationEnv = Pick<
	Env,
	| 'KODY_DEV_MOCK_SECRETS'
	| 'KODY_DEV_STORAGE_LATENCY_MS'
	| 'KODY_DEV_COLD_ISOLATES'
	| 'KODY_DEV_CLOCK_OFFSET_MS'
>

function isKodyDevStack(env: KodyDevSimulationEnv) {
	return env.KODY_DEV_MOCK_SECRETS?.trim() === 'true'
}

function readNonNegativeInteger(value: string | undefined) {
	const parsed = Number(value?.trim())
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0
}

export function kodyDevStorageLatencyMs(env: KodyDevSimulationEnv) {
	if (!isKodyDevStack(env)) return 0
	return readNonNegativeInteger(env.KODY_DEV_STORAGE_LATENCY_MS)
}

export function kodyDevColdIsolates(env: KodyDevSimulationEnv) {
	return isKodyDevStack(env) && env.KODY_DEV_COLD_ISOLATES?.trim() === 'true'
}

export function kodyDevClockOffsetMs(env: KodyDevSimulationEnv) {
	if (!isKodyDevStack(env)) return 0
	const parsed = Number(env.KODY_DEV_CLOCK_OFFSET_MS?.trim())
	return Number.isSafeInteger(parsed) ? parsed : 0
}

/** Delays every storage runner call by `latencyMs` before it runs. */
export function withKodyDevStorageLatency<T extends object>(
	target: T,
	latencyMs: number,
): T {
	return new Proxy(target, {
		get(object, property, receiver) {
			const value = Reflect.get(object, property, receiver) as unknown
			if (typeof value !== 'function') return value
			return async (...args: Array<unknown>) => {
				await new Promise((resolve) => setTimeout(resolve, latencyMs))
				return await (value as (...a: Array<unknown>) => unknown).apply(
					object,
					args,
				)
			}
		},
	})
}

/**
 * Module prelude that shifts `Date` by a fixed offset inside the package app
 * isolate. Workerd already freezes the clock between I/O like Cloudflare; this
 * only moves "now" so time-dependent code can be exercised.
 */
export function kodyDevClockShimSource(offsetMs: number) {
	if (!offsetMs) return ''
	return `
const __kodyDevClockOffsetMs = ${JSON.stringify(offsetMs)};
{
	const RealDate = globalThis.Date;
	class KodyDevDate extends RealDate {
		constructor(...args) {
			if (args.length === 0) super(RealDate.now() + __kodyDevClockOffsetMs);
			else super(...args);
		}
		static now() {
			return RealDate.now() + __kodyDevClockOffsetMs;
		}
	}
	globalThis.Date = KodyDevDate;
}
`
}
