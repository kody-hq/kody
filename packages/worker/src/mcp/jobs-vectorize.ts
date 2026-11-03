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

export function jobVectorId(jobId: string): string {
	return buildLengthSafeVectorId({ prefix: 'job', rawId: jobId })
}

export async function upsertJobVector(
	env: Env,
	input: {
		jobId: string
		userId: OwnerId
		embedText: string
	},
): Promise<void> {
	const index = getCapabilityVectorIndex(env)
	if (!index || isCapabilitySearchOffline(env)) return
	const vectorId = jobVectorId(input.jobId)
	const namespace = userVectorNamespace(input.userId)
	const metadata = { kind: 'job', userId: input.userId }
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

export async function deleteJobVector(env: Env, jobId: string): Promise<void> {
	const vectorId = jobVectorId(jobId)
	await tryDeleteVectorEmbedFingerprint({ env, vectorId })
	const index = getCapabilityVectorIndex(env)
	if (!index || isCapabilitySearchOffline(env)) return
	await index.deleteByIds([vectorId])
}
