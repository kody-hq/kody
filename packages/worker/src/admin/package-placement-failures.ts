/**
 * Fleet read of failed package runs in one window, for finding owners whose
 * runs broke under the header-only secret placement rule. Fans out one
 * content-free RunLog RPC per package owner and joins package and owner
 * identity from D1. Never returns run inputs, outputs, logs, errors, or
 * secrets.
 */

import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { mapWithConcurrency } from '#worker/admin/insights-runlog-snapshot.ts'
import { listPackageCodemodRunItems } from '#worker/package-codemods/ledger.ts'
import {
	packageFailureSummaryMaxPackageIds,
	type RunLogFailureCounts,
	type RunLogPackageFailureSummary,
} from '#worker/run-records/package-failure-summary.ts'
import { summarizePackageFailures } from '#worker/run-records/service.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export const packagePlacementFailuresConcurrency = 8
export const packagePlacementFailuresMaxOwners = 1_500
export const packagePlacementFailuresMaxWindowMs = 31 * 24 * 60 * 60 * 1000

const codemodRunItemsPageSize = 200

export type PackagePlacementFailuresInput = {
	since: string
	until: string
	packageIds?: Array<string>
	flaggedByCodemodRun?: { runId: string; finding: string }
}

export type PackagePlacementFailureRow = {
	ownerId: OwnerId
	ownerHandle: string | null
	/** Null for the owner's runs that carry no package. */
	packageId: string | null
	kodyId: string | null
	flagged: boolean
	placementRefusals: RunLogFailureCounts
	/** Every failed run in the window; null unless `flagged`. */
	failedRuns: RunLogFailureCounts | null
}

export type PackagePlacementFailuresReport = {
	since: string
	until: string
	flaggedPackageCount: number
	ownersAttempted: number
	ownersLoaded: number
	complete: boolean
	packages: Array<PackagePlacementFailureRow>
}

type FlaggedPackage = { ownerId: OwnerId; packageId: string; kodyId: string }

export async function loadPackagePlacementFailures(input: {
	env: Env
	window: PackagePlacementFailuresInput
}): Promise<PackagePlacementFailuresReport> {
	const { env, window } = input
	const sinceMs = Date.parse(window.since)
	const untilMs = Date.parse(window.until)
	if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs)) {
		throw new Error('since and until must be ISO timestamps.')
	}
	if (untilMs <= sinceMs) throw new Error('until must be after since.')
	if (untilMs - sinceMs > packagePlacementFailuresMaxWindowMs) {
		throw new Error('The window may span at most 31 days.')
	}
	const since = new Date(sinceMs).toISOString()
	const until = new Date(untilMs).toISOString()

	const flagged = await loadFlaggedPackages(env.APP_DB, window)
	const flaggedByOwner = new Map<OwnerId, Array<FlaggedPackage>>()
	for (const item of flagged) {
		const list = flaggedByOwner.get(item.ownerId) ?? []
		list.push(item)
		flaggedByOwner.set(item.ownerId, list)
	}
	// Per-owner RunLog summaries cap packageIds; truncate like the owner list
	// instead of aborting the whole fleet report when one owner overflows.
	let flaggedPackagesTruncated = false
	for (const [ownerId, list] of flaggedByOwner) {
		if (list.length <= packageFailureSummaryMaxPackageIds) continue
		flaggedByOwner.set(
			ownerId,
			list.slice(0, packageFailureSummaryMaxPackageIds),
		)
		flaggedPackagesTruncated = true
	}

	const { ownerIds, truncated } = await listPackageOwners(
		env.APP_DB,
		flaggedByOwner.keys(),
	)
	const summaries = await mapWithConcurrency(
		ownerIds,
		packagePlacementFailuresConcurrency,
		async (ownerId) => {
			try {
				const summary = await summarizePackageFailures({
					env,
					userId: ownerId,
					window: {
						since,
						until,
						packageIds: (flaggedByOwner.get(ownerId) ?? []).map(
							(item) => item.packageId,
						),
					},
				})
				return { ownerId, summary }
			} catch (error) {
				console.warn('admin-package-placement-failures-owner-unavailable', {
					ownerId,
					error,
				})
				return { ownerId, summary: null }
			}
		},
	)

	const rows = foldPackageFailureSummaries({ summaries, flaggedByOwner })
	const [handles, kodyIds] = await Promise.all([
		loadOwnerHandles(
			env.APP_DB,
			rows.map((row) => row.ownerId),
		),
		loadPackageKodyIds(
			env.APP_DB,
			rows.flatMap((row) =>
				row.packageId != null && row.kodyId == null ? [row.packageId] : [],
			),
		),
	])
	const ownersLoaded = summaries.filter((entry) => entry.summary).length
	return {
		since,
		until,
		flaggedPackageCount: flagged.length,
		ownersAttempted: ownerIds.length,
		ownersLoaded,
		complete:
			!truncated &&
			!flaggedPackagesTruncated &&
			ownersLoaded === ownerIds.length,
		packages: rows.map((row) => ({
			...row,
			ownerHandle: handles.get(row.ownerId) ?? null,
			kodyId:
				row.kodyId ??
				(row.packageId == null ? null : (kodyIds.get(row.packageId) ?? null)),
		})),
	}
}

/**
 * Keeps packages with a refusal or a flag, and the owner's package-less
 * refusals. Sorted by refusals, then failed runs, then ids.
 */
export function foldPackageFailureSummaries(input: {
	summaries: ReadonlyArray<{
		ownerId: OwnerId
		summary: RunLogPackageFailureSummary | null
	}>
	flaggedByOwner: ReadonlyMap<OwnerId, ReadonlyArray<FlaggedPackage>>
}): Array<PackagePlacementFailureRow> {
	const rows: Array<PackagePlacementFailureRow> = []
	for (const { ownerId, summary } of input.summaries) {
		const flagged = input.flaggedByOwner.get(ownerId) ?? []
		const flaggedIds = new Map(flagged.map((item) => [item.packageId, item]))
		const seen = new Set<string>()
		for (const entry of summary?.packages ?? []) {
			const flaggedItem =
				entry.packageId == null ? undefined : flaggedIds.get(entry.packageId)
			if (entry.packageId != null) seen.add(entry.packageId)
			if (!flaggedItem && entry.placementRefusals.count === 0) continue
			rows.push({
				ownerId,
				ownerHandle: null,
				packageId: entry.packageId,
				kodyId: flaggedItem?.kodyId ?? null,
				flagged: flaggedItem != null,
				placementRefusals: entry.placementRefusals,
				failedRuns: flaggedItem ? (entry.failedRuns ?? zeroCounts()) : null,
			})
		}
		if (!summary) continue
		for (const item of flagged) {
			if (seen.has(item.packageId)) continue
			rows.push({
				ownerId,
				ownerHandle: null,
				packageId: item.packageId,
				kodyId: item.kodyId,
				flagged: true,
				placementRefusals: zeroCounts(),
				failedRuns: zeroCounts(),
			})
		}
	}
	return rows.sort(
		(left, right) =>
			right.placementRefusals.count - left.placementRefusals.count ||
			(right.failedRuns?.count ?? 0) - (left.failedRuns?.count ?? 0) ||
			left.ownerId.localeCompare(right.ownerId) ||
			(left.packageId ?? '').localeCompare(right.packageId ?? ''),
	)
}

function zeroCounts(): RunLogFailureCounts {
	return { count: 0, firstAt: null, lastAt: null }
}

async function loadFlaggedPackages(
	db: D1Database,
	window: PackagePlacementFailuresInput,
): Promise<Array<FlaggedPackage>> {
	const byId = new Map<string, FlaggedPackage>()
	const explicitIds = [...new Set(window.packageIds ?? [])]
	if (explicitIds.length > 0) {
		const { results } = await db
			.prepare(
				`SELECT id, user_id, kody_id
				 FROM saved_packages
				 WHERE id IN (${explicitIds.map(() => '?').join(', ')})${andLiveDeletedAtSql()}`,
			)
			.bind(...explicitIds)
			.all<{ id: string; user_id: string; kody_id: string }>()
		for (const row of results ?? []) {
			byId.set(row.id, {
				ownerId: row.user_id as OwnerId,
				packageId: row.id,
				kodyId: row.kody_id,
			})
		}
	}
	const codemodRun = window.flaggedByCodemodRun
	if (codemodRun) {
		const findingPrefix = `${codemodRun.finding}:`
		let afterId: string | null = null
		for (;;) {
			const items = await listPackageCodemodRunItems(db, {
				runId: codemodRun.runId,
				afterId,
				limit: codemodRunItemsPageSize,
			})
			for (const item of items) {
				if (
					item.findings.some((finding) =>
						finding.message.startsWith(findingPrefix),
					)
				) {
					byId.set(item.packageId, {
						ownerId: item.userId,
						packageId: item.packageId,
						kodyId: item.kodyId,
					})
				}
			}
			const last = items.at(-1)
			if (!last || items.length < codemodRunItemsPageSize) break
			afterId = last.id
		}
	}
	return [...byId.values()]
}

/** Exported for unit tests of the owner-cap / truncated bookkeeping. */
export async function listPackageOwners(
	db: D1Database,
	flaggedOwnerIds: Iterable<OwnerId>,
): Promise<{ ownerIds: Array<OwnerId>; truncated: boolean }> {
	const { results } = await db
		.prepare(
			`SELECT DISTINCT user_id
			 FROM saved_packages
			 WHERE deleting_at IS NULL${andLiveDeletedAtSql()}
			 ORDER BY user_id LIMIT ?`,
		)
		.bind(packagePlacementFailuresMaxOwners + 1)
		.all<{ user_id: string }>()
	const owners = (results ?? [])
		.map((row) => row.user_id)
		.filter((id) => typeof id === 'string' && id !== '')
	const liveTruncated = owners.length > packagePlacementFailuresMaxOwners
	const liveOwners = owners.slice(0, packagePlacementFailuresMaxOwners)
	// Flagged owners are included first, but they still count toward the cap.
	// Mark truncated whenever flagged owners alone exceed the cap, or when
	// adding them causes any live owner to be dropped.
	const ownerIds: Array<OwnerId> = []
	const seen = new Set<OwnerId>()
	let truncated = liveTruncated
	for (const id of flaggedOwnerIds) {
		if (seen.has(id)) continue
		if (ownerIds.length >= packagePlacementFailuresMaxOwners) {
			truncated = true
			break
		}
		seen.add(id)
		ownerIds.push(id)
	}
	for (const owner of liveOwners) {
		const id = owner as OwnerId
		if (seen.has(id)) continue
		if (ownerIds.length >= packagePlacementFailuresMaxOwners) {
			truncated = true
			break
		}
		seen.add(id)
		ownerIds.push(id)
	}
	return { ownerIds, truncated }
}

async function loadOwnerHandles(
	db: D1Database,
	ownerIds: ReadonlyArray<OwnerId>,
): Promise<Map<OwnerId, string>> {
	const ids = [...new Set(ownerIds)]
	const handles = new Map<OwnerId, string>()
	for (let offset = 0; offset < ids.length; offset += 50) {
		const chunk = ids.slice(offset, offset + 50)
		const { results } = await db
			.prepare(
				`SELECT id, slug FROM orgs
				 WHERE id IN (${chunk.map(() => '?').join(', ')})${andLiveDeletedAtSql()}`,
			)
			.bind(...chunk)
			.all<{ id: string; slug: string }>()
		for (const row of results ?? []) handles.set(row.id as OwnerId, row.slug)
	}
	return handles
}

async function loadPackageKodyIds(
	db: D1Database,
	packageIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
	const ids = [...new Set(packageIds)]
	const kodyIds = new Map<string, string>()
	for (let offset = 0; offset < ids.length; offset += 50) {
		const chunk = ids.slice(offset, offset + 50)
		const { results } = await db
			.prepare(
				`SELECT id, kody_id FROM saved_packages
				 WHERE id IN (${chunk.map(() => '?').join(', ')})${andLiveDeletedAtSql()}`,
			)
			.bind(...chunk)
			.all<{ id: string; kody_id: string }>()
		for (const row of results ?? []) kodyIds.set(row.id, row.kody_id)
	}
	return kodyIds
}
