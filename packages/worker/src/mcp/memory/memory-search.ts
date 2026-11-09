import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	deterministicEmbedding,
	embedTextForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
	type EmbedTextFn,
} from '#worker/vectorize/embedding.ts'
import {
	CAPABILITY_SEARCH_RRF_K,
	cosineSimilarity,
	lexicalScore,
	reciprocalRankFusion,
	sortIdsByScore,
} from '#worker/vectorize/scoring.ts'
import { userVectorNamespace } from '#worker/vectorize/vector-namespaces.ts'
import { getRawIdFromPassthroughVectorId } from '#worker/vectorize/vector-ids.ts'
import { parseJsonStringArray } from '@kody-internal/shared/json-parsing.ts'
import { buildMemoryEmbedTextFromRow } from './memory-embed.ts'
import { memoryVectorId } from './memory-vectorize.ts'
import type { McpMemoryRow, MemorySearchMatch } from './types.ts'

function buildMemoryVectorFilter(input: {
	userId: OwnerId
	statuses: ReadonlyArray<McpMemoryRow['status']>
	category?: string | null
}): VectorizeVectorMetadataFilter {
	return {
		kind: { $eq: 'memory' },
		userId: { $eq: input.userId },
		status: { $in: [...input.statuses] },
		...(input.category ? { category: { $eq: input.category } } : {}),
	}
}

/** A memory id with its cosine similarity to the query embedding. */
export type MemoryVectorHit = { id: string; score: number }

/**
 * Queries Vectorize for the user's memory vectors (strict metadata filter on
 * kind, userId, status, and optional category) and returns memory hits ordered
 * by similarity. Returns an empty list when the vector index is unavailable.
 */
export async function queryMemoryVectorIds(input: {
	env: Env
	query: string
	userId: OwnerId
	statuses: ReadonlyArray<McpMemoryRow['status']>
	category?: string | null
	topK: number
	embedText?: EmbedTextFn
}): Promise<Array<MemoryVectorHit>> {
	const index = getCapabilityVectorIndex(input.env)
	if (!index || !input.userId) return []
	const queryVector = await (
		input.embedText ?? ((text) => embedTextForVectorize(input.env, text))
	)(input.query)
	const vectorMatches = await index.query(queryVector, {
		topK: input.topK,
		namespace: userVectorNamespace(input.userId),
		returnMetadata: 'none',
		filter: buildMemoryVectorFilter(input),
	})
	const hits: Array<MemoryVectorHit> = []
	const seen = new Set<string>()
	for (const match of vectorMatches.matches) {
		if (typeof match.id !== 'string') continue
		const memoryId = getRawIdFromPassthroughVectorId({
			prefix: 'memory',
			vectorId: match.id,
		})
		if (!memoryId || seen.has(memoryId)) continue
		seen.add(memoryId)
		hits.push({ id: memoryId, score: match.score })
	}
	return hits
}

/**
 * Ranks only the given memories by similarity, reading their stored vectors
 * by id so other memories in the namespace cannot crowd them out of a topK.
 * Returns an empty list when the vector index is unavailable.
 */
export async function rankMemoryVectorIdsWithin(input: {
	env: Env
	query: string
	userId: OwnerId
	memoryIds: ReadonlyArray<string>
	embedText?: EmbedTextFn
}): Promise<Array<MemoryVectorHit>> {
	const index = getCapabilityVectorIndex(input.env)
	if (!index || !input.userId || input.memoryIds.length === 0) return []
	const [queryVector, vectors] = await Promise.all([
		(input.embedText ?? ((text) => embedTextForVectorize(input.env, text)))(
			input.query,
		),
		index.getByIds(input.memoryIds.map((id) => memoryVectorId(id))),
	])
	const similarityById = new Map<string, number>()
	for (const vector of vectors) {
		if (vector.metadata?.userId !== input.userId) continue
		const memoryId = getRawIdFromPassthroughVectorId({
			prefix: 'memory',
			vectorId: vector.id,
		})
		if (!memoryId) continue
		similarityById.set(
			memoryId,
			cosineSimilarity(queryVector, Array.from(vector.values)),
		)
	}
	return sortIdsByScore([...similarityById.keys()], (id) =>
		similarityById.get(id)!,
	).map((id) => ({ id, score: similarityById.get(id)! }))
}

export async function searchMemories(input: {
	env: Env
	query: string
	limit: number
	userId: OwnerId
	statuses: ReadonlyArray<McpMemoryRow['status']>
	category?: string | null
	rows: Array<McpMemoryRow>
	vectorRanked?: ReadonlyArray<MemoryVectorHit>
	embedText?: EmbedTextFn
}): Promise<{ matches: Array<MemorySearchMatch>; offline: boolean }> {
	const query = input.query.trim()
	const offline = isCapabilitySearchOffline(input.env)
	if (!query || !input.userId || input.rows.length === 0) {
		return { matches: [], offline }
	}
	if (input.rows.some((row) => row.user_id !== input.userId)) {
		console.warn(
			JSON.stringify({
				message: 'memory search skipped: row userId mismatch',
				expectedUserId: input.userId,
			}),
		)
		return { matches: [], offline }
	}

	const rowsById = new Map(input.rows.map((row) => [row.id, row] as const))
	const ids = [...rowsById.keys()]
	const docsById = Object.fromEntries(
		input.rows.map(
			(row) => [row.id, buildMemoryEmbedTextFromRow(row)] as const,
		),
	)
	const lexicalOrder = sortIdsByScore(ids, (id) =>
		lexicalScore(query, docsById[id]!),
	)

	let vectorOrder: Array<string>
	// Real embedding similarity only; the offline stand-in hash has no meaning.
	const vectorScoreById = new Map<string, number>()
	if (input.vectorRanked) {
		vectorOrder = []
		for (const hit of input.vectorRanked) {
			if (!rowsById.has(hit.id)) continue
			vectorOrder.push(hit.id)
			vectorScoreById.set(hit.id, hit.score)
		}
	} else if (offline) {
		const queryVector = deterministicEmbedding(query)
		const similarityById = Object.fromEntries(
			ids.map((id) => {
				const docVector = deterministicEmbedding(docsById[id]!)
				return [id, cosineSimilarity(queryVector, docVector)] as const
			}),
		)
		vectorOrder = sortIdsByScore(ids, (id) => similarityById[id]!)
	} else {
		const index = getCapabilityVectorIndex(input.env)!
		const queryVector = await (
			input.embedText ?? ((text) => embedTextForVectorize(input.env, text))
		)(query)
		const topK = Math.min(Math.max(ids.length, input.limit * 5), 100)
		const vectorMatches = await index.query(queryVector, {
			topK,
			namespace: userVectorNamespace(input.userId),
			returnMetadata: 'none',
			filter: buildMemoryVectorFilter({
				userId: input.userId,
				statuses: input.statuses,
				category: input.category,
			}),
		})
		const seen = new Set<string>()
		const fromIndex: Array<string> = []
		for (const match of vectorMatches.matches) {
			if (typeof match.id !== 'string' || seen.has(match.id)) continue
			const memoryId = getRawIdFromPassthroughVectorId({
				prefix: 'memory',
				vectorId: match.id,
			})
			if (!memoryId || !rowsById.has(memoryId)) continue
			seen.add(match.id)
			fromIndex.push(memoryId)
			vectorScoreById.set(memoryId, match.score)
		}
		vectorOrder = fromIndex
	}

	const lexicalRankById = new Map<string, number>()
	for (let index = 0; index < lexicalOrder.length; index += 1) {
		lexicalRankById.set(lexicalOrder[index]!, index + 1)
	}
	const vectorRankById = new Map<string, number>()
	for (let index = 0; index < vectorOrder.length; index += 1) {
		vectorRankById.set(vectorOrder[index]!, index + 1)
	}

	const fused = reciprocalRankFusion(
		[lexicalOrder, vectorOrder],
		CAPABILITY_SEARCH_RRF_K,
	)
	const ordered = sortIdsByScore(ids, (id) => fused.get(id) ?? 0).slice(
		0,
		Math.max(1, Math.min(input.limit, ids.length)),
	)

	return {
		matches: ordered.map((id) => {
			const row = rowsById.get(id)!
			const vectorRank = vectorRankById.get(id)
			const vectorScore = vectorScoreById.get(id)
			return {
				id: row.id,
				category: row.category,
				status: row.status,
				subject: row.subject,
				summary: row.summary,
				details: row.details,
				tags: parseJsonStringArray(row.tags_json),
				sourceUris: parseJsonStringArray(row.source_uris_json),
				dedupeKey: row.dedupe_key,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				lastAccessedAt: row.last_accessed_at,
				deletedAt: row.deleted_at,
				score: fused.get(id) ?? 0,
				lexicalRank: lexicalRankById.get(id),
				...(vectorRank != null ? { vectorRank } : {}),
				...(vectorScore != null ? { vectorScore } : {}),
			}
		}),
		offline,
	}
}
