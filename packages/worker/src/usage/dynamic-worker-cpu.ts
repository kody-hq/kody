import * as Sentry from '@sentry/cloudflare'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { getWorkerEntrypointSentryOptions } from '#worker/sentry-options.ts'
import { recordUsage } from './record-usage.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import type { PackageAppCpuSample } from '#universal/package-app-cpu-samples.ts'

export const dynamicWorkerCpuEventType = 'dynamic_worker_cpu'

/**
 * Appended to the stable worker id for the Loader cache key of isolates that
 * carry this tail. Bump it when the tail's WorkerCode contract changes so
 * cached isolates pick up the new tail instead of keeping the old one.
 */
export const dynamicWorkerUsageTailLoaderIdSuffix = '-cpu1'

/**
 * Loader id suffix for package-app isolates that carry this tail. Separate
 * from {@link dynamicWorkerUsageTailLoaderIdSuffix} so the package-app
 * contract can change without recycling execute isolates.
 */
export const packageAppUsageTailLoaderIdSuffix = '-cpus1'

/**
 * Diagnostics channel the package-app wrapper publishes on for a sampled
 * request (`{ cold, requestId }`). The tail records only invocations that
 * carry it, so unsampled requests cost one in-isolate check and no write.
 */
export const packageAppCpuSampleChannel = 'kody:package-app-cpu-sample'

export type DynamicWorkerUsageTailProps = {
	userId: string
	workerId: string
	/**
	 * Set for package-app isolates. Their samples go to the owner's RunLog
	 * for Activity and never to usage metering, plan limits, or entitlements.
	 */
	packageApp?: {
		packageId: string
		packageName: string | null
	}
}

/**
 * Tail worker attached to Worker Loader isolates (`WorkerCode.tails`). The
 * runtime delivers one trace event per invocation after the response, so
 * recording here adds no latency to the run. `cpuTime` is Cloudflare's own
 * per-invocation CPU measurement; wall time is never used as a CPU stand-in.
 * Props are identity only: `LOADER.get` keeps the first factory's WorkerCode
 * for a cache id, and the id already hashes the user. Zero CPU is still
 * recorded, so `event_count` doubles as tail delivery coverage against
 * `dynamic_worker_invoke` (tails are best-effort). `outcome` is the isolate's
 * platform outcome (`exceededCpu`, `exception`, …), not the sandbox result:
 * user code errors are caught inside `evaluate` and still trace as `ok`.
 */
class DynamicWorkerUsageTailEntrypoint extends WorkerEntrypoint<
	Env,
	DynamicWorkerUsageTailProps
> {
	async tail(events: Array<TraceItem>) {
		const props = this.ctx.props
		if (props.packageApp) {
			await Promise.all(
				events.map((event) =>
					recordPackageAppCpuSample({ env: this.env, props, event }),
				),
			)
			return
		}
		await Promise.all(
			events.map((event) =>
				recordDynamicWorkerCpu({
					env: this.env,
					props: this.ctx.props,
					event,
				}),
			),
		)
	}
}

export const DynamicWorkerUsageTail = Sentry.withSentry(
	getWorkerEntrypointSentryOptions,
	DynamicWorkerUsageTailEntrypoint,
)
export type DynamicWorkerUsageTail = DynamicWorkerUsageTailEntrypoint

export async function recordDynamicWorkerCpu(input: {
	env: Pick<Env, 'USAGE_EVENTS' | 'APP_DB'>
	props: DynamicWorkerUsageTailProps
	event: Pick<TraceItem, 'cpuTime' | 'wallTime' | 'outcome'>
}): Promise<void> {
	if (!input.env.USAGE_EVENTS) return
	const cpuMs = Number(input.event.cpuTime)
	if (!input.props.userId || !Number.isFinite(cpuMs) || cpuMs < 0) return
	const wallMs = Number(input.event.wallTime)
	await recordUsage(input.env, {
		userId: input.props.userId,
		eventType: dynamicWorkerCpuEventType,
		entityId: input.props.workerId,
		cpuMs,
		durationMs: Number.isFinite(wallMs) ? Math.round(wallMs) : null,
		outcome: input.event.outcome === 'ok' ? 'success' : 'error',
	})
}

const requestIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type PackageAppCpuSampleTrace = Pick<
	TraceItem,
	'cpuTime' | 'wallTime' | 'outcome' | 'eventTimestamp' | 'event'
> & {
	diagnosticsChannelEvents?: TraceItem['diagnosticsChannelEvents']
}

/** Builds the stored sample, or null when this invocation was not sampled. */
export function packageAppCpuSampleFromTrace(input: {
	props: DynamicWorkerUsageTailProps
	event: PackageAppCpuSampleTrace
}): PackageAppCpuSample | null {
	const packageApp = input.props.packageApp
	if (!packageApp) return null
	const marker = input.event.diagnosticsChannelEvents?.find(
		(entry) => entry.channel === packageAppCpuSampleChannel,
	)
	if (!marker) return null
	const message = (marker.message ?? {}) as {
		cold?: unknown
		requestId?: unknown
	}
	const requestId =
		typeof message.requestId === 'string' ? message.requestId.trim() : ''
	if (!requestIdPattern.test(requestId)) return null
	const cpuMs = Number(input.event.cpuTime)
	const wallMs = Number(input.event.wallTime)
	if (!Number.isFinite(cpuMs) || cpuMs < 0) return null
	if (!Number.isFinite(wallMs) || wallMs < 0) return null
	const fetchEvent =
		input.event.event && 'request' in input.event.event
			? (input.event.event as TraceItemFetchEventInfo)
			: null
	let path: string | null = null
	try {
		path = fetchEvent ? new URL(fetchEvent.request.url).pathname : null
	} catch {
		path = null
	}
	const timestamp = Number(input.event.eventTimestamp)
	return {
		requestId: requestId.toLowerCase(),
		occurredAt: new Date(
			Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now(),
		).toISOString(),
		packageId: packageApp.packageId,
		packageName: packageApp.packageName,
		cold: message.cold === true,
		cpuMs: Math.round(cpuMs * 1000) / 1000,
		wallMs: Math.round(wallMs * 1000) / 1000,
		path,
		status: fetchEvent?.response?.status ?? null,
		outcome: input.event.outcome === 'ok' ? 'ok' : 'error',
	}
}

/**
 * Stores a sampled package-app request in the owner's RunLog for Activity.
 * Observability only: this never calls `recordUsage`, so it is not billed
 * and does not count toward plan limits or entitlements.
 */
export async function recordPackageAppCpuSample(input: {
	env: Env
	props: DynamicWorkerUsageTailProps
	event: PackageAppCpuSampleTrace
}): Promise<void> {
	const sample = packageAppCpuSampleFromTrace(input)
	if (!sample || !input.props.userId) return
	try {
		const { runLogRpc } = await import('#worker/run-records/service.ts')
		await runLogRpc({
			env: input.env,
			userId: input.props.userId as OwnerId,
		}).recordPackageAppCpuSample(sample)
	} catch (error) {
		console.warn('Package app CPU sample write failed:', error)
	}
}
