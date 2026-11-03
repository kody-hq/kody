import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { sha256Hex } from '@kody-internal/shared/sha256.ts'
import {
	CAPABILITY_EMBEDDING_DIMENSIONS,
	CAPABILITY_EMBEDDING_MODEL,
	truncateEmbeddingInput,
} from './embedding.ts'

/**
 * Bump when the Vectorize metadata contract changes in a way that requires
 * every stored vector to be rewritten even if embed text is unchanged.
 */
export const vectorEmbedFingerprintVersion = 1

export function hasVectorEmbedFingerprintDb(
	env: Env,
): env is Env & { APP_DB: D1Database } {
	return typeof env.APP_DB?.prepare === 'function'
}

export function vectorEmbedFingerprintKey(userId: OwnerId, vectorId: string) {
	return `${userId}\0${vectorId}`
}

export function canonicalizeVectorEmbedMetadata(
	metadata: Record<string, VectorizeVectorMetadata> | undefined,
) {
	if (!metadata) return ''
	return JSON.stringify(
		Object.fromEntries(
			Object.keys(metadata)
				.sort()
				.map((key) => [key, metadata[key]]),
		),
	)
}

export async function vectorEmbedContentHash(input: {
	text: string
	metadata?: Record<string, VectorizeVectorMetadata>
}) {
	const material = [
		CAPABILITY_EMBEDDING_MODEL,
		String(CAPABILITY_EMBEDDING_DIMENSIONS),
		String(vectorEmbedFingerprintVersion),
		truncateEmbeddingInput(input.text),
		canonicalizeVectorEmbedMetadata(input.metadata),
	].join('\0')
	return sha256Hex(material)
}

export async function readVectorEmbedFingerprints(input: {
	db: D1Database
	keys: ReadonlyArray<{ userId: OwnerId; vectorId: string }>
}): Promise<Map<string, string>> {
	const found = new Map<string, string>()
	if (input.keys.length === 0) return found
	const chunkSize = 32
	for (let offset = 0; offset < input.keys.length; offset += chunkSize) {
		const chunk = input.keys.slice(offset, offset + chunkSize)
		const placeholders = chunk.map(() => '(?, ?)').join(', ')
		const rows = await input.db
			.prepare(
				`SELECT user_id, vector_id, content_hash
				FROM vector_embed_fingerprints
				WHERE (user_id, vector_id) IN (${placeholders})`,
			)
			.bind(...chunk.flatMap((key) => [key.userId, key.vectorId]))
			.all<{
				user_id: OwnerId
				vector_id: string
				content_hash: string
			}>()
		for (const row of rows.results ?? []) {
			found.set(
				vectorEmbedFingerprintKey(row.user_id, row.vector_id),
				row.content_hash,
			)
		}
	}
	return found
}

export async function writeVectorEmbedFingerprints(input: {
	db: D1Database
	rows: ReadonlyArray<{
		userId: OwnerId
		vectorId: string
		contentHash: string
	}>
}) {
	const now = new Date().toISOString()
	for (const row of input.rows) {
		await input.db
			.prepare(
				`INSERT INTO vector_embed_fingerprints (
					user_id, vector_id, content_hash, updated_at
				) VALUES (?, ?, ?, ?)
				ON CONFLICT(user_id, vector_id) DO UPDATE SET
					content_hash = excluded.content_hash,
					updated_at = excluded.updated_at`,
			)
			.bind(row.userId, row.vectorId, row.contentHash, now)
			.run()
	}
}

export async function deleteVectorEmbedFingerprint(input: {
	db: D1Database
	vectorId: string
}) {
	await input.db
		.prepare(`DELETE FROM vector_embed_fingerprints WHERE vector_id = ?`)
		.bind(input.vectorId)
		.run()
}

export async function tryReadVectorEmbedFingerprints(input: {
	env: Env
	keys: ReadonlyArray<{ userId: OwnerId; vectorId: string }>
}): Promise<Map<string, string> | null> {
	if (!hasVectorEmbedFingerprintDb(input.env)) return null
	try {
		return await readVectorEmbedFingerprints({
			db: input.env.APP_DB,
			keys: input.keys,
		})
	} catch {
		return null
	}
}

export async function tryWriteVectorEmbedFingerprints(input: {
	env: Env
	rows: ReadonlyArray<{
		userId: OwnerId
		vectorId: string
		contentHash: string
	}>
}) {
	if (!hasVectorEmbedFingerprintDb(input.env) || input.rows.length === 0) return
	try {
		await writeVectorEmbedFingerprints({
			db: input.env.APP_DB,
			rows: input.rows,
		})
	} catch {
		// Fail-open: a derived skip cache must not break upsert or delete.
	}
}

export async function tryDeleteVectorEmbedFingerprint(input: {
	env: Env
	vectorId: string
}) {
	if (!hasVectorEmbedFingerprintDb(input.env)) return
	try {
		await deleteVectorEmbedFingerprint({
			db: input.env.APP_DB,
			vectorId: input.vectorId,
		})
	} catch {
		// Fail-open: a derived skip cache must not break upsert or delete.
	}
}

export async function shouldSkipVectorEmbed(input: {
	env: Env
	userId: OwnerId
	vectorId: string
	text: string
	metadata?: Record<string, VectorizeVectorMetadata>
}): Promise<boolean> {
	const existing = await tryReadVectorEmbedFingerprints({
		env: input.env,
		keys: [{ userId: input.userId, vectorId: input.vectorId }],
	})
	if (!existing) return false
	const hash = await vectorEmbedContentHash({
		text: input.text,
		metadata: input.metadata,
	})
	return (
		existing.get(vectorEmbedFingerprintKey(input.userId, input.vectorId)) ===
		hash
	)
}

export async function recordVectorEmbedFingerprint(input: {
	env: Env
	userId: OwnerId
	vectorId: string
	text: string
	metadata?: Record<string, VectorizeVectorMetadata>
}) {
	if (!hasVectorEmbedFingerprintDb(input.env)) return
	await tryWriteVectorEmbedFingerprints({
		env: input.env,
		rows: [
			{
				userId: input.userId,
				vectorId: input.vectorId,
				contentHash: await vectorEmbedContentHash({
					text: input.text,
					metadata: input.metadata,
				}),
			},
		],
	})
}
