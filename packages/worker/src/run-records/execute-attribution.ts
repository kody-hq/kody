/**
 * Run-metadata attribution for ad hoc execute runs. Keep these keys stable:
 * Activity and `runList` read them as opaque metadata (forward-only; no
 * backfill).
 */

/**
 * How the execute module source was supplied. New runs are always `code`;
 * `invoke` appears only on rows written while the server-side execute
 * `invoke` shortcut existed, and stays readable.
 */
export type ExecuteEntry = 'invoke' | 'code'

export const executeEntryMetadataKey = 'entry'
export const executeWorkerIdMetadataKey = 'workerId'

export function buildExecuteAttributionMetadata(): Record<string, string> {
	return { [executeEntryMetadataKey]: 'code' }
}

export function readExecuteEntry(
	metadata: Record<string, unknown>,
): ExecuteEntry | null {
	const entry = metadata[executeEntryMetadataKey]
	if (entry === 'invoke' || entry === 'code') return entry
	return null
}
