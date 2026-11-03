import type { OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import {
	embedTextForVectorize,
	getCapabilityVectorIndex,
	isCapabilitySearchOffline,
} from '#worker/vectorize/embedding.ts'
import {
	recordVectorEmbedFingerprint,
	shouldSkipVectorEmbed,
	tryDeleteVectorEmbedFingerprint,
} from '#worker/vectorize/embed-fingerprints.ts'
import { userVectorNamespace } from '#worker/vectorize/vector-namespaces.ts'
import { buildLengthSafeVectorId } from '#worker/vectorize/vector-ids.ts'
import type { MemoryStatus } from './types.ts'

export function memoryVectorId(memoryId: string): string {
	return buildLengthSafeVectorId({ prefix: 'memory', rawId: memoryId })
}

export async function upsertMemoryVector(
	env: Env,
	input: {
		memoryId: string
		userId: OwnerId
		category: string | null
		status: MemoryStatus
		embedText: string
	},
): Promise<void> {
	const index = getCapabilityVectorIndex(env)
	if (!index || isCapabilitySearchOffline(env)) return
	const vectorId = memoryVectorId(input.memoryId)
	const namespace = userVectorNamespace(input.userId)
	const metadata = {
		kind: 'memory',
		userId: input.userId,
		status: input.status,
		...(input.category ? { category: input.category } : {}),
	}
	if (
		await shouldSkipVectorEmbed({
			env,
			userId: namespace,
			vectorId,
			text: input.embedText,
			metadata,
		})
	) {
		return
	}
	const values = await embedTextForVectorize(env, input.embedText)
	await index.upsert([
		{
			id: vectorId,
			values,
			namespace,
			metadata,
		},
	])
	await recordVectorEmbedFingerprint({
		env,
		userId: namespace,
		vectorId,
		text: input.embedText,
		metadata,
	})
}

export async function deleteMemoryVector(
	env: Env,
	memoryId: string,
): Promise<void> {
	const vectorId = memoryVectorId(memoryId)
	await tryDeleteVectorEmbedFingerprint({ env, vectorId })
	const index = getCapabilityVectorIndex(env)
	if (!index || isCapabilitySearchOffline(env)) return
	await index.deleteByIds([vectorId])
}
