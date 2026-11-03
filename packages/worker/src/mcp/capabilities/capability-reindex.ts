import { buildCapabilityEmbedText } from './capability-search.ts'
import { getCapabilityVectorIndex } from '#worker/vectorize/embedding.ts'
import {
	reindexVectorCandidateList,
	type VectorReindexSweepOptions,
	type VectorReindexSweepResult,
} from '#worker/vectorize/reindex-sweep.ts'
import { BUILTIN_VECTOR_NAMESPACE } from '#worker/vectorize/vector-namespaces.ts'
import type { CapabilitySpec } from './types.ts'

export async function reindexCapabilityVectors(
	env: Env,
	specs: Record<string, CapabilitySpec>,
	options?: VectorReindexSweepOptions,
): Promise<VectorReindexSweepResult> {
	const index = getCapabilityVectorIndex(env)
	if (!index) {
		throw new Error('CAPABILITY_VECTOR_INDEX binding is not configured')
	}

	const candidates = Object.values(specs)
		.slice()
		.sort((left, right) => left.name.localeCompare(right.name))
		.map((spec) => ({
			id: spec.name,
			text: buildCapabilityEmbedText(spec),
			namespace: BUILTIN_VECTOR_NAMESPACE,
			metadata: { domain: spec.domain, kind: 'builtin' },
		}))

	return reindexVectorCandidateList({
		env,
		index,
		kind: 'builtin capability',
		candidates,
		afterId: options?.afterId,
		deadlineMs: options?.deadlineMs,
		force: options?.force,
	})
}
