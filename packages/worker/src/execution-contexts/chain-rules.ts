/** Pure chain rules shared by the API, routing, and tests. */

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
