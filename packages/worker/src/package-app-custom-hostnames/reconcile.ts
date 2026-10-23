import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import {
	CloudflareCustomHostnamesClient,
	isCloudflareCustomHostnameGone,
	type CloudflareCustomHostnameResult,
} from '#worker/package-app-custom-hostnames/cloudflare-custom-hostnames-client.ts'
import { invalidateCachedPackageAppCustomHostname } from '#worker/package-app-custom-hostnames/lookup-cache.ts'
import { isPackageAppCustomHostnameVerified } from '#worker/package-app-custom-hostnames/lookup.ts'
import {
	claimPackageAppCustomHostnameActivation,
	listPackageAppCustomHostnamesForReconcile,
	removePackageAppCustomHostnameRow,
	serializeVerificationErrors,
} from '#worker/package-app-custom-hostnames/service.ts'
import { notifyOwnersOfCustomHostnameStatus } from '#worker/package-app-custom-hostnames/status-notice.ts'
import {
	packageAppCustomDomainCheckWindowMs,
	packageAppCustomDomainRecheckIntervalMs,
} from '#universal/package-app-custom-domain-status.ts'
import { type PackageAppCustomHostnameRow } from '#worker/package-app-custom-hostnames/types.ts'

export const packageAppCustomHostnameGracePeriodMs = 36 * 60 * 60 * 1000

export type ReconcilePackageAppCustomHostnamesResult = {
	scanned: number
	updated: number
	removed: number
	skipped: number
	activated: number
	needsAttention: number
	errors: number
	budgetExhausted: boolean
}

const defaultBatchSize = 50
export const reconcilePackageAppCustomHostnamesBudgetMs = 60_000

function createClient(env: Env & { fetcher?: Fetcher }) {
	if (
		!env.CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN?.trim() ||
		!env.PACKAGE_APP_ZONE_ID?.trim()
	) {
		return null
	}
	return new CloudflareCustomHostnamesClient({
		CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN:
			env.CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN,
		PACKAGE_APP_ZONE_ID: env.PACKAGE_APP_ZONE_ID,
		fetcher: env.fetcher,
	})
}

function shouldStartDnsMissingGrace(input: {
	verifiedAt: string | null
	hostnameStatus: string
	sslStatus: string
}) {
	if (
		isPackageAppCustomHostnameVerified({
			hostnameStatus: input.hostnameStatus,
			sslStatus: input.sslStatus,
		})
	) {
		return false
	}
	if (input.verifiedAt) return true
	return input.hostnameStatus === 'moved' || input.hostnameStatus === 'deleted'
}

function deletedCloudflareHostnameResult(
	row: PackageAppCustomHostnameRow,
): CloudflareCustomHostnameResult {
	return {
		id: row.cloudflareHostnameId ?? row.id,
		hostname: row.hostname,
		hostnameStatus: 'deleted',
		sslStatus: row.sslStatus,
		ownershipVerification: null,
		sslValidationRecords: [],
		verificationErrors: [],
	}
}

/**
 * Only email about a stalled hostname when it ran out of window recently, so
 * rows that were already stale before auto re-check shipped get the status
 * but no surprise email.
 */
const needsAttentionNoticeGraceMs = 24 * 60 * 60 * 1000

type PendingRecheckPlan = { due: false } | { due: true; windowOver: boolean }

/**
 * Backoff for hostnames that have never gone active: every tick for the
 * first hour, then less often, then stop and mark needs attention.
 */
function planPendingRecheck(
	row: PackageAppCustomHostnameRow,
	now: Date,
): PendingRecheckPlan & { checkingForMs: number } {
	// Previously active rows, and rows already in the DNS-missing grace
	// period, stay on every tick so the grace removal still runs.
	if (row.verifiedAt || row.dnsMissingSince) {
		return { due: true, windowOver: false, checkingForMs: 0 }
	}
	const anchorMs = Date.parse(row.checkWindowStartedAt ?? row.createdAt)
	const checkingForMs = Number.isFinite(anchorMs) ? now.getTime() - anchorMs : 0
	if (row.needsAttentionAt) return { due: false, checkingForMs }
	const interval = packageAppCustomDomainRecheckIntervalMs(checkingForMs)
	if (interval === null) return { due: true, windowOver: true, checkingForMs }
	const lastCheckedMs = Date.parse(row.updatedAt)
	if (
		interval > 0 &&
		Number.isFinite(lastCheckedMs) &&
		now.getTime() - lastCheckedMs < interval
	) {
		return { due: false, checkingForMs }
	}
	return { due: true, windowOver: false, checkingForMs }
}

async function claimNeedsAttention(input: {
	db: D1Database
	id: string
	nowIso: string
}) {
	const result = await input.db
		.prepare(
			`UPDATE package_app_custom_hostnames
			 SET needs_attention_at = ?
			 WHERE id = ? AND needs_attention_at IS NULL AND verified_at IS NULL`,
		)
		.bind(input.nowIso, input.id)
		.run()
	return (result.meta.changes ?? 0) > 0
}

async function readReconcileCursor(db: D1Database): Promise<string> {
	const row = await db
		.prepare(
			`SELECT after_id FROM package_app_custom_hostname_reconcile_cursor
			 WHERE singleton = 1`,
		)
		.first<{ after_id: string }>()
	return row?.after_id ?? ''
}

/**
 * Compare-and-swap the singleton cursor. Returns false when another reconcile
 * run already advanced (or reset) the cursor past `expectedAfterId`.
 */
async function compareAndSwapReconcileCursor(input: {
	db: D1Database
	afterId: string
	expectedAfterId: string
	nowIso: string
}): Promise<boolean> {
	const result = await input.db
		.prepare(
			`UPDATE package_app_custom_hostname_reconcile_cursor
			 SET after_id = ?, updated_at = ?
			 WHERE singleton = 1 AND after_id = ?`,
		)
		.bind(input.afterId, input.nowIso, input.expectedAfterId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function reconcilePackageAppCustomHostnames(input: {
	env: Env
	now?: Date
	batchSize?: number
	timeBudgetMs?: number
}): Promise<ReconcilePackageAppCustomHostnamesResult> {
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	const deadline =
		Date.now() +
		(input.timeBudgetMs ?? reconcilePackageAppCustomHostnamesBudgetMs)
	const client = createClient(input.env)
	const result: ReconcilePackageAppCustomHostnamesResult = {
		scanned: 0,
		updated: 0,
		removed: 0,
		skipped: 0,
		activated: 0,
		needsAttention: 0,
		errors: 0,
		budgetExhausted: false,
	}
	if (!client) {
		return result
	}

	const batchSize = input.batchSize ?? defaultBatchSize
	let afterId = await readReconcileCursor(input.env.APP_DB)
	let persistedAfterId = afterId

	const persistCursor = async (nextAfterId: string) => {
		const swapped = await compareAndSwapReconcileCursor({
			db: input.env.APP_DB,
			afterId: nextAfterId,
			expectedAfterId: persistedAfterId,
			nowIso,
		})
		if (swapped) {
			persistedAfterId = nextAfterId
			afterId = nextAfterId
		}
		return swapped
	}

	// Forward-only keyset: resume from the persisted cursor, walk to the tail
	// (or until the budget), then reset. Do not wrap within a tick — a prior
	// incomplete sweep already covered the head, and wrapping would re-GET
	// those rows and can CAS-regress the cursor when the wrap itself times out.
	while (Date.now() < deadline) {
		const batch = await listPackageAppCustomHostnamesForReconcile(
			input.env.APP_DB,
			{
				limit: batchSize,
				afterId,
			},
		)
		if (batch.length === 0) {
			if (persistedAfterId !== '') {
				await persistCursor('')
			}
			break
		}

		for (const row of batch) {
			if (Date.now() >= deadline) {
				result.budgetExhausted = true
				break
			}
			result.scanned += 1
			const cfId = row.cloudflareHostnameId?.trim()
			if (!cfId) {
				result.skipped += 1
				afterId = row.id
				continue
			}
			const plan = planPendingRecheck(row, now)
			if (!plan.due) {
				result.skipped += 1
				afterId = row.id
				continue
			}
			try {
				const cfOrGone = await client.getCustomHostname({ id: cfId })
				const cf = isCloudflareCustomHostnameGone(cfOrGone)
					? deletedCloudflareHostnameResult(row)
					: cfOrGone
				const verified = isPackageAppCustomHostnameVerified({
					hostnameStatus: cf.hostnameStatus,
					sslStatus: cf.sslStatus ?? row.sslStatus,
				})
				let dnsMissingSince = row.dnsMissingSince
				if (verified) {
					dnsMissingSince = null
				} else if (
					shouldStartDnsMissingGrace({
						verifiedAt: row.verifiedAt,
						hostnameStatus: cf.hostnameStatus,
						sslStatus: cf.sslStatus ?? row.sslStatus,
					})
				) {
					dnsMissingSince = dnsMissingSince ?? nowIso
				}
				const verifiedAt = verified && !row.verifiedAt ? nowIso : row.verifiedAt
				if (
					dnsMissingSince &&
					now.getTime() - Date.parse(dnsMissingSince) >=
						packageAppCustomHostnameGracePeriodMs
				) {
					await removePackageAppCustomHostnameRow({
						env: input.env,
						row,
					})
					result.removed += 1
					afterId = row.id
					continue
				}
				const firstActivation =
					verified && !row.verifiedAt
						? await claimPackageAppCustomHostnameActivation({
								db: input.env.APP_DB,
								id: row.id,
								nowIso,
							})
						: false
				const markedNeedsAttention =
					!verified && plan.windowOver
						? await claimNeedsAttention({
								db: input.env.APP_DB,
								id: row.id,
								nowIso,
							})
						: false
				const sslStatus = cf.sslStatus ?? row.sslStatus
				await input.env.APP_DB.prepare(
					`UPDATE package_app_custom_hostnames
						 SET hostname_status = ?,
						     ssl_status = ?,
						     verified_at = COALESCE(verified_at, ?),
						     dns_missing_since = ?,
						     ownership_verification_json = ?,
						     ssl_validation_records_json = ?,
						     verification_errors_json = ?,
						     updated_at = ?
						 WHERE id = ?`,
				)
					.bind(
						cf.hostnameStatus,
						sslStatus,
						verifiedAt,
						dnsMissingSince,
						cf.ownershipVerification
							? JSON.stringify(cf.ownershipVerification)
							: null,
						JSON.stringify(cf.sslValidationRecords),
						serializeVerificationErrors(cf.verificationErrors),
						nowIso,
						row.id,
					)
					.run()
				invalidateCachedPackageAppCustomHostname(input.env.APP_DB, row.hostname)
				result.updated += 1
				afterId = row.id
				const updatedRow: PackageAppCustomHostnameRow = {
					...row,
					hostnameStatus: cf.hostnameStatus,
					sslStatus,
					verifiedAt,
					dnsMissingSince,
					ownershipVerification: cf.ownershipVerification,
					sslValidationRecords: cf.sslValidationRecords,
					verificationErrors: cf.verificationErrors,
					needsAttentionAt: markedNeedsAttention
						? nowIso
						: verified
							? null
							: row.needsAttentionAt,
					updatedAt: nowIso,
				}
				if (firstActivation) {
					result.activated += 1
					await notifyOwnersOfCustomHostnameStatus({
						env: input.env,
						row: updatedRow,
						event: 'active',
					})
				}
				if (markedNeedsAttention) {
					result.needsAttention += 1
					if (
						plan.checkingForMs <
						packageAppCustomDomainCheckWindowMs + needsAttentionNoticeGraceMs
					) {
						await notifyOwnersOfCustomHostnameStatus({
							env: input.env,
							row: updatedRow,
							event: 'needs_attention',
						})
					}
				}
			} catch (error) {
				console.error(
					'package_app_custom_hostnames reconcile failed:',
					row.hostname,
					getErrorMessage(error),
				)
				result.errors += 1
				// Advance past the failing row so one bad hostname cannot stall
				// the keyset for every subsequent tick.
				afterId = row.id
			}
		}

		if (result.budgetExhausted) {
			await persistCursor(afterId)
			break
		}

		if (batch.length < batchSize) {
			await persistCursor('')
			break
		}
		if (!(await persistCursor(afterId))) break
	}

	if (!result.budgetExhausted && Date.now() >= deadline) {
		result.budgetExhausted = true
		await persistCursor(afterId)
	}

	return result
}
