import type { CapabilitySpec } from './types.ts'
import {
	CAPABILITY_EMBEDDING_DIMENSIONS,
	deterministicEmbedding,
	embedTextForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#worker/vectorize/embedding.ts'
import {
	CAPABILITY_SEARCH_RRF_K,
	blendLexicalAndVectorScore,
	cosineSimilarity,
	lexicalScore,
	reciprocalRankFusion,
	sortIdsByScore,
	tokenizeSearchText,
} from '#worker/vectorize/scoring.ts'
import { BUILTIN_VECTOR_NAMESPACE } from '#worker/vectorize/vector-namespaces.ts'

/**
 * Indexed metadata `kind` for builtin capability vectors in the shared
 * CAPABILITY_VECTOR_INDEX (see capability-reindex.ts). Distinct from package /
 * memory / job kinds in the same index.
 */
export const CAPABILITY_VECTOR_KIND = 'builtin'

/**
 * Always scope capability Vectorize queries to builtin capability vectors.
 * Caller-supplied RBAC/provider filters are merged with implicit AND; `kind` is
 * forced to builtin so callers cannot widen into packages or other corpora.
 */
export function buildCapabilityVectorMetadataFilter(
	callerFilter?: VectorizeVectorMetadataFilter,
): VectorizeVectorMetadataFilter {
	if (!callerFilter || Object.keys(callerFilter).length === 0) {
		return { kind: { $eq: CAPABILITY_VECTOR_KIND } }
	}
	return {
		...callerFilter,
		kind: { $eq: CAPABILITY_VECTOR_KIND },
	}
}

export function buildCapabilityEmbedText(spec: CapabilitySpec): string {
	const keywords = spec.keywords.join(' ')
	const fields = [...spec.inputFields, ...spec.outputFields].join(' ')
	return [spec.name, spec.domain, spec.description, keywords, fields]
		.join('\n')
		.slice(0, 8_000)
}

function capabilityLexicalScore(
	query: string,
	identityQuery: string,
	spec: CapabilitySpec,
	document: string,
): number {
	const documentScore = lexicalScore(query, document)
	const identityScore = lexicalScore(
		identityQuery,
		`${spec.name}\n${spec.domain}`,
	)
	// Dynamic operations may not be indexed yet. Normalize operation identity
	// against query terms that occur in this registry's identities so exact
	// entity names are not diluted by conversational query words.
	return Math.min(1, documentScore + identityScore)
}

export function hybridSearchScore(lexical: number, vector: number): number {
	return blendLexicalAndVectorScore(lexical, vector)
}

export function normalizeHybridSearchScore(input: {
	lexical: number
	vector: number
}): number {
	return hybridSearchScore(input.lexical, input.vector)
}

export type CapabilitySummaryRow = {
	name: string
	domain: string
	description: string
	source: CapabilitySpec['source']
	requiredInputFields: Array<string>
}

export type CapabilityDetailRow = CapabilitySummaryRow & {
	description: string
	keywords: Array<string>
	readOnly: boolean
	idempotent: boolean
	destructive: boolean
	inputTypeDefinition: string
	outputTypeDefinition?: string
	inputFields?: Array<string>
	outputFields?: Array<string>
}

export type RankedCapabilityHit = CapabilitySummaryRow | CapabilityDetailRow

export type CapabilitySearchHit = RankedCapabilityHit & {
	fusedScore: number
	lexicalRank?: number
	vectorRank?: number
	lexicalScore: number
	vectorScore: number
}

function toSummary(spec: CapabilitySpec): CapabilitySummaryRow {
	return {
		name: spec.name,
		domain: spec.domain,
		description: spec.description,
		source: spec.source,
		requiredInputFields: spec.requiredInputFields,
	}
}

function toDetail(spec: CapabilitySpec): CapabilityDetailRow {
	const row: CapabilityDetailRow = {
		...toSummary(spec),
		description: spec.description,
		keywords: spec.keywords,
		readOnly: spec.readOnly,
		idempotent: spec.idempotent,
		destructive: spec.destructive,
		inputTypeDefinition: spec.inputTypeDefinition,
		...(spec.outputTypeDefinition
			? { outputTypeDefinition: spec.outputTypeDefinition }
			: {}),
	}
	if (!spec.inputSchema) {
		row.inputFields = spec.inputFields
	}
	if (!spec.outputSchema) {
		row.outputFields = spec.outputFields
	}
	return row
}

export async function searchCapabilities(input: {
	env: Env
	query: string
	limit: number
	detail: boolean
	specs: Record<string, CapabilitySpec>
	/**
	 * Optional online-only metadata filter combined with the builtin capability
	 * kind filter (RBAC/provider scoping). Never widens into other index kinds.
	 */
	vectorMetadataFilter?: VectorizeVectorMetadataFilter
	/**
	 * Optional precomputed query embedding. Callers that also rank packages
	 * (or other Vectorize-backed corpora) against the same query should embed
	 * once and pass the vector here to avoid a second Workers AI round-trip.
	 */
	queryVector?: ReadonlyArray<number>
}): Promise<{ matches: Array<CapabilitySearchHit>; offline: boolean }> {
	const q = input.query.trim()
	const specs = input.specs
	const ids = Object.keys(specs)
	const docsById = Object.fromEntries(
		ids.map((id) => [id, buildCapabilityEmbedText(specs[id]!)] as const),
	)
	const identityTokenUniverse = new Set(
		ids.flatMap((id) => [
			...tokenizeSearchText(`${specs[id]!.name}\n${specs[id]!.domain}`),
		]),
	)
	const identityQuery = [...tokenizeSearchText(q)]
		.filter((token) => identityTokenUniverse.has(token))
		.join(' ')
	const lexicalScoreById = Object.fromEntries(
		ids.map(
			(id) =>
				[
					id,
					capabilityLexicalScore(q, identityQuery, specs[id]!, docsById[id]!),
				] as const,
		),
	)

	const lexicalOrder = sortIdsByScore(ids, (id) => lexicalScoreById[id]!)

	let vectorOrder: Array<string>
	let vectorScoreById: Record<string, number>
	let vectorHitIds: Set<string>

	const offline = isCapabilitySearchOffline(input.env)

	if (offline) {
		const qVec =
			input.queryVector &&
			input.queryVector.length === CAPABILITY_EMBEDDING_DIMENSIONS
				? [...input.queryVector]
				: deterministicEmbedding(q)
		vectorScoreById = Object.fromEntries(
			ids.map((id) => {
				const cVec = deterministicEmbedding(docsById[id]!)
				return [id, cosineSimilarity(qVec, cVec)] as const
			}),
		)
		vectorOrder = sortIdsByScore(ids, (id) => vectorScoreById[id]!)
		vectorHitIds = new Set(ids)
	} else {
		const index = getCapabilityVectorIndex(input.env)
		if (!index) {
			throw new Error(
				'CAPABILITY_VECTOR_INDEX binding is required for capability search outside offline mode.',
			)
		}
		const vectorIndex = index
		// Clone at the Vectorize boundary — Workers may mutate the query array.
		const qVec = [
			...(input.queryVector ?? (await embedTextForVectorize(input.env, q))),
		]
		const topK = Math.min(Math.max(ids.length, input.limit * 5), 100)
		const vectorScoreMap = new Map<string, number>()
		const filter = buildCapabilityVectorMetadataFilter(
			input.vectorMetadataFilter,
		)

		const vecMatches = await vectorIndex.query(qVec, {
			topK,
			namespace: BUILTIN_VECTOR_NAMESPACE,
			returnMetadata: 'none',
			filter,
		})
		const fromIndex: Array<string> = []
		const seen = new Set<string>()
		for (const match of vecMatches.matches) {
			if (
				typeof match.id !== 'string' ||
				!specs[match.id] ||
				seen.has(match.id)
			)
				continue
			seen.add(match.id)
			fromIndex.push(match.id)
			vectorScoreMap.set(match.id, match.score)
		}
		// Do not re-embed documents missing from Vectorize topK on the query path,
		// and do not fall back to an unfiltered cross-kind query. Lexical ranking
		// recalls non-vector hits; reindexing owns document embeddings.
		vectorHitIds = seen
		vectorScoreById = Object.fromEntries(
			ids.map((id) => [id, vectorScoreMap.get(id) ?? Number.NEGATIVE_INFINITY]),
		)
		// Only real Vectorize hits participate in vectorOrder / RRF.
		vectorOrder = fromIndex
	}

	const lexicalRankById = new Map<string, number>()
	for (let r = 0; r < lexicalOrder.length; r += 1) {
		lexicalRankById.set(lexicalOrder[r]!, r + 1)
	}
	const vectorRankById = new Map<string, number>()
	for (let r = 0; r < vectorOrder.length; r += 1) {
		vectorRankById.set(vectorOrder[r]!, r + 1)
	}

	const fused = reciprocalRankFusion(
		[lexicalOrder, vectorOrder],
		CAPABILITY_SEARCH_RRF_K,
	)
	const ordered = [...ids]
		.sort((a, b) => {
			const fusedDiff = (fused.get(b) ?? 0) - (fused.get(a) ?? 0)
			if (fusedDiff !== 0) return fusedDiff
			const aHasVector = vectorHitIds.has(a)
			const bHasVector = vectorHitIds.has(b)
			if (aHasVector !== bHasVector) return aHasVector ? -1 : 1
			if (aHasVector && bHasVector) {
				const vectorDiff = vectorScoreById[b]! - vectorScoreById[a]!
				if (vectorDiff !== 0) return vectorDiff
			}
			return lexicalScoreById[b]! - lexicalScoreById[a]!
		})
		.slice(0, Math.max(1, Math.min(input.limit, ids.length)))

	const matches: Array<CapabilitySearchHit> = ordered.map((id) => {
		const spec = specs[id]!
		const base = input.detail ? toDetail(spec) : toSummary(spec)
		const hasVectorHit = vectorHitIds.has(id)
		const rawVectorScore = vectorScoreById[id]
		const vectorScore =
			hasVectorHit &&
			rawVectorScore !== undefined &&
			Number.isFinite(rawVectorScore)
				? rawVectorScore
				: 0
		return {
			...base,
			fusedScore: fused.get(id) ?? 0,
			lexicalRank: lexicalRankById.get(id),
			// Omit vectorRank when there was no Vectorize hit so callers can
			// treat the candidate as lexical-only (not vectorScore === 0).
			...(hasVectorHit ? { vectorRank: vectorRankById.get(id) } : {}),
			lexicalScore: lexicalScoreById[id] ?? 0,
			// Keep a stable numeric public field; ranking uses vectorRank presence.
			vectorScore,
		}
	})

	return { matches, offline }
}
