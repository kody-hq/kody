const communitySnapshotPrefix = 'community-snapshot:v1'

/**
 * Legacy listing-id file tree snapshots. Nothing writes or reads them anymore
 * (listing pins read `source-snapshot:v1:{sourceId}:{pinnedCommit}`), but keys
 * written before that stay in KV, so unpublish, account export, and account
 * deletion still address them.
 */
export function buildCommunitySnapshotKvKey(listingId: string) {
	return `${communitySnapshotPrefix}:${listingId}`
}

export async function deleteCommunitySnapshot(
	kv: KVNamespace,
	listingId: string,
): Promise<void> {
	await kv.delete(buildCommunitySnapshotKvKey(listingId))
}
