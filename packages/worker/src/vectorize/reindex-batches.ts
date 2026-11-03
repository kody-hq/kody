import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { embedTextsForVectorize } from './embedding.ts'
import {
	hasVectorEmbedFingerprintDb,
	tryReadVectorEmbedFingerprints,
	tryWriteVectorEmbedFingerprints,
	vectorEmbedContentHash,
	vectorEmbedFingerprintKey,
} from './embed-fingerprints.ts'

export type VectorReindexFailurePhase = 'load' | 'embed' | 'upsert'

export type VectorReindexFailure = {
	id: string
	phase: VectorReindexFailurePhase
	error: string
}

export type VectorReindexCandidate = {
	id: string
	text: string
	namespace: string
	metadata: Record<string, VectorizeVectorMetadata>
}

export type VectorReindexResult = {
	upserted: number
	skipped?: number
	failed?: number
	warning?: string
	error?: string
	/** Capped sample of failures for operator-facing messages. */
	failures?: Array<VectorReindexFailure>
	/** Uncapped failed candidate ids for reconciliation (e.g. debt cleanup). */
	failedIds?: Array<string>
}

export const vectorReindexUpsertBatchSize = 16
const maxReportedFailures = 20

// Combines per-page reindex results from keyset-paged drivers into a single
// result with the same shape and messages as a one-shot reindex run.
export function mergeVectorReindexResults(
	kind: string,
	results: ReadonlyArray<VectorReindexResult>,
): VectorReindexResult {
	let upserted = 0
	let skipped = 0
	let failed = 0
	const failures: Array<VectorReindexFailure> = []
	const failedIds: Array<string> = []
	const seenFailedIds = new Set<string>()
	for (const result of results) {
		upserted += result.upserted
		skipped += result.skipped ?? 0
		failed += result.failed ?? 0
		for (const failure of result.failures ?? []) {
			if (failures.length < maxReportedFailures) failures.push(failure)
		}
		for (const failedId of result.failedIds ?? []) {
			if (seenFailedIds.has(failedId)) continue
			seenFailedIds.add(failedId)
			failedIds.push(failedId)
		}
	}
	if (failed === 0) {
		return skipped > 0 ? { upserted, skipped } : { upserted }
	}
	const message = `${failed} ${kind} vector(s) failed to reindex`
	return {
		upserted,
		...(skipped > 0 ? { skipped } : {}),
		failed,
		failures,
		...(failedIds.length > 0 ? { failedIds } : {}),
		...(upserted === 0 ? { error: message } : { warning: message }),
	}
}

export async function reindexVectorCandidates(input: {
	env: Env
	index: VectorizeIndex
	kind: string
	candidates: ReadonlyArray<VectorReindexCandidate>
	force?: boolean
}): Promise<VectorReindexResult> {
	let upserted = 0
	let skipped = 0
	let failed = 0
	const failures: Array<VectorReindexFailure> = []
	const failedIds: Array<string> = []

	function recordFailure(input_: {
		candidate: VectorReindexCandidate
		phase: VectorReindexFailurePhase
		error: unknown
	}) {
		failed += 1
		failedIds.push(input_.candidate.id)
		const failure = {
			id: input_.candidate.id,
			phase: input_.phase,
			error: getErrorMessage(input_.error),
		}
		if (failures.length < maxReportedFailures) failures.push(failure)
		console.error(
			JSON.stringify({
				message: 'capability vector reindex skipped vector',
				kind: input.kind,
				vectorId: input_.candidate.id,
				phase: input_.phase,
				error: failure.error,
			}),
		)
	}

	async function splitOrRecord(
		batch: ReadonlyArray<VectorReindexCandidate>,
		phase: VectorReindexFailurePhase,
		error: unknown,
	) {
		if (batch.length === 1) {
			recordFailure({ candidate: batch[0]!, phase, error })
			return
		}
		const midpoint = Math.ceil(batch.length / 2)
		await processBatch(batch.slice(0, midpoint))
		await processBatch(batch.slice(midpoint))
	}

	async function processBatch(batch: ReadonlyArray<VectorReindexCandidate>) {
		let pending = batch
		let pendingHashes: Array<string> | null = null
		if (!input.force && hasVectorEmbedFingerprintDb(input.env)) {
			const hashed = await Promise.all(
				batch.map(async (candidate) => ({
					candidate,
					contentHash: await vectorEmbedContentHash({
						text: candidate.text,
						metadata: candidate.metadata,
					}),
				})),
			)
			const existing = await tryReadVectorEmbedFingerprints({
				env: input.env,
				keys: hashed.map((item) => ({
					userId: item.candidate.namespace as OwnerId,
					vectorId: item.candidate.id,
				})),
			})
			if (existing) {
				const changed: typeof hashed = []
				for (const item of hashed) {
					const key = vectorEmbedFingerprintKey(
						item.candidate.namespace as OwnerId,
						item.candidate.id,
					)
					if (existing.get(key) === item.contentHash) {
						skipped += 1
						continue
					}
					changed.push(item)
				}
				pending = changed.map((item) => item.candidate)
				pendingHashes = changed.map((item) => item.contentHash)
			} else {
				pendingHashes = hashed.map((item) => item.contentHash)
			}
		}
		if (pending.length === 0) return

		let embeddings: Array<Array<number>>
		try {
			embeddings = await embedTextsForVectorize(
				input.env,
				pending.map((candidate) => candidate.text),
			)
		} catch (error) {
			await splitOrRecord(pending, 'embed', error)
			return
		}

		try {
			await input.index.upsert(
				pending.map((candidate, index_) => ({
					id: candidate.id,
					values: embeddings[index_]!,
					namespace: candidate.namespace,
					metadata: candidate.metadata,
				})),
			)
			upserted += pending.length
			if (hasVectorEmbedFingerprintDb(input.env)) {
				const hashes =
					pendingHashes ??
					(await Promise.all(
						pending.map((candidate) =>
							vectorEmbedContentHash({
								text: candidate.text,
								metadata: candidate.metadata,
							}),
						),
					))
				await tryWriteVectorEmbedFingerprints({
					env: input.env,
					rows: pending.map((candidate, index_) => ({
						userId: candidate.namespace as OwnerId,
						vectorId: candidate.id,
						contentHash: hashes[index_]!,
					})),
				})
			}
		} catch (error) {
			await splitOrRecord(pending, 'upsert', error)
		}
	}

	for (
		let offset = 0;
		offset < input.candidates.length;
		offset += vectorReindexUpsertBatchSize
	) {
		await processBatch(
			input.candidates.slice(offset, offset + vectorReindexUpsertBatchSize),
		)
	}

	if (failed === 0) {
		return skipped > 0 ? { upserted, skipped } : { upserted }
	}

	const result: VectorReindexResult = {
		upserted,
		...(skipped > 0 ? { skipped } : {}),
		failed,
		failures,
		failedIds,
	}
	const message = `${failed} ${input.kind} vector(s) failed to reindex`
	if (upserted === 0 && input.candidates.length > 0) {
		result.error = message
	} else {
		result.warning = message
	}
	return result
}
