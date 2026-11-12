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

const nullBodyStatuses = new Set([101, 204, 205, 304])

function bytesToBase64(bytes: Uint8Array) {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
}

function base64ToBytes(base64: string) {
	const binary = atob(base64)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	return bytes
}

/**
 * Under the `kody dev` mock, outbound fetch goes to the CLI's `.kody/mocks.ts`
 * gateway instead of the internet. Null everywhere else.
 */
export function kodyDevOutboundFetch(env: {
	KODY_DEV_MOCK_SECRETS?: string
	KODY_DEV_OUTBOUND_URL?: string
}): typeof fetch | null {
	if (env.KODY_DEV_MOCK_SECRETS?.trim() !== 'true') return null
	const gatewayUrl = env.KODY_DEV_OUTBOUND_URL?.trim()
	if (!gatewayUrl) return null
	return async (resource, init) => {
		const request = new Request(resource, init)
		const body = request.body
			? new Uint8Array(await request.arrayBuffer())
			: null
		const response = await fetch(gatewayUrl, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				url: request.url,
				method: request.method,
				headers: Object.fromEntries(request.headers),
				...(body ? { bodyBase64: bytesToBase64(body) } : {}),
			}),
		})
		const result = (await response.json()) as {
			status?: number
			statusText?: string
			headers?: Record<string, string>
			bodyBase64?: string
			error?: string
		}
		if (!response.ok || typeof result.status !== 'number') {
			throw new TypeError(result.error ?? 'The kody dev outbound mock failed.')
		}
		return new Response(
			nullBodyStatuses.has(result.status)
				? null
				: base64ToBytes(result.bodyBase64 ?? ''),
			{
				status: result.status,
				statusText: result.statusText ?? '',
				headers: result.headers ?? {},
			},
		)
	}
}
