import { ecpMaxChainContexts } from '@kody-internal/shared/execution-context-protocol/index.ts'

/** Pure chain rules shared by the API, routing, and tests. */

export const executeRequirements = ['fs', 'lan'] as const
export type ExecuteRequirement = (typeof executeRequirements)[number]

export type ChainEntryLike = { kind: 'cloud' } | { kind: 'context'; id: string }

/**
 * Kody cloud is never assumed unavailable, so nothing listed after it would
 * ever run: when present it must be the last entry. Leaving it out (a strict
 * chain) is allowed.
 */
export function chainCloudOrderError(
	entries: ReadonlyArray<ChainEntryLike>,
): { message: string; cloudIndex: number } | null {
	const cloudIndex = entries.findIndex((entry) => entry.kind === 'cloud')
	if (cloudIndex === -1 || cloudIndex === entries.length - 1) return null
	return {
		cloudIndex,
		message:
			'Kody cloud must be the last entry in your chain: it is always available, so nothing after it would ever run. Move it to the end, or leave it out for a strict chain.',
	}
}

/**
 * Shape errors for a run's own chain (`chain: ["laptop", "cloud"]`): the same
 * rules as the default chain, checked before any lookup.
 */
export function runChainShapeError(
	refs: ReadonlyArray<string>,
): { code: 'invalid_request' | 'chain_too_long'; message: string } | null {
	const trimmed = refs.map((ref) => ref.trim())
	if (trimmed.some((ref) => ref === '')) {
		return {
			code: 'invalid_request',
			message:
				'chain entries must be non-empty context ids or names, or "cloud".',
		}
	}
	const order = chainCloudOrderError(
		trimmed.map((ref) =>
			ref === 'cloud' ? { kind: 'cloud' } : { kind: 'context', id: ref },
		),
	)
	if (order) return { code: 'invalid_request', message: order.message }
	const contexts = trimmed.filter((ref) => ref !== 'cloud')
	if (new Set(contexts).size !== contexts.length) {
		return {
			code: 'invalid_request',
			message: 'chain lists the same context more than once.',
		}
	}
	if (contexts.length > ecpMaxChainContexts) {
		return {
			code: 'chain_too_long',
			message: `chain can list at most ${ecpMaxChainContexts} contexts, plus "cloud" last.`,
		}
	}
	if (trimmed.length === 0) {
		return {
			code: 'invalid_request',
			message: 'chain needs at least one entry. Omit it to use your chain.',
		}
	}
	return null
}

/**
 * The operator already runs every run on their own context, so a share with
 * them would only flip the sharing level. Returns the refusal, or null.
 */
export function selfShareError(
	operatorUserId: string,
	subjects: ReadonlyArray<{ type: 'user' | 'team'; id: string }>,
): string | null {
	const self = subjects.some(
		(subject) => subject.type === 'user' && subject.id === operatorUserId,
	)
	return self
		? "That person is this context's operator and can already run code on it. Share it with someone else."
		: null
}
