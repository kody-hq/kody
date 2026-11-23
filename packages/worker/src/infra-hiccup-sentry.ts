import {
	isolateCollection,
	isolateState,
} from '@kody-internal/shared/isolate-state.ts'
import * as Sentry from '@sentry/cloudflare'

/**
 * Temporary internal infrastructure hiccups that callers see as a retryable
 * failure but that Kent wants tracked (#4542). Only two classes are reported:
 * the retryable D1 "briefly unavailable" remap and the fail-closed storage
 * estimate read. Caller errors, bad SQL, and limits never reach this module.
 */
export type InfraHiccupKind = 'd1_transient' | 'storage_estimate_unavailable'

export type InfraHiccupReport = {
	kind: InfraHiccupKind
	/** Low-cardinality operation name; never a handle or package name. */
	operation: string
	attempts: number | null
	/** `timeout`, `fast_failure`, or a D1 error kind such as `lock`. */
	errorClass: string
	/** Raw storage id; only its hash is sent. */
	storageId?: string
	bucketKind?: string
}

export const infraHiccupPerFingerprintIntervalMs = 60_000
export const infraHiccupGlobalWindowMs = 60_000
export const infraHiccupGlobalMaxPerWindow = 10

const lastSentAtByFingerprint = isolateCollection(new Map<string, number>())
const globalWindow = isolateState(() => ({ startedAt: 0, count: 0 }))

function allowInfraHiccupEvent(fingerprintKey: string, now: number) {
	const lastSentAt = lastSentAtByFingerprint.get(fingerprintKey)
	if (
		lastSentAt !== undefined &&
		now - lastSentAt < infraHiccupPerFingerprintIntervalMs
	) {
		return false
	}
	if (now - globalWindow.current.startedAt >= infraHiccupGlobalWindowMs) {
		globalWindow.current.startedAt = now
		globalWindow.current.count = 0
	}
	if (globalWindow.current.count >= infraHiccupGlobalMaxPerWindow) return false
	globalWindow.current.count += 1
	lastSentAtByFingerprint.set(fingerprintKey, now)
	if (lastSentAtByFingerprint.size > 256) {
		const oldest = lastSentAtByFingerprint.keys().next().value
		if (oldest !== undefined) lastSentAtByFingerprint.delete(oldest)
	}
	return true
}

export async function hashStorageIdForSentry(storageId: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`kody-storage-id:${storageId}`),
	)
	return Array.from(new Uint8Array(digest).slice(0, 8), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('')
}

/**
 * Captures one rate-limited warning per (kind, operation, errorClass) per
 * isolate per minute, capped globally per isolate. Never throws.
 */
export async function reportInfraHiccup(report: InfraHiccupReport) {
	let storageIdHash: string | null = null
	try {
		if (report.storageId) {
			storageIdHash = await hashStorageIdForSentry(report.storageId)
		}
	} catch (error) {
		console.warn('infra-hiccup-report-failed', error)
		return
	}
	captureInfraHiccup(report, storageIdHash)
}

/** Synchronous form of {@link reportInfraHiccup} for reports with no storage id. */
export function captureInfraHiccup(
	report: Omit<InfraHiccupReport, 'storageId'>,
	storageIdHash: string | null = null,
) {
	try {
		const fingerprint = [
			'infra-hiccup',
			report.kind,
			report.operation,
			report.errorClass,
		]
		if (!allowInfraHiccupEvent(fingerprint.join('|'), Date.now())) return
		Sentry.withScope((scope) => {
			scope.setLevel('warning')
			scope.setFingerprint(fingerprint)
			scope.setTag('infra_hiccup', report.kind)
			scope.setTag('infra_hiccup.operation', report.operation)
			scope.setTag('infra_hiccup.error_class', report.errorClass)
			scope.setTag(
				'infra_hiccup.attempts',
				report.attempts === null ? 'unknown' : String(report.attempts),
			)
			if (storageIdHash) {
				scope.setTag('infra_hiccup.storage_id_hash', storageIdHash)
			}
			if (report.bucketKind) {
				scope.setTag('infra_hiccup.bucket_kind', report.bucketKind)
			}
			Sentry.captureMessage(
				`Infra hiccup: ${report.kind} (${report.operation}, ${report.errorClass})`,
			)
		})
	} catch (error) {
		console.warn('infra-hiccup-report-failed', error)
	}
}
