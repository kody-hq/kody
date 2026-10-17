import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { withAccountWriteLease } from '#worker/account/deletion-state.ts'
import { type StorageContext } from '#mcp/storage.ts'
import { type ResourceListScope } from '#worker/authorization/authorize.ts'
import {
	isCapabilitySearchOffline,
	type EmbedTextFn,
} from '#worker/vectorize/embedding.ts'
import {
	acknowledgeSurfacedMemoryWrites,
	deleteMemory as deleteMemoryRow,
	getConversationSuppressions,
	getMemoryById,
	insertMemory,
	listMemoriesByIds,
	listMemoriesByUserId,
	pruneExpiredConversationSuppressions,
	updateMemory,
} from './repo.ts'
import { parseJsonStringArray } from '@kody-internal/shared/json-parsing.ts'
import { buildMemoryEmbedText } from './memory-embed.ts'
import { deleteMemoryVector, upsertMemoryVector } from './memory-vectorize.ts'
import {
	queryMemoryVectorIds,
	rankMemoryVectorIdsWithin,
	searchMemories,
} from './memory-search.ts'
import {
	assertWithinStorageBytesEntitlement,
	estimateEntitlementStorageEntryByteDelta,
} from '#worker/entitlements/service.ts'
import { type UserMeterEnv } from '#worker/entitlements/user-meter-client.ts'
import {
	type McpMemoryRow,
	type MemoryRecord,
	type MemorySearchMatch,
} from './types.ts'
import { assertPersonalMemoryWritable } from './memory-owner.ts'

const maxSubjectLength = 200
const maxSummaryLength = 500
const maxDetailsLength = 2_000
const maxCategoryLength = 80
const maxDedupeKeyLength = 160
const maxTagLength = 80
const maxTagCount = 16
const maxSourceUriLength = 2_048
const maxSourceUriCount = 12
/** Per-handle hide after a memory is surfaced; unused if the id is never echoed. */
const defaultSuppressionTtlMs = 30 * 24 * 60 * 60 * 1_000
/** Offline (no Vectorize): lexical + deterministic ranking over recent rows. */
const memoryOfflineCandidateLimit = 200
/** Online: bounded recent-row set fused with Vectorize top hits via RRF. */
const memoryLexicalCandidateLimit = 50
const memoryVectorTopKCap = 100
export const memorySearchMutationGuidance =
	'This result is mutable for the signed-in user. Use this exact id as memory_id with metaMemoryUpsert or metaMemoryDelete after metaMemoryVerify.'

export function getMemoryMutationNotFoundMessage(memoryId: string) {
	return `Memory ${JSON.stringify(memoryId)} was not found in mutable memory storage for this signed-in user. If this id came from metaMemorySearch or metaMemoryVerify, copy the full id exactly and retry. If the exact id still fails, rerun metaMemorySearch/metaMemoryVerify to find the current mutable memory or create a replacement by omitting memory_id; the original id may be stale, deleted, owned by another user, or no longer identify a mutable memory.`
}

function logMemoryVectorSyncError(input: {
	operation: 'upsert' | 'delete'
	memoryId: string
	userId: OwnerId
	category: string | null
	error: unknown
}) {
	console.warn('memory-vector-sync-failed', {
		operation: input.operation,
		memoryId: input.memoryId,
		userId: input.userId,
		category: input.category,
		error: getErrorMessage(input.error),
	})
}

type MemoryOwnerContext = {
	userId: OwnerId
	userEmail?: string | null
	storageContext?: StorageContext | null
}

type MemoryEnv = Pick<Env, 'APP_DB'> &
	Partial<Pick<Env, 'CAPABILITY_VECTOR_INDEX'>> &
	UserMeterEnv

type MemoryUpsertInput = MemoryOwnerContext & {
	env: MemoryEnv
	memoryId?: string | null
	category?: string | null
	subject: string
	summary: string
	details?: string | null
	tags?: Array<string> | null
	sourceUris?: Array<string> | null
	dedupeKey?: string | null
	status?: 'active' | 'archived'
	verificationReference?: string | null
	waitUntil?: (promise: Promise<unknown>) => void
}

type MemoryDeleteInput = MemoryOwnerContext & {
	env: MemoryEnv
	memoryId: string
	force?: boolean
}

type MemoryGetInput = MemoryOwnerContext & {
	env: Pick<Env, 'APP_DB'>
	memoryId: string
	includeDeleted?: boolean
}

type MemorySearchInput = MemoryOwnerContext & {
	env: MemoryEnv
	/** Memories the caller may read (`memory:read`). */
	scope: ResourceListScope
	query: string
	category?: string | null
	limit?: number
	includeDeleted?: boolean
	conversationId?: string | null
	includeSuppressedInConversation?: boolean
	embedText?: EmbedTextFn
}

type MemoryVerifyInput = MemoryOwnerContext & {
	env: MemoryEnv
	scope: ResourceListScope
	candidate: {
		subject: string
		summary: string
		details?: string | null
		category?: string | null
		tags?: Array<string> | null
		sourceUris?: Array<string> | null
		dedupeKey?: string | null
	}
	limit?: number
	conversationId?: string | null
	includeSuppressedInConversation?: boolean
}

type SurfaceRelevantMemoriesInput = MemoryOwnerContext & {
	env: MemoryEnv
	scope: ResourceListScope
	query: string
	conversationId: string
	limit?: number
	acknowledgeSurfaced?: boolean
}

/**
 * Marks memories as surfaced for one conversation handle so later enrichment
 * on that same handle does not repeat them. A different handle, including a
 * server-minted id from another chat, stays visible.
 */
export async function acknowledgeSurfacedMemories(input: {
	env: MemoryEnv
	userId: OwnerId
	conversationId: string
	memoryIds: Array<string>
}) {
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.userId,
		env: input.env,
		async write() {
			const memoryIds = Array.from(
				new Set(input.memoryIds.filter((id) => id.trim().length > 0)),
			)
			if (memoryIds.length === 0) return
			const expiresAt = new Date(
				Date.now() + defaultSuppressionTtlMs,
			).toISOString()
			await acknowledgeSurfacedMemoryWrites({
				db: input.env.APP_DB,
				userId: input.userId,
				conversationId: input.conversationId,
				memoryIds,
				expiresAt,
			})
		},
	})
}

export async function upsertMemory(input: MemoryUpsertInput): Promise<{
	mode: 'created' | 'updated'
	memory: MemoryRecord
	warnings: Array<string>
}> {
	await assertPersonalMemoryWritable(input.env.APP_DB, input.userId)
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.userId,
		env: input.env,
		async write() {
			const normalized = normalizeMemoryPayload(input)
			const now = new Date().toISOString()
			const existing = input.memoryId
				? await getMemoryById(input.env.APP_DB, input.userId, input.memoryId)
				: null
			if (input.memoryId && !existing) {
				throw new Error(getMemoryMutationNotFoundMessage(input.memoryId))
			}
			const status = input.status ?? 'active'
			const row: McpMemoryRow = existing
				? {
						...existing,
						category: normalized.category,
						status,
						subject: normalized.subject,
						summary: normalized.summary,
						details: normalized.details,
						tags_json: JSON.stringify(normalized.tags),
						source_uris_json: JSON.stringify(normalized.sourceUris),
						dedupe_key: normalized.dedupeKey,
						updated_at: now,
						deleted_at: null,
					}
				: {
						id: crypto.randomUUID(),
						user_id: input.userId,
						category: normalized.category,
						status,
						subject: normalized.subject,
						summary: normalized.summary,
						details: normalized.details,
						tags_json: JSON.stringify(normalized.tags),
						source_uris_json: JSON.stringify(normalized.sourceUris),
						dedupe_key: normalized.dedupeKey,
						created_at: now,
						updated_at: now,
						last_accessed_at: null,
						deleted_at: null,
					}

			await assertWithinStorageBytesEntitlement({
				db: input.env.APP_DB,
				env: input.env,
				userId: input.userId,
				email: input.userEmail,
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
					existing: existing
						? {
								key: existing.id,
								value: {
									category: existing.category,
									status: existing.status,
									subject: existing.subject,
									summary: existing.summary,
									details: existing.details,
									tagsJson: existing.tags_json,
									sourceUrisJson: existing.source_uris_json,
									dedupeKey: existing.dedupe_key,
								},
							}
						: null,
				}),
			})

			if (existing) {
				const updated = await updateMemory(
					input.env.APP_DB,
					input.userId,
					row.id,
					{
						category: row.category,
						status: row.status,
						subject: row.subject,
						summary: row.summary,
						details: row.details,
						tags_json: row.tags_json,
						source_uris_json: row.source_uris_json,
						dedupe_key: row.dedupe_key,
						last_accessed_at: row.last_accessed_at,
						deleted_at: row.deleted_at,
					},
				)
				if (!updated) {
					throw new Error(
						getMemoryMutationNotFoundMessage(input.memoryId ?? row.id),
					)
				}
			} else {
				await insertMemory(input.env.APP_DB, row)
			}

			try {
				await upsertMemoryVector(input.env as Env, {
					memoryId: row.id,
					userId: input.userId,
					category: row.category,
					status: row.status,
					embedText: buildMemoryEmbedText({
						category: row.category,
						subject: row.subject,
						summary: row.summary,
						details: row.details,
						tags: normalized.tags,
						dedupeKey: row.dedupe_key,
					}),
				})
			} catch (error) {
				logMemoryVectorSyncError({
					operation: 'upsert',
					memoryId: row.id,
					userId: input.userId,
					category: row.category,
					error,
				})
			}

			const warnings =
				input.verificationReference == null ||
				input.verificationReference.trim() === ''
					? [
							'No verification_reference was supplied. Agents should run metaMemoryVerify first and include a verification reference when possible.',
						]
					: []

			return {
				mode: existing ? 'updated' : 'created',
				memory: toMemoryRecord(row),
				warnings,
			}
		},
	})
}

export async function deleteMemory(
	input: MemoryDeleteInput,
): Promise<MemoryRecord | null> {
	await assertPersonalMemoryWritable(input.env.APP_DB, input.userId)
	return await withAccountWriteLease({
		db: input.env.APP_DB,
		stableUserId: input.userId,
		env: input.env,
		async write() {
			const existing = await getMemoryById(
				input.env.APP_DB,
				input.userId,
				input.memoryId,
				{ includeDeleted: input.force === true },
			)
			if (!existing) return null

			if (input.force) {
				const deleted = await deleteMemoryRow(
					input.env.APP_DB,
					input.userId,
					input.memoryId,
					{ force: true },
				)
				if (!deleted) return null
				try {
					await deleteMemoryVector(input.env as Env, input.memoryId)
				} catch (error) {
					logMemoryVectorSyncError({
						operation: 'delete',
						memoryId: input.memoryId,
						userId: input.userId,
						category: existing.category,
						error,
					})
				}
				return toMemoryRecord(existing)
			}

			const now = new Date().toISOString()
			const updated = await updateMemory(
				input.env.APP_DB,
				input.userId,
				input.memoryId,
				{
					category: existing.category,
					status: 'deleted',
					subject: existing.subject,
					summary: existing.summary,
					details: existing.details,
					tags_json: existing.tags_json,
					source_uris_json: existing.source_uris_json,
					dedupe_key: existing.dedupe_key,
					last_accessed_at: existing.last_accessed_at,
					deleted_at: now,
				},
			)
			if (!updated) return null

			const deletedRow = {
				...existing,
				status: 'deleted' as const,
				deleted_at: now,
				updated_at: now,
			}
			try {
				await upsertMemoryVector(input.env as Env, {
					memoryId: deletedRow.id,
					userId: input.userId,
					category: deletedRow.category,
					status: deletedRow.status,
					embedText: buildMemoryEmbedText({
						category: deletedRow.category,
						subject: deletedRow.subject,
						summary: deletedRow.summary,
						details: deletedRow.details,
						tags: parseTags(deletedRow.tags_json),
						dedupeKey: deletedRow.dedupe_key,
					}),
				})
			} catch (error) {
				logMemoryVectorSyncError({
					operation: 'upsert',
					memoryId: deletedRow.id,
					userId: input.userId,
					category: deletedRow.category,
					error,
				})
			}
			return toMemoryRecord(deletedRow)
		},
	})
}

export async function getMemory(
	input: MemoryGetInput,
): Promise<MemoryRecord | null> {
	const row = await getMemoryById(
		input.env.APP_DB,
		input.userId,
		input.memoryId,
		{ includeDeleted: input.includeDeleted },
	)
	return row ? toMemoryRecord(row) : null
}

export async function searchMemoryRecords(input: MemorySearchInput): Promise<{
	query: string
	matches: Array<MemorySearchMatch>
	suppressedCount: number
}> {
	const query = input.query.trim()
	if (!query) {
		return { query: '', matches: [], suppressedCount: 0 }
	}
	const statuses: Array<McpMemoryRow['status']> = input.includeDeleted
		? ['active', 'archived', 'deleted']
		: ['active', 'archived']
	const targetLimit = normalizeLimit(input.limit)
	const category = normalizeOptionalString(input.category, maxCategoryLength)
	const offline = isCapabilitySearchOffline(input.env as Env)

	let rows: Array<McpMemoryRow>
	let vectorRankedIds: Array<string> | undefined
	if (input.scope.kind === 'granted') {
		rows = await listMemoriesByIds(input.env.APP_DB, input.userId, {
			ids: [...input.scope.ids],
			statuses,
		})
		if (!offline) {
			vectorRankedIds = await rankMemoryVectorIdsWithin({
				env: input.env as Env,
				query,
				userId: input.userId,
				memoryIds: rows.map((row) => row.id),
				...(input.embedText ? { embedText: input.embedText } : {}),
			})
		}
	} else if (offline) {
		rows = await listMemoriesByUserId(input.env.APP_DB, input.userId, {
			statuses,
			limit: memoryOfflineCandidateLimit,
		})
	} else {
		// Vectorize-first: query the index with metadata filters, hydrate only
		// the top-hit rows from D1 by id, and merge with a bounded set of
		// recent rows as the lexical candidate list.
		const [recentRows, rankedIds] = await Promise.all([
			listMemoriesByUserId(input.env.APP_DB, input.userId, {
				statuses,
				limit: memoryLexicalCandidateLimit,
			}),
			queryMemoryVectorIds({
				env: input.env as Env,
				query,
				userId: input.userId,
				statuses,
				category,
				topK: Math.min(
					Math.max(memoryLexicalCandidateLimit, targetLimit * 5),
					memoryVectorTopKCap,
				),
				...(input.embedText ? { embedText: input.embedText } : {}),
			}),
		])
		vectorRankedIds = rankedIds
		const recentIds = new Set(recentRows.map((row) => row.id))
		const missingIds = rankedIds.filter((id) => !recentIds.has(id))
		const hydratedRows = await listMemoriesByIds(
			input.env.APP_DB,
			input.userId,
			{
				ids: missingIds,
				statuses,
			},
		)
		rows = [...recentRows, ...hydratedRows]
	}
	const filteredRows = rows.filter((row) => {
		if (!category) return true
		return row.category === category
	})
	const rankedLimit = Math.min(filteredRows.length, targetLimit * 5)
	const { matches } = await searchMemories({
		env: input.env as Env,
		query,
		limit: rankedLimit,
		userId: input.userId,
		statuses,
		category,
		rows: filteredRows,
		...(vectorRankedIds ? { vectorRankedIds } : {}),
		...(input.embedText ? { embedText: input.embedText } : {}),
	})
	const filtered = await filterSuppressedMatches({
		db: input.env.APP_DB,
		userId: input.userId,
		conversationId: input.conversationId ?? null,
		includeSuppressedInConversation:
			input.includeSuppressedInConversation ?? false,
		matches,
	})
	return {
		query,
		matches: filtered.matches.slice(0, targetLimit),
		suppressedCount: filtered.suppressedCount,
	}
}

export async function verifyMemoryCandidate(input: MemoryVerifyInput): Promise<{
	candidate: {
		subject: string
		summary: string
		details: string
		category: string | null
		tags: Array<string>
		source_uris: Array<string>
		dedupe_key: string | null
	}
	relatedMemories: Array<{ memory: MemoryRecord; score: number }>
	suppressedCount: number
}> {
	const candidate = normalizeMemoryPayload(input.candidate)
	const query = buildVerifyQuery(candidate)
	const result = await searchMemoryRecords({
		env: input.env,
		userId: input.userId,
		scope: input.scope,
		storageContext: input.storageContext,
		query,
		limit: input.limit,
		conversationId: input.conversationId ?? null,
		includeSuppressedInConversation:
			input.includeSuppressedInConversation ?? false,
	})
	return {
		candidate: {
			subject: candidate.subject,
			summary: candidate.summary,
			details: candidate.details,
			category: candidate.category,
			tags: candidate.tags,
			source_uris: candidate.sourceUris,
			dedupe_key: candidate.dedupeKey,
		},
		relatedMemories: result.matches.map((match) => ({
			memory: mapSearchMatchToMemoryRecord(match),
			score: match.score,
		})),
		suppressedCount: result.suppressedCount,
	}
}

export async function surfaceRelevantMemories(
	input: SurfaceRelevantMemoriesInput,
): Promise<{
	memories: Array<MemoryRecord>
	suppressedCount: number
	retrievalQuery: string
}> {
	await pruneExpiredConversationSuppressions(input.env.APP_DB)
	const result = await searchMemoryRecords({
		env: input.env,
		userId: input.userId,
		scope: input.scope,
		storageContext: input.storageContext,
		query: input.query,
		limit: input.limit,
		conversationId: input.conversationId,
		includeSuppressedInConversation: false,
	})
	if (result.matches.length === 0) {
		return {
			memories: [],
			suppressedCount: result.suppressedCount,
			retrievalQuery: result.query,
		}
	}

	const memories = result.matches.map(mapSearchMatchToMemoryRecord)
	const acknowledgeSurfaced = input.acknowledgeSurfaced !== false
	const memoryIds = memories.map((memory) => memory.id)
	if (acknowledgeSurfaced && memoryIds.length > 0) {
		await acknowledgeSurfacedMemories({
			env: input.env,
			userId: input.userId,
			conversationId: input.conversationId,
			memoryIds,
		})
	}

	return {
		memories,
		suppressedCount: result.suppressedCount,
		retrievalQuery: result.query,
	}
}

function normalizeMemoryPayload(input: {
	category?: string | null
	subject: string
	summary: string
	details?: string | null
	tags?: Array<string> | null
	sourceUris?: Array<string> | null
	dedupeKey?: string | null
}) {
	const subject = normalizeRequiredString(
		input.subject,
		maxSubjectLength,
		'subject',
	)
	const summary = normalizeRequiredString(
		input.summary,
		maxSummaryLength,
		'summary',
	)
	return {
		category: normalizeOptionalString(input.category, maxCategoryLength),
		subject,
		summary,
		details: normalizeOptionalString(input.details, maxDetailsLength) ?? '',
		tags: normalizeTags(input.tags ?? []),
		sourceUris: normalizeSourceUris(input.sourceUris ?? []),
		dedupeKey: normalizeOptionalString(input.dedupeKey, maxDedupeKeyLength),
	}
}

function buildVerifyQuery(input: {
	category: string | null
	subject: string
	summary: string
	details: string
	tags: Array<string>
	dedupeKey: string | null
}) {
	return [
		input.category ?? '',
		input.subject,
		input.summary,
		input.details,
		input.tags.join(' '),
		input.dedupeKey ?? '',
	]
		.join('\n')
		.trim()
}

function normalizeRequiredString(
	value: string,
	maxLength: number,
	field: string,
) {
	const normalized = normalizeOptionalString(value, maxLength)
	if (!normalized) throw new Error(`Memory ${field} is required.`)
	return normalized
}

function normalizeOptionalString(
	value: string | null | undefined,
	maxLength: number,
) {
	if (value == null) return null
	const normalized = value.trim()
	if (!normalized) return null
	return normalized.length > maxLength
		? normalized.slice(0, maxLength)
		: normalized
}

function normalizeTags(tags: Array<string>) {
	return Array.from(
		new Set(
			tags
				.map((tag) => normalizeOptionalString(tag, maxTagLength))
				.filter((tag): tag is string => tag != null),
		),
	).slice(0, maxTagCount)
}

function normalizeSourceUris(sourceUris: Array<string>) {
	return Array.from(
		new Set(
			sourceUris.map((sourceUri) => {
				const normalized = sourceUri.trim()
				if (!normalized || normalized.length > maxSourceUriLength) {
					throw new Error('Memory source_uris entries must be valid URLs.')
				}
				try {
					new URL(normalized)
				} catch {
					throw new Error('Memory source_uris entries must be valid URLs.')
				}
				return normalized
			}),
		),
	).slice(0, maxSourceUriCount)
}

function normalizeLimit(value: number | undefined | null) {
	if (!Number.isFinite(value)) return 5
	return Math.max(1, Math.min(20, Math.trunc(value!)))
}

async function filterSuppressedMatches(input: {
	db: D1Database
	userId: OwnerId
	conversationId: string | null
	includeSuppressedInConversation: boolean
	matches: Array<MemorySearchMatch>
}) {
	if (
		!input.conversationId ||
		input.includeSuppressedInConversation ||
		input.matches.length === 0
	) {
		return { matches: input.matches, suppressedCount: 0 }
	}
	const suppressions = await getConversationSuppressions({
		db: input.db,
		userId: input.userId,
		conversationId: input.conversationId,
	})
	const suppressedIds = new Set(suppressions.map((entry) => entry.memory_id))
	const visible = input.matches.filter((match) => !suppressedIds.has(match.id))
	return {
		matches: visible,
		suppressedCount: input.matches.length - visible.length,
	}
}

function parseTags(raw: string) {
	return parseJsonStringArray(raw)
}

function parseSourceUris(raw: string) {
	return parseJsonStringArray(raw)
}

function mapSearchMatchToMemoryRecord(match: MemorySearchMatch): MemoryRecord {
	return {
		id: match.id,
		category: match.category,
		status: match.status,
		subject: match.subject,
		summary: match.summary,
		details: match.details,
		tags: match.tags,
		sourceUris: match.sourceUris,
		dedupeKey: match.dedupeKey,
		createdAt: match.createdAt,
		updatedAt: match.updatedAt,
		lastAccessedAt: match.lastAccessedAt,
		deletedAt: match.deletedAt,
	}
}

function toMemoryRecord(row: McpMemoryRow): MemoryRecord {
	return {
		id: row.id,
		category: row.category,
		status: row.status,
		subject: row.subject,
		summary: row.summary,
		details: row.details,
		tags: parseTags(row.tags_json),
		sourceUris: parseSourceUris(row.source_uris_json),
		dedupeKey: row.dedupe_key,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastAccessedAt: row.last_accessed_at,
		deletedAt: row.deleted_at,
	}
}
