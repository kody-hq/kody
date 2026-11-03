/**
 * Soft-delete verified legacy team-org memories and memory grants (ADR 0072
 * cleanup). Never deletes a team-org memory until every effective reader has a
 * personal copy (provenance URI or identical subject+summary+details).
 *
 * soft-delete-read-filter: opt-out — grant sweep and vector retry read
 * soft-deleted mcp_memories rows to decide revoke vs keep and to repair
 * stranded Vectorize entries after a successful D1 soft-delete.
 */
import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'
import {
	parseOwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { listGrants, softDeleteGrant } from '#worker/orgs/access-writes.ts'
import type { OrgAuditWriter } from '#worker/orgs/org-audit.ts'
import { loadPersonalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { legacyOrgMemoryProvenanceUri } from './memory-owner.ts'
import {
	findPersonalSkip,
	listMemoryReadersForOrgMemory,
	listTeamOrgsPage,
} from './memory-personalize.ts'
import { deleteMemoryVector } from './memory-vectorize.ts'
import { listMemoriesByUserIdPage, updateMemory } from './repo.ts'
import type { McpMemoryRow } from './types.ts'

const defaultOrgPageSize = 20
const defaultMemoryPageSize = 50

export type MemoryPersonalizePurgeOutcome =
	| 'would_purge'
	| 'purged'
	| 'blocked_missing_copy'
	| 'orphan_purged'
	| 'orphan_would_purge'
	| 'already_gone'
	| 'soft_delete_failed'

export type MemoryPersonalizePurgeRow = {
	sourceMemoryId: string
	fromOrgId: string
	fromOrgSlug: string | null
	readerCount: number
	verifiedCopyCount: number
	missingReaderPersonIds: Array<string>
	/** Provenance URI pattern samples only — never subject/summary/details. */
	provenanceUrisChecked: Array<string>
	outcome: MemoryPersonalizePurgeOutcome
}

export type MemoryPersonalizePurgeGrantRow = {
	grantId: string
	orgId: string
	orgSlug: string | null
	resourceId: string
	outcome: 'would_revoke' | 'revoked' | 'skipped_error'
	error?: string
}

export type MemoryPersonalizePurgeResult = {
	dryRun: boolean
	scannedOrgs: number
	scannedMemories: number
	wouldPurge: number
	purged: number
	blockedMissingCopy: number
	orphanWouldPurge: number
	orphanPurged: number
	grantsWouldRevoke: number
	grantsRevoked: number
	vectorCleanupFailed: number
	rows: Array<MemoryPersonalizePurgeRow>
	grantRows: Array<MemoryPersonalizePurgeGrantRow>
	nextOrgCursor: string | null
	nextMemoryCursor: string | null
	/**
	 * Dry-run resume: pass back as `plannedPurgeMemoryIds` with the memory
	 * cursor so the final grant sweep counts earlier pages' would-purge rows.
	 * Empty when the org is exhausted or not mid-org paging.
	 */
	nextPlannedPurgeMemoryIds: Array<string>
	warnings: Array<string>
}

type SoftDeleteTeamMemoryResult =
	| { status: 'not_updated' }
	| { status: 'soft_deleted'; vectorDeleted: boolean }

async function tryDeleteMemoryVector(
	env: Env,
	memoryId: string,
	retries: number,
): Promise<boolean> {
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			await deleteMemoryVector(env, memoryId)
			return true
		} catch {
			// Retry below; caller surfaces a warning if all attempts fail.
		}
	}
	return false
}

async function markMemoryVectorDeleted(input: {
	db: D1Database
	orgId: string
	memoryId: string
	at: string
}): Promise<void> {
	await input.db
		.prepare(
			`UPDATE mcp_memories
			 SET vector_deleted_at = ?,
			     vector_cleanup_attempted_at = ?
			 WHERE user_id = ?
			   AND id = ?
			   AND status = 'deleted'
			   AND deleted_at IS NOT NULL
			   AND vector_deleted_at IS NULL`,
		)
		.bind(input.at, input.at, input.orgId, input.memoryId)
		.run()
}

async function markMemoryVectorCleanupAttempted(input: {
	db: D1Database
	orgId: string
	memoryId: string
	at: string
}): Promise<void> {
	await input.db
		.prepare(
			`UPDATE mcp_memories
			 SET vector_cleanup_attempted_at = ?
			 WHERE user_id = ?
			   AND id = ?
			   AND status = 'deleted'
			   AND deleted_at IS NOT NULL
			   AND vector_deleted_at IS NULL`,
		)
		.bind(input.at, input.orgId, input.memoryId)
		.run()
}

async function softDeleteTeamMemory(input: {
	env: Env
	orgId: string
	memory: McpMemoryRow
}): Promise<SoftDeleteTeamMemoryResult> {
	const ownerId = parseOwnerId(input.orgId)
	if (!ownerId) {
		throw new Error(`Team org id is not a valid OwnerId: ${input.orgId}`)
	}
	const now = new Date().toISOString()
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: ownerId,
		env: input.env,
		async write() {
			const updated = await updateMemory(
				input.env.APP_DB,
				input.orgId,
				input.memory.id,
				{
					category: input.memory.category,
					status: 'deleted',
					subject: input.memory.subject,
					summary: input.memory.summary,
					details: input.memory.details,
					tags_json: input.memory.tags_json,
					source_uris_json: input.memory.source_uris_json,
					dedupe_key: input.memory.dedupe_key,
					last_accessed_at: input.memory.last_accessed_at,
					deleted_at: now,
				},
			)
			if (!updated) return { status: 'not_updated' }
			// One immediate retry: D1 soft-delete stands even if Vectorize fails.
			const vectorDeleted = await tryDeleteMemoryVector(
				input.env,
				input.memory.id,
				1,
			)
			if (vectorDeleted) {
				await markMemoryVectorDeleted({
					db: input.env.APP_DB,
					orgId: input.orgId,
					memoryId: input.memory.id,
					at: now,
				})
			} else {
				await markMemoryVectorCleanupAttempted({
					db: input.env.APP_DB,
					orgId: input.orgId,
					memoryId: input.memory.id,
					at: now,
				})
			}
			return { status: 'soft_deleted', vectorDeleted }
		},
	})
}

async function isLiveOrgMemory(input: {
	db: D1Database
	orgId: string
	memoryId: string
}): Promise<boolean> {
	const live = await input.db
		.prepare(
			`SELECT 1 AS x FROM mcp_memories
			 WHERE user_id = ? AND id = ? AND deleted_at IS NULL`,
		)
		.bind(input.orgId, input.memoryId)
		.first<{ x: number }>()
	return live != null
}

/** Live memory ids among `memoryIds` for one org (chunked for D1 bind limits). */
async function listLiveOrgMemoryIds(input: {
	db: D1Database
	orgId: string
	memoryIds: ReadonlyArray<string>
}): Promise<Set<string>> {
	const live = new Set<string>()
	const uniqueIds = [...new Set(input.memoryIds)]
	if (uniqueIds.length === 0) return live
	// One fixed bind (orgId) + id list must stay under D1's parameter cap.
	const idChunkSize = Math.max(1, maxD1BoundParameters - 1)
	for (const chunk of chunkArray(uniqueIds, idChunkSize)) {
		const placeholders = chunk.map(() => '?').join(', ')
		const { results } = await input.db
			.prepare(
				`SELECT id FROM mcp_memories
				 WHERE user_id = ?
				   AND deleted_at IS NULL
				   AND id IN (${placeholders})`,
			)
			.bind(input.orgId, ...chunk)
			.all<{ id: string }>()
		for (const row of results ?? []) live.add(row.id)
	}
	return live
}

/**
 * Soft-deleted memories whose Vectorize cleanup has not been recorded yet.
 * Prefer never-attempted, then least-recently attempted, so permanently failing
 * oldest ids do not starve newer pending rows. Already-clean rows
 * (vector_deleted_at set) are excluded so they do not consume the budget.
 */
async function listSoftDeletedMemoriesPendingVectorPage(input: {
	db: D1Database
	orgId: string
	limit: number
}): Promise<Array<string>> {
	const { results } = await input.db
		.prepare(
			`SELECT id FROM mcp_memories
			 WHERE user_id = ?
			   AND status = 'deleted'
			   AND deleted_at IS NOT NULL
			   AND vector_deleted_at IS NULL
			 ORDER BY
			   CASE WHEN vector_cleanup_attempted_at IS NULL THEN 0 ELSE 1 END,
			   vector_cleanup_attempted_at ASC,
			   deleted_at ASC,
			   id ASC
			 LIMIT ?`,
		)
		.bind(input.orgId, input.limit)
		.all<{ id: string }>()
	return (results ?? []).map((row) => row.id)
}

async function reconcileOrgVectorCleanup(input: {
	env: Env
	orgId: string
	orgSlug: string | null
	memoryLimit: number
	pendingVectorMemoryIds: Set<string>
	warnings: Array<string>
	/** When false, only retry this invocation's pending ids (mid-org pages). */
	includeStrandedPage?: boolean
}): Promise<number> {
	const retryIds = new Set(input.pendingVectorMemoryIds)
	if (input.includeStrandedPage !== false) {
		for (const id of await listSoftDeletedMemoriesPendingVectorPage({
			db: input.env.APP_DB,
			orgId: input.orgId,
			limit: input.memoryLimit,
		})) {
			retryIds.add(id)
		}
	}
	let vectorCleanupFailed = 0
	const cleanedAt = new Date().toISOString()
	for (const memoryId of retryIds) {
		const ok = await tryDeleteMemoryVector(input.env, memoryId, 0)
		if (ok) {
			await markMemoryVectorDeleted({
				db: input.env.APP_DB,
				orgId: input.orgId,
				memoryId,
				at: cleanedAt,
			})
			input.pendingVectorMemoryIds.delete(memoryId)
			continue
		}
		await markMemoryVectorCleanupAttempted({
			db: input.env.APP_DB,
			orgId: input.orgId,
			memoryId,
			at: cleanedAt,
		})
		vectorCleanupFailed += 1
		input.warnings.push(
			`Vector cleanup still failing for memory ${memoryId} on org ${input.orgSlug ?? input.orgId}`,
		)
	}
	return vectorCleanupFailed
}

async function verifyReadersHaveCopies(input: {
	db: D1Database
	orgId: string
	memory: McpMemoryRow
	readers: Array<PersonId>
}): Promise<{
	verifiedCopyCount: number
	missingReaderPersonIds: Array<string>
	provenanceUrisChecked: Array<string>
}> {
	const provenanceUri = legacyOrgMemoryProvenanceUri(
		input.orgId,
		input.memory.id,
	)
	const missingReaderPersonIds: Array<string> = []
	let verifiedCopyCount = 0
	for (const personId of input.readers) {
		const skip = await findPersonalSkip({
			db: input.db,
			personalOrgId: await loadPersonalOrgIdForPerson(input.db, personId),
			source: input.memory,
			provenanceUri,
		})
		if (skip) verifiedCopyCount += 1
		else missingReaderPersonIds.push(personId)
	}
	return {
		verifiedCopyCount,
		missingReaderPersonIds,
		provenanceUrisChecked: [provenanceUri],
	}
}

/**
 * Soft-delete live team-org memories only when every reader has a personal
 * copy. Also soft-deletes `resource_type: memory` grants on scanned team orgs.
 */
export async function runMemoryPersonalizePurge(input: {
	env: Env
	audit: OrgAuditWriter
	dryRun?: boolean
	orgCursor?: string | null
	memoryCursor?: string | null
	/**
	 * Dry-run resume token: prior pages' would-purge / orphan-would-purge
	 * memory ids for the org being resumed (pass
	 * `nextPlannedPurgeMemoryIds` from the previous page).
	 */
	plannedPurgeMemoryIds?: Array<string> | null
	orgLimit?: number
	memoryLimitPerOrg?: number
	orgIds?: Array<string> | null
	/** When true (default), soft-delete team memories with zero readers. */
	purgeOrphans?: boolean
}): Promise<MemoryPersonalizePurgeResult> {
	const dryRun = input.dryRun !== false
	const purgeOrphans = input.purgeOrphans !== false
	const orgLimit = Math.max(
		1,
		Math.min(input.orgLimit ?? defaultOrgPageSize, 50),
	)
	const memoryLimit = Math.max(
		1,
		Math.min(input.memoryLimitPerOrg ?? defaultMemoryPageSize, 200),
	)
	const warnings: Array<string> = []
	const rows: Array<MemoryPersonalizePurgeRow> = []
	const grantRows: Array<MemoryPersonalizePurgeGrantRow> = []
	let scannedOrgs = 0
	let scannedMemories = 0
	let wouldPurge = 0
	let purged = 0
	let blockedMissingCopy = 0
	let orphanWouldPurge = 0
	let orphanPurged = 0
	let grantsWouldRevoke = 0
	let grantsRevoked = 0
	let vectorCleanupFailed = 0

	const orgs = await listTeamOrgsPage({
		db: input.env.APP_DB,
		afterOrgId: input.orgCursor ?? null,
		limit: orgLimit,
		orgIds: input.orgIds ?? null,
	})

	let nextOrgCursor: string | null = null
	let nextMemoryCursor: string | null = null
	let nextPlannedPurgeMemoryIds: Array<string> = []
	let stopPaging = false
	let lastCompletedOrgId: string | null = input.orgCursor ?? null

	for (let orgIndex = 0; orgIndex < orgs.length; orgIndex++) {
		const org = orgs[orgIndex]!
		scannedOrgs += 1
		/** Soft-deleted this org page but Vectorize cleanup still failing. */
		const pendingVectorMemoryIds = new Set<string>()
		/**
		 * Memories this org will purge (or would, in dry-run). Client-supplied
		 * resume ids are trusted only in dry-run so a real run cannot revoke
		 * grants for still-live memories from forged or leftover tokens.
		 */
		const plannedPurgeMemoryIds = new Set<string>(
			orgIndex === 0 && dryRun ? (input.plannedPurgeMemoryIds ?? []) : [],
		)
		let afterMemoryId: string | null =
			orgIndex === 0 ? (input.memoryCursor ?? null) : null
		let orgMemoryCount = 0
		let orgExhausted = false

		while (orgMemoryCount < memoryLimit) {
			const pageLimit = Math.min(50, memoryLimit - orgMemoryCount)
			const memories = await listMemoriesByUserIdPage({
				db: input.env.APP_DB,
				userId: org.id,
				afterId: afterMemoryId,
				limit: pageLimit,
				statuses: ['active', 'archived'],
			})
			if (memories.length === 0) {
				orgExhausted = true
				break
			}
			for (const memory of memories) {
				scannedMemories += 1
				orgMemoryCount += 1
				afterMemoryId = memory.id
				const readers = await listMemoryReadersForOrgMemory({
					db: input.env.APP_DB,
					orgId: org.id,
					memoryId: memory.id,
				})

				if (readers.length === 0) {
					if (!purgeOrphans) {
						blockedMissingCopy += 1
						rows.push({
							sourceMemoryId: memory.id,
							fromOrgId: org.id,
							fromOrgSlug: org.slug,
							readerCount: 0,
							verifiedCopyCount: 0,
							missingReaderPersonIds: [],
							provenanceUrisChecked: [
								legacyOrgMemoryProvenanceUri(org.id, memory.id),
							],
							outcome: 'blocked_missing_copy',
						})
						continue
					}
					if (dryRun) {
						orphanWouldPurge += 1
						plannedPurgeMemoryIds.add(memory.id)
						rows.push({
							sourceMemoryId: memory.id,
							fromOrgId: org.id,
							fromOrgSlug: org.slug,
							readerCount: 0,
							verifiedCopyCount: 0,
							missingReaderPersonIds: [],
							provenanceUrisChecked: [
								legacyOrgMemoryProvenanceUri(org.id, memory.id),
							],
							outcome: 'orphan_would_purge',
						})
						continue
					}
					const deleted = await softDeleteTeamMemory({
						env: input.env,
						orgId: org.id,
						memory,
					})
					if (deleted.status === 'soft_deleted') {
						orphanPurged += 1
						plannedPurgeMemoryIds.add(memory.id)
						rows.push({
							sourceMemoryId: memory.id,
							fromOrgId: org.id,
							fromOrgSlug: org.slug,
							readerCount: 0,
							verifiedCopyCount: 0,
							missingReaderPersonIds: [],
							provenanceUrisChecked: [
								legacyOrgMemoryProvenanceUri(org.id, memory.id),
							],
							outcome: 'orphan_purged',
						})
						if (!deleted.vectorDeleted) {
							pendingVectorMemoryIds.add(memory.id)
							warnings.push(
								`Soft-deleted orphan memory ${memory.id} on org ${org.slug ?? org.id} but vector cleanup failed; will retry`,
							)
						}
					} else {
						// Live row left in place — grant sweep must not revoke.
						warnings.push(
							`Failed soft-deleting orphan memory ${memory.id} on org ${org.slug ?? org.id}`,
						)
					}
					continue
				}

				const verified = await verifyReadersHaveCopies({
					db: input.env.APP_DB,
					orgId: org.id,
					memory,
					readers,
				})
				if (verified.missingReaderPersonIds.length > 0) {
					blockedMissingCopy += 1
					rows.push({
						sourceMemoryId: memory.id,
						fromOrgId: org.id,
						fromOrgSlug: org.slug,
						readerCount: readers.length,
						verifiedCopyCount: verified.verifiedCopyCount,
						missingReaderPersonIds: verified.missingReaderPersonIds,
						provenanceUrisChecked: verified.provenanceUrisChecked,
						outcome: 'blocked_missing_copy',
					})
					continue
				}

				if (dryRun) {
					wouldPurge += 1
					plannedPurgeMemoryIds.add(memory.id)
					rows.push({
						sourceMemoryId: memory.id,
						fromOrgId: org.id,
						fromOrgSlug: org.slug,
						readerCount: readers.length,
						verifiedCopyCount: verified.verifiedCopyCount,
						missingReaderPersonIds: [],
						provenanceUrisChecked: verified.provenanceUrisChecked,
						outcome: 'would_purge',
					})
					continue
				}

				const deleted = await softDeleteTeamMemory({
					env: input.env,
					orgId: org.id,
					memory,
				})
				if (deleted.status !== 'soft_deleted') {
					// Soft-delete failed while the row may still be live — do not
					// treat as purged; grant sweep keeps grants for live rows.
					const stillLive = await isLiveOrgMemory({
						db: input.env.APP_DB,
						orgId: org.id,
						memoryId: memory.id,
					})
					if (stillLive) {
						warnings.push(
							`Failed soft-deleting memory ${memory.id} on org ${org.slug ?? org.id}`,
						)
						rows.push({
							sourceMemoryId: memory.id,
							fromOrgId: org.id,
							fromOrgSlug: org.slug,
							readerCount: readers.length,
							verifiedCopyCount: verified.verifiedCopyCount,
							missingReaderPersonIds: [],
							provenanceUrisChecked: verified.provenanceUrisChecked,
							outcome: 'soft_delete_failed',
						})
					} else {
						rows.push({
							sourceMemoryId: memory.id,
							fromOrgId: org.id,
							fromOrgSlug: org.slug,
							readerCount: readers.length,
							verifiedCopyCount: verified.verifiedCopyCount,
							missingReaderPersonIds: [],
							provenanceUrisChecked: verified.provenanceUrisChecked,
							outcome: 'already_gone',
						})
					}
					continue
				}
				purged += 1
				plannedPurgeMemoryIds.add(memory.id)
				rows.push({
					sourceMemoryId: memory.id,
					fromOrgId: org.id,
					fromOrgSlug: org.slug,
					readerCount: readers.length,
					verifiedCopyCount: verified.verifiedCopyCount,
					missingReaderPersonIds: [],
					provenanceUrisChecked: verified.provenanceUrisChecked,
					outcome: 'purged',
				})
				if (!deleted.vectorDeleted) {
					pendingVectorMemoryIds.add(memory.id)
					warnings.push(
						`Soft-deleted memory ${memory.id} on org ${org.slug ?? org.id} but vector cleanup failed; will retry`,
					)
				}
			}
			if (memories.length < pageLimit) {
				orgExhausted = true
				break
			}
		}

		if (!orgExhausted) {
			const peek = await listMemoriesByUserIdPage({
				db: input.env.APP_DB,
				userId: org.id,
				afterId: afterMemoryId,
				limit: 1,
				statuses: ['active', 'archived'],
			})
			if (peek.length > 0) {
				// Retry and count pending Vectorize deletes before leaving a
				// partial org page so failures are not dropped from this run.
				if (!dryRun) {
					// Mid-org: retry only this page's pending deletes. The bounded
					// stranded-row scan runs once the org is exhausted.
					vectorCleanupFailed += await reconcileOrgVectorCleanup({
						env: input.env,
						orgId: org.id,
						orgSlug: org.slug,
						memoryLimit,
						pendingVectorMemoryIds,
						warnings,
						includeStrandedPage: false,
					})
				}
				nextOrgCursor = lastCompletedOrgId
				nextMemoryCursor = afterMemoryId
				nextPlannedPurgeMemoryIds = [...plannedPurgeMemoryIds]
				warnings.push(
					`Org ${org.slug ?? org.id} has more memories after ${afterMemoryId}; resume with orgCursor=${nextOrgCursor ?? '(start)'} memoryCursor=${nextMemoryCursor} plannedPurgeMemoryIds=${nextPlannedPurgeMemoryIds.length}.`,
				)
				stopPaging = true
				break
			}
			orgExhausted = true
		}

		// Retry Vectorize deletes for this-run failures and a bounded page of
		// soft-deleted rows still pending vector cleanup, before grant sweep.
		if (!dryRun) {
			vectorCleanupFailed += await reconcileOrgVectorCleanup({
				env: input.env,
				orgId: org.id,
				orgSlug: org.slug,
				memoryLimit,
				pendingVectorMemoryIds,
				warnings,
			})
		}

		// Revoke obsolete memory grants only when this run purged the memory
		// (or would, in dry-run — including earlier pages via
		// plannedPurgeMemoryIds) or the row is no longer live. Live rows that
		// failed soft-delete, stayed blocked, or were blocked on an earlier
		// page keep their grants so readers remain visible on retry.
		const memoryGrants = await listGrants({
			db: input.env.APP_DB,
			orgId: org.id,
			resourceType: 'memory',
		})
		const liveMemoryIds = await listLiveOrgMemoryIds({
			db: input.env.APP_DB,
			orgId: org.id,
			memoryIds: memoryGrants.map((grant) => grant.resourceId),
		})
		for (const grant of memoryGrants) {
			const purgedNow = plannedPurgeMemoryIds.has(grant.resourceId)
			if (!purgedNow && liveMemoryIds.has(grant.resourceId)) continue
			if (dryRun) {
				grantsWouldRevoke += 1
				grantRows.push({
					grantId: grant.id,
					orgId: org.id,
					orgSlug: org.slug,
					resourceId: grant.resourceId,
					outcome: 'would_revoke',
				})
				continue
			}
			try {
				await softDeleteGrant({
					db: input.env.APP_DB,
					orgId: org.id,
					grantId: grant.id,
					audit: input.audit,
				})
				grantsRevoked += 1
				grantRows.push({
					grantId: grant.id,
					orgId: org.id,
					orgSlug: org.slug,
					resourceId: grant.resourceId,
					outcome: 'revoked',
				})
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				warnings.push(
					`Failed revoking memory grant ${grant.id} on org ${org.slug ?? org.id}: ${message}`,
				)
				grantRows.push({
					grantId: grant.id,
					orgId: org.id,
					orgSlug: org.slug,
					resourceId: grant.resourceId,
					outcome: 'skipped_error',
					error: message,
				})
			}
		}

		lastCompletedOrgId = org.id
	}

	if (!stopPaging) {
		nextOrgCursor = orgs.length === orgLimit ? (orgs.at(-1)?.id ?? null) : null
		nextMemoryCursor = null
		nextPlannedPurgeMemoryIds = []
	}

	return {
		dryRun,
		scannedOrgs,
		scannedMemories,
		wouldPurge,
		purged,
		blockedMissingCopy,
		orphanWouldPurge,
		orphanPurged,
		grantsWouldRevoke,
		grantsRevoked,
		vectorCleanupFailed,
		rows,
		grantRows,
		nextOrgCursor,
		nextMemoryCursor,
		nextPlannedPurgeMemoryIds,
		warnings,
	}
}
