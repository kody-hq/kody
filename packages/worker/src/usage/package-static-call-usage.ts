import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	recordUsage,
	type UsageEnv,
	type UsageOutcome,
	usageAttributionFieldsFromRequest,
} from './record-usage.ts'
import { sanitizeUsageErrorName } from './usage-error-name.ts'

/**
 * Host-side sink for `package_static_call` usage events reported by the
 * sandbox-side call-metering wrapper around statically imported package
 * exports (see `__kodyMeterStaticPackageExport` in
 * `packages/worker/src/package-runtime/runtime-source-modules.ts`).
 *
 * Trust model: the callee package id is stamped into generated import-proxy
 * code by the bundler, never taken from author-supplied strings. Generated
 * code still runs inside the sandbox realm, though, so the host validates
 * every reported id against the bundle's static dependency package ids
 * recorded at build time — direct and transitive (re-export chains meter at
 * the innermost layer). That set is still a strict subset of the
 * `packageStorage()` grant set, which additionally grants the run's own
 * package id and dynamic-import dependencies. Anything else is dropped. A
 * malicious module can therefore at worst inflate call counts for packages
 * its own bundle already statically depends on — it can never attribute
 * usage to an arbitrary package.
 *
 * Events arrive as one batch per run (buffered sandbox-side and flushed by
 * the run wrapper while the sandbox RPC dispatchers are still live). The host
 * buffers accepted events until {@link PackageStaticCallMeterTools.finalize}
 * with the host-observed run outcome: a throw recorded as `error` at call
 * time is rewritten to `caught` when the run succeeded (caller handled it).
 * Fleet error-rate alerting counts only `error`, so caught throws stay
 * visible in Analytics Engine / admin drill-down without inflating the rate.
 * `record` / `finalize` never throw and never reject: metering must not break
 * the call path it observes (same contract as `recordUsage`).
 */

export type PackageStaticCallMeterInput = Record<string, unknown>

export type PackageStaticCallMeterTools = {
	record: (input: PackageStaticCallMeterInput) => Promise<void>
	/**
	 * Write buffered events after the host knows whether the run failed.
	 * Safe to call more than once; later calls are no-ops.
	 */
	finalize: (input: { runFailed: boolean }) => Promise<void>
}

type PendingStaticCallEvent = {
	packageId: string
	durationMs: number | null
	outcome: Extract<UsageOutcome, 'success' | 'error'>
	/** Sanitized name/code; empty when the sandbox did not report one. */
	errorName: string
}

/**
 * Mirrors the sandbox-side cumulative cap in the static-call meter prelude
 * (`createStaticCallMeterHelperPrelude`), enforced across every batch of
 * one run even for a sandbox that forges oversized payloads. Sized to fit
 * the Workers Analytics Engine budget: 250 `writeDataPoint` calls per
 * invocation, one per event, with headroom left for the run's other usage
 * events.
 */
const maxRecordedEventsPerRun = 200

export function createPackageStaticCallMeterTools(input: {
	env: UsageEnv
	userId: string | null | undefined
	request?: RequestContext | null
	/**
	 * Saved-package UUIDs recorded as static dependencies of the running
	 * bundle at build time (`bundle.dependencies`, direct and transitive),
	 * from bundler/host controlled provenance only. Reported events whose
	 * stamped id is not in this set are dropped.
	 */
	grantedPackageIds: ReadonlySet<string>
}): PackageStaticCallMeterTools | undefined {
	const userId = input.userId?.trim()
	if (!userId) return undefined
	const pending: Array<PendingStaticCallEvent> = []
	let finalized = false
	return {
		record: async (batch) => {
			try {
				if (finalized) return
				const events = Array.isArray(batch?.events) ? batch.events : []
				for (const rawEvent of events.slice(0, maxRecordedEventsPerRun)) {
					if (pending.length >= maxRecordedEventsPerRun) return
					const accepted = acceptStaticCallEvent({
						grantedPackageIds: input.grantedPackageIds,
						rawEvent,
					})
					if (accepted) pending.push(accepted)
				}
			} catch (error) {
				console.debug('package-static-call-usage-failed', error)
			}
		},
		finalize: async ({ runFailed }) => {
			// Callers should schedule this via waitUntil (or a short race) so
			// sequential recordUsage writes cannot stall the run return path.
			try {
				if (finalized) return
				finalized = true
				const events = pending.splice(0, pending.length)
				for (const event of events) {
					const outcome: UsageOutcome =
						event.outcome === 'error' && !runFailed ? 'caught' : event.outcome
					await recordUsage(input.env, {
						userId,
						eventType: 'package_static_call',
						entityId: event.packageId,
						durationMs: event.durationMs,
						outcome,
						...(outcome !== 'success' && event.errorName
							? { errorName: event.errorName }
							: {}),
						...usageAttributionFieldsFromRequest(input.request),
					})
				}
			} catch (error) {
				console.debug('package-static-call-usage-finalize-failed', error)
			}
		},
	}
}

/** Returns a pending event when the report is granted and well-formed. */
function acceptStaticCallEvent(input: {
	grantedPackageIds: ReadonlySet<string>
	rawEvent: unknown
}): PendingStaticCallEvent | null {
	const rawEvent =
		typeof input.rawEvent === 'object' && input.rawEvent !== null
			? (input.rawEvent as Record<string, unknown>)
			: {}
	const packageId =
		typeof rawEvent.packageId === 'string' ? rawEvent.packageId : ''
	if (!packageId || !input.grantedPackageIds.has(packageId)) {
		console.debug(
			'package-static-call-usage-dropped',
			'stamped package id is not a static dependency of this run',
			packageId,
		)
		return null
	}
	const outcome = rawEvent.outcome
	if (outcome !== 'success' && outcome !== 'error') {
		console.debug('package-static-call-usage-dropped', 'invalid outcome')
		return null
	}
	const durationMs =
		typeof rawEvent.durationMs === 'number' &&
		Number.isFinite(rawEvent.durationMs) &&
		rawEvent.durationMs >= 0
			? rawEvent.durationMs
			: null
	const errorName =
		outcome === 'error'
			? sanitizeUsageErrorName(
					typeof rawEvent.errorName === 'string' ? rawEvent.errorName : '',
				)
			: ''
	return { packageId, durationMs, outcome, errorName }
}
