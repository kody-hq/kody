import type { CommunitySnapshot } from './types.ts'

const communitySnapshotPrefix = 'community-snapshot:v1'

export function buildCommunitySnapshotKvKey(listingId: string) {
	return `${communitySnapshotPrefix}:${listingId}`
}

export async function readCommunitySnapshot(
	kv: KVNamespace,
	listingId: string,
): Promise<CommunitySnapshot | null> {
	const raw = await kv.get(buildCommunitySnapshotKvKey(listingId))
	if (!raw) return null
	// Corrupt KV payloads are treated as cache misses instead of failing the
	// read path.
	let parsed: CommunitySnapshot
	try {
		parsed = JSON.parse(raw) as CommunitySnapshot
	} catch {
		return null
	}
	if (parsed.version !== 1) {
		throw new Error(
			`Unsupported community snapshot version for listing "${listingId}".`,
		)
	}
	return parsed
}

export async function writeCommunitySnapshot(
	kv: KVNamespace,
	snapshot: CommunitySnapshot,
): Promise<void> {
	await kv.put(
		buildCommunitySnapshotKvKey(snapshot.listingId),
		JSON.stringify(snapshot),
	)
}

export async function deleteCommunitySnapshot(
	kv: KVNamespace,
	listingId: string,
): Promise<void> {
	await kv.delete(buildCommunitySnapshotKvKey(listingId))
}
