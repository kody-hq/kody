import {
	maxChainContexts,
	type ExecutionChain,
	type ExecutionChainEntryInput,
} from './execution-contexts.ts'

/** Preserve fallback policy and order, and never silently evict another machine. */
export function desktopExecutionChain(
	chain: ExecutionChain,
	contextId: string,
	replaceContextId?: string,
) {
	const contexts = chain.entries.flatMap((entry) =>
		entry.kind === 'context' && entry.id !== contextId ? [entry] : [],
	)
	if (
		replaceContextId &&
		!contexts.some((entry) => entry.id === replaceContextId)
	)
		throw new Error('The execution chain changed. Choose a replacement again.')
	const remaining = contexts.filter((entry) => entry.id !== replaceContextId)
	if (remaining.length >= maxChainContexts)
		throw new Error(
			'Your chain is full. Choose a machine to replace in your chain.',
		)
	const entries: Array<ExecutionChainEntryInput> = [
		{ kind: 'context', id: contextId },
		...remaining.map((entry) => ({ kind: 'context' as const, id: entry.id })),
		...chain.entries.filter((entry) => entry.kind === 'cloud'),
	]
	return { entries, strict: chain.strict }
}
