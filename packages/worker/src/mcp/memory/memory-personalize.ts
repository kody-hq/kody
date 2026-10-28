/**
 * Copy team-org memories to every person with effective memory:read at snapshot
 * time (ADR 0072). Originals stay on the team org (write-frozen); copies land
 * in each reader's personal org with provenance. Idempotent via provenance URI.
 */
import {
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { parseJsonStringArray } from '@kody-internal/shared/json-parsing.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import { listOrgMembers } from '#worker/orgs/org-members-list.ts'
import {
	type GrantSubjectType,
	listGrants,
} from '#worker/orgs/access-writes.ts'
import { listTeamMembers } from '#worker/orgs/org-teams-list.ts'
import { isPersonalOrg } from '#worker/orgs/is-personal-org.ts'
import { loadPersonalOrgIdForPerson } from '#worker/orgs/personal-org-id.ts'
import { personalOrgIdSql } from '#worker/orgs/personal-org-sql.ts'
import {
	assertWithinStorageBytesEntitlement,
	estimateEntitlementStorageEntryByteDelta,
} from '#worker/entitlements/service.ts'
import { buildMemoryEmbedTextFromRow } from './memory-embed.ts'
import { legacyOrgMemoryProvenanceUri } from './memory-owner.ts'
import { insertMemory, listMemoriesByUserIdPage } from './repo.ts'
import { upsertMemoryVector } from './memory-vectorize.ts'
import { type McpMemoryRow } from './types.ts'

const defaultOrgPageSize = 20
const defaultMemoryPageSize = 50

export type MemoryPersonalizeCopyOutcome =
	| 'copied'
	| 'skipped_already_copied'
	| 'skipped_content_duplicate'
	| 'would_copy'
	| 'orphan_no_reader'

export type MemoryPersonalizeCopyRow = {
	sourceMemoryId: string
	fromOrgId: string
	fromOrgSlug: string | null
	personId: string | null
	toOrgId: string | null
	newMemoryId: string | null
	outcome: MemoryPersonalizeCopyOutcome
}

export type MemoryPersonalizeCopyResult = {
	dryRun: boolean
	scannedOrgs: number
	scannedMemories: number
	copied: number
	skippedAlreadyCopied: number
	skippedContentDuplicate: number
	wouldCopy: number
	orphanNoReader: number
	rows: Array<MemoryPersonalizeCopyRow>
	/** Exclusive keyset: next call passes this as `orgCursor`. */
	nextOrgCursor: string | null
	/**
	 * When non-null, the org after `nextOrgCursor` still has memories past this
	 * id. Pass both cursors back to resume that org; only advance past the org
	 * once this is null.
	 */
	nextMemoryCursor: string | null
	warnings: Array<string>
}

function grantIncludesMemoryRead(permissions: Array<string>) {
	return permissions.includes('memory:read')
}

async function expandGrantSubjectsToPersonIds(input: {
	db: D1Database
	orgId: string
	subjectType: GrantSubjectType
	subjectId: string
}): Promise<Array<string>> {
	if (input.subjectType === 'user') return [input.subjectId]
	if (input.subjectType === 'org') {
		if (input.subjectId !== input.orgId) return []
		const members = await listOrgMembers(input.db, input.orgId)
		return members.map((member) => member.userId)
	}
	const members = await listTeamMembers(input.db, input.orgId, input.subjectId)
	return members.map((member) => member.userId)
}

/**
 * People with effective memory:read on one memory in a team org: owners, plus
 * org-wide memory:read grantees, plus per-memory memory:read grantees (user,
 * team, and everyone-in-org subjects expanded).
 */
export async function listMemoryReadersForOrgMemory(input: {
	db: D1Database
	orgId: string
	memoryId: string
}): Promise<Array<PersonId>> {
	const readers = new Set<string>()
	const members = await listOrgMembers(input.db, input.orgId)
	for (const member of members) {
		if (member.role === 'owner') readers.add(member.userId)
	}

	const orgGrants = await listGrants({
		db: input.db,
		orgId: input.orgId,
		resourceType: 'org',
		resourceId: input.orgId,
	})
	for (const grant of orgGrants) {
		if (!grantIncludesMemoryRead(grant.permissions)) continue
		const subjectType = grant.subjectType
		for (const personId of await expandGrantSubjectsToPersonIds({
			db: input.db,
			orgId: input.orgId,
			subjectType,
			subjectId: grant.subjectId,
		})) {
			readers.add(personId)
		}
	}

	const memoryGrants = await listGrants({
		db: input.db,
		orgId: input.orgId,
		resourceType: 'memory',
		resourceId: input.memoryId,
	})
	for (const grant of memoryGrants) {
		if (!grantIncludesMemoryRead(grant.permissions)) continue
		const subjectType = grant.subjectType
		for (const personId of await expandGrantSubjectsToPersonIds({
			db: input.db,
			orgId: input.orgId,
			subjectType,
			subjectId: grant.subjectId,
		})) {
			readers.add(personId)
		}
	}

	return [...readers] as Array<PersonId>
}

/** Team orgs only (excludes personal). Shared by copy and verified purge. */
export async function listTeamOrgsPage(input: {
	db: D1Database
	afterOrgId: string | null
	limit: number
	orgIds?: Array<string> | null
}): Promise<Array<{ id: string; slug: string | null }>> {
	if (input.orgIds && input.orgIds.length > 0) {
		const filtered: Array<{ id: string; slug: string | null }> = []
		for (const orgId of input.orgIds) {
			if (input.afterOrgId && orgId <= input.afterOrgId) continue
			if (await isPersonalOrg(input.db, orgId)) continue
			// Alias `o.id` so this is not mistaken for the account write-lease
			// `SELECT deleting_at FROM orgs WHERE id = ?` probe.
			const row = await input.db
				.prepare(
					`SELECT o.id AS id, o.slug AS slug
					 FROM orgs o
					 WHERE o.id = ?
					   AND o.deleted_at IS NULL
					   AND o.deleting_at IS NULL`,
				)
				.bind(orgId)
				.first<{ id: string; slug: string | null }>()
			if (row) filtered.push(row)
		}
		filtered.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		return filtered.slice(0, input.limit)
	}

	const { results } = await input.db
		.prepare(
			`SELECT o.id AS id, o.slug AS slug
			 FROM orgs o
			 WHERE o.id > ?
			   AND o.deleted_at IS NULL
			   AND o.deleting_at IS NULL
			   AND NOT EXISTS (
			     SELECT 1 FROM users u
			     WHERE ${personalOrgIdSql} = o.id
			       AND u.deleted_at IS NULL
			   )
			 ORDER BY o.id
			 LIMIT ?`,
		)
		.bind(input.afterOrgId ?? '', input.limit)
		.all<{ id: string; slug: string | null }>()
	return results ?? []
}

type PersonalSkip =
	| {
			reason: 'skipped_already_copied'
			existing: McpMemoryRow
	  }
	| {
			reason: 'skipped_content_duplicate'
			existing: McpMemoryRow
	  }

/** Exported for verified purge: prove a personal copy exists before deleting. */
export async function findPersonalSkip(input: {
	db: D1Database
	personalOrgId: OwnerId
	source: McpMemoryRow
	provenanceUri: string
}): Promise<PersonalSkip | null> {
	let afterId: string | null = null
	while (true) {
		const rows = await listMemoriesByUserIdPage({
			db: input.db,
			userId: input.personalOrgId,
			afterId,
			limit: 100,
			statuses: ['active', 'archived'],
		})
		for (const row of rows) {
			const uris = parseJsonStringArray(row.source_uris_json)
			if (uris.includes(input.provenanceUri)) {
				return { reason: 'skipped_already_copied', existing: row }
			}
			if (
				row.subject === input.source.subject &&
				row.summary === input.source.summary &&
				row.details === input.source.details
			) {
				return { reason: 'skipped_content_duplicate', existing: row }
			}
		}
		if (rows.length < 100) break
		afterId = rows.at(-1)?.id ?? null
		if (!afterId) break
	}
	return null
}

async function personEmailForEntitlement(
	db: D1Database,
	personId: PersonId,
): Promise<string | null> {
	const row = await db
		.prepare(
			`SELECT email FROM users
			 WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(personId)
		.first<{ email: string | null }>()
	return row?.email ?? null
}

async function copyOneMemoryToPerson(input: {
	env: Env
	source: McpMemoryRow
	fromOrgId: string
	fromOrgSlug: string | null
	personId: PersonId
	dryRun: boolean
}): Promise<MemoryPersonalizeCopyRow> {
	const toOrgId = await loadPersonalOrgIdForPerson(
		input.env.APP_DB,
		input.personId,
	)
	const provenanceUri = legacyOrgMemoryProvenanceUri(
		input.fromOrgId,
		input.source.id,
	)
	const skip = await findPersonalSkip({
		db: input.env.APP_DB,
		personalOrgId: toOrgId,
		source: input.source,
		provenanceUri,
	})
	if (skip) {
		if (!input.dryRun && skip.reason === 'skipped_already_copied') {
			// Reconcile Vectorize if a prior insert landed without an embedding.
			await upsertMemoryVector(input.env, {
				memoryId: skip.existing.id,
				userId: toOrgId,
				category: skip.existing.category,
				status: skip.existing.status,
				embedText: buildMemoryEmbedTextFromRow(skip.existing),
			})
		}
		return {
			sourceMemoryId: input.source.id,
			fromOrgId: input.fromOrgId,
			fromOrgSlug: input.fromOrgSlug,
			personId: input.personId,
			toOrgId,
			newMemoryId: skip.existing.id,
			outcome: skip.reason,
		}
	}
	if (input.dryRun) {
		return {
			sourceMemoryId: input.source.id,
			fromOrgId: input.fromOrgId,
			fromOrgSlug: input.fromOrgSlug,
			personId: input.personId,
			toOrgId,
			newMemoryId: null,
			outcome: 'would_copy',
		}
	}

	const now = new Date().toISOString()
	const sourceUris = parseJsonStringArray(input.source.source_uris_json)
	if (!sourceUris.includes(provenanceUri)) sourceUris.push(provenanceUri)
	// Keep source details intact; provenance URI records the legacy origin.
	const details = input.source.details
	const newId = crypto.randomUUID()
	const row: McpMemoryRow = {
		id: newId,
		user_id: toOrgId,
		category: input.source.category,
		status:
			input.source.status === 'deleted' ? 'archived' : input.source.status,
		subject: input.source.subject,
		summary: input.source.summary,
		details,
		tags_json: input.source.tags_json,
		source_uris_json: JSON.stringify(sourceUris),
		dedupe_key: input.source.dedupe_key,
		created_at: now,
		updated_at: now,
		last_accessed_at: null,
		deleted_at: null,
	}

	await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: toOrgId,
		env: input.env,
		async write() {
			const email = await personEmailForEntitlement(
				input.env.APP_DB,
				input.personId,
			)
			await assertWithinStorageBytesEntitlement({
				db: input.env.APP_DB,
				env: input.env,
				userId: toOrgId,
				email,
				requested: estimateEntitlementStorageEntryByteDelta({
					next: {
						key: row.id,
						value: {
							category: row.category,
							status: row.status,
							subject: row.subject,
							summary: row.summary,
							details: row.details,
							tagsJson: row.tags_json,
							sourceUrisJson: row.source_uris_json,
							dedupeKey: row.dedupe_key,
						},
					},
					existing: null,
				}),
			})
			await insertMemory(input.env.APP_DB, row)
			await upsertMemoryVector(input.env, {
				memoryId: row.id,
				userId: toOrgId,
				category: row.category,
				status: row.status,
				embedText: buildMemoryEmbedTextFromRow(row),
			})
		},
	})

	return {
		sourceMemoryId: input.source.id,
		fromOrgId: input.fromOrgId,
		fromOrgSlug: input.fromOrgSlug,
		personId: input.personId,
		toOrgId,
		newMemoryId: newId,
		outcome: 'copied',
	}
}

export async function runMemoryPersonalizeCopy(input: {
	env: Env
	dryRun?: boolean
	orgCursor?: string | null
	/** Resume memories inside the first org after `orgCursor`. */
	memoryCursor?: string | null
	orgLimit?: number
	memoryLimitPerOrg?: number
	orgIds?: Array<string> | null
}): Promise<MemoryPersonalizeCopyResult> {
	const dryRun = input.dryRun !== false
	const orgLimit = Math.max(
		1,
		Math.min(input.orgLimit ?? defaultOrgPageSize, 50),
	)
	const memoryLimit = Math.max(
		1,
		Math.min(input.memoryLimitPerOrg ?? defaultMemoryPageSize, 200),
	)
	const warnings: Array<string> = []
	const rows: Array<MemoryPersonalizeCopyRow> = []
	let scannedOrgs = 0
	let scannedMemories = 0
	let copied = 0
	let skippedAlreadyCopied = 0
	let skippedContentDuplicate = 0
	let wouldCopy = 0
	let orphanNoReader = 0

	const orgs = await listTeamOrgsPage({
		db: input.env.APP_DB,
		afterOrgId: input.orgCursor ?? null,
		limit: orgLimit,
		orgIds: input.orgIds ?? null,
	})

	let nextOrgCursor: string | null = null
	let nextMemoryCursor: string | null = null
	let stopPaging = false
	/** Last fully-finished org id in this invocation (exclusive resume point). */
	let lastCompletedOrgId: string | null = input.orgCursor ?? null

	for (let orgIndex = 0; orgIndex < orgs.length; orgIndex++) {
		const org = orgs[orgIndex]!
		scannedOrgs += 1
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
					orphanNoReader += 1
					rows.push({
						sourceMemoryId: memory.id,
						fromOrgId: org.id,
						fromOrgSlug: org.slug,
						personId: null,
						toOrgId: null,
						newMemoryId: null,
						outcome: 'orphan_no_reader',
					})
					continue
				}
				for (const personId of readers) {
					try {
						const result = await copyOneMemoryToPerson({
							env: input.env,
							source: memory,
							fromOrgId: org.id,
							fromOrgSlug: org.slug,
							personId,
							dryRun,
						})
						rows.push(result)
						switch (result.outcome) {
							case 'copied':
								copied += 1
								break
							case 'would_copy':
								wouldCopy += 1
								break
							case 'skipped_already_copied':
								skippedAlreadyCopied += 1
								break
							case 'skipped_content_duplicate':
								skippedContentDuplicate += 1
								break
							case 'orphan_no_reader':
								orphanNoReader += 1
								break
							default: {
								const _exhaustive: never = result.outcome
								void _exhaustive
							}
						}
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error)
						warnings.push(
							`Failed copying memory ${memory.id} to person ${personId}: ${message}`,
						)
					}
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
				nextOrgCursor = lastCompletedOrgId
				nextMemoryCursor = afterMemoryId
				warnings.push(
					`Org ${org.slug ?? org.id} has more memories after ${afterMemoryId}; resume with orgCursor=${nextOrgCursor ?? '(start)'} memoryCursor=${nextMemoryCursor}.`,
				)
				stopPaging = true
				break
			}
			orgExhausted = true
		}

		lastCompletedOrgId = org.id
	}

	if (!stopPaging) {
		nextOrgCursor = orgs.length === orgLimit ? (orgs.at(-1)?.id ?? null) : null
		nextMemoryCursor = null
	}

	return {
		dryRun,
		scannedOrgs,
		scannedMemories,
		copied,
		skippedAlreadyCopied,
		skippedContentDuplicate,
		wouldCopy,
		orphanNoReader,
		rows,
		nextOrgCursor,
		nextMemoryCursor,
		warnings,
	}
}
