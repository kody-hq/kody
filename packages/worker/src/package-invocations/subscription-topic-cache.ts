import { listPackageSubscriptions } from '#worker/package-registry/manifest.ts'
import {
	listSavedPackagesByIds,
	listSavedPackagesByUserId,
} from '#worker/package-registry/repo.ts'
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import { loadManifestsForSavedPackages } from './saved-package-manifest-discovery.ts'

/**
 * Per-user KV cache of computed topic → package-id lists for package-event
 * subscription discovery.
 *
 * The package manifest remains the only source of truth. This key is a cache of
 * that computed projection: wakes read one KV value instead of every saved
 * package's manifest. Prefer a normalized source of truth plus a cache of
 * computed values over a denormalized topic-index table.
 *
 * Invalidation uses a generation stamp (no TTL): publish/unpublish bumps the
 * generation first so a failed delete or a late wake write cannot leave wakes
 * matching a pre-publish map. Incomplete scans (manifest load failures) never
 * write the map.
 */

export const packageSubscriptionTopicMapVersion = 1
export const packageSubscriptionTopicMapPrefix = 'package-subscription-topics'
export const packageSubscriptionTopicGenerationPrefix =
	'package-subscription-topics-gen'

export type PackageSubscriptionTopicMap = {
	version: typeof packageSubscriptionTopicMapVersion
	userId: string
	generation: number
	byTopic: Record<string, Array<string>>
	cachedAt: string
}

export type PackageSubscriptionTopicScanResult = {
	map: PackageSubscriptionTopicMap
	manifestLoadFailures: number
}

type SubscriptionTopicCacheEnv = Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>

function getSubscriptionTopicKv(env: SubscriptionTopicCacheEnv) {
	const kv = (env as { BUNDLE_ARTIFACTS_KV?: KVNamespace }).BUNDLE_ARTIFACTS_KV
	if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
		return null
	}
	return kv
}

export function buildPackageSubscriptionTopicMapKey(userId: string) {
	return [
		packageSubscriptionTopicMapPrefix,
		`v${packageSubscriptionTopicMapVersion}`,
		userId,
	].join(':')
}

export function buildPackageSubscriptionTopicGenerationKey(userId: string) {
	return [
		packageSubscriptionTopicGenerationPrefix,
		`v${packageSubscriptionTopicMapVersion}`,
		userId,
	].join(':')
}

function isPackageSubscriptionTopicMap(
	value: unknown,
	userId: string,
): value is PackageSubscriptionTopicMap {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return false
	}
	const record = value as Record<string, unknown>
	if (record['version'] !== packageSubscriptionTopicMapVersion) return false
	if (record['userId'] !== userId) return false
	if (
		typeof record['generation'] !== 'number' ||
		!Number.isFinite(record['generation']) ||
		record['generation'] < 0
	) {
		return false
	}
	const byTopic = record['byTopic']
	if (!byTopic || typeof byTopic !== 'object' || Array.isArray(byTopic)) {
		return false
	}
	for (const [topic, packageIds] of Object.entries(
		byTopic as Record<string, unknown>,
	)) {
		if (typeof topic !== 'string' || topic.trim().length === 0) return false
		if (!Array.isArray(packageIds)) return false
		if (
			!packageIds.every(
				(packageId) =>
					typeof packageId === 'string' && packageId.trim().length > 0,
			)
		) {
			return false
		}
	}
	return typeof record['cachedAt'] === 'string'
}

function emptyTopicMap(
	userId: string,
	generation: number,
): PackageSubscriptionTopicMap {
	return {
		version: packageSubscriptionTopicMapVersion,
		userId,
		generation,
		byTopic: {},
		cachedAt: new Date().toISOString(),
	}
}

function isMissingSavedPackagesTableError(error: unknown) {
	return (
		error instanceof Error &&
		error.message.toLowerCase().includes('no such table: saved_packages')
	)
}

export async function readPackageSubscriptionTopicGeneration(input: {
	env: SubscriptionTopicCacheEnv
	userId: string
}): Promise<number> {
	const kv = getSubscriptionTopicKv(input.env)
	if (!kv) return 0
	const raw = await kv.get(
		buildPackageSubscriptionTopicGenerationKey(input.userId),
	)
	const generation = Number(raw)
	return Number.isFinite(generation) && generation >= 0 ? generation : 0
}

const generationTokenBytes = 6

/**
 * Mint a unique generation token. Do not read-then-increment: concurrent
 * refreshes that share `n+1` can both pass the write check and leave the
 * earlier (stale) map cached with no TTL.
 *
 * Uses a 48-bit crypto token, not a clock. `Date.now() * 1000` plus `% 1000`
 * entropy only had 1000 values per millisecond, so two same-ms bumps could
 * share a generation and the earlier scan could overwrite. Stays inside
 * `Number.MAX_SAFE_INTEGER` so KV stringification is exact. Never mints 0: a
 * missing key reads as 0.
 */
export function mintPackageSubscriptionTopicGeneration(): number {
	const bytes = new Uint8Array(generationTokenBytes)
	crypto.getRandomValues(bytes)
	let value = 0
	for (const byte of bytes) {
		value = value * 256 + byte
	}
	return value === 0 ? 1 : value
}

/**
 * Bump the per-user generation before rewriting the map. Each bump mints a
 * unique token (not `n+1`) so concurrent refreshes never share a generation.
 * Reads treat a map whose generation does not match as a miss, so a failed
 * delete or a late wake write cannot leave wakes matching a pre-publish
 * projection.
 */
export async function bumpPackageSubscriptionTopicGeneration(input: {
	env: SubscriptionTopicCacheEnv
	userId: string
}): Promise<number> {
	const kv = getSubscriptionTopicKv(input.env)
	if (!kv) return 0
	const next = mintPackageSubscriptionTopicGeneration()
	// No expirationTtl: a TTL could hide a newly published subscription.
	await kv.put(
		buildPackageSubscriptionTopicGenerationKey(input.userId),
		String(next),
	)
	return next
}

/**
 * Scan every saved package manifest for the user and build the topic map.
 * Callers must not write the map when `manifestLoadFailures > 0`.
 */
export async function scanPackageSubscriptionTopicMap(input: {
	env: SubscriptionTopicCacheEnv
	baseUrl: string
	userId: string
	generation?: number
}): Promise<PackageSubscriptionTopicScanResult> {
	const generation =
		input.generation ??
		(await readPackageSubscriptionTopicGeneration({
			env: input.env,
			userId: input.userId,
		}))
	let savedPackages: Array<SavedPackageRecord>
	try {
		savedPackages = await listSavedPackagesByUserId(input.env.APP_DB, {
			userId: input.userId,
		})
	} catch (error) {
		if (isMissingSavedPackagesTableError(error)) {
			return {
				map: emptyTopicMap(input.userId, generation),
				manifestLoadFailures: 0,
			}
		}
		throw error
	}
	const byTopic = new Map<string, Set<string>>()
	let manifestLoadFailures = 0
	const settled = await loadManifestsForSavedPackages({
		env: input.env,
		userId: input.userId,
		savedPackages,
	})
	for (const [index, result] of settled.entries()) {
		if (result.status !== 'fulfilled') {
			manifestLoadFailures += 1
			const savedPackage = savedPackages[index]
			console.warn('package-subscription-topic-map-manifest-load-failed', {
				userId: input.userId,
				packageId: savedPackage?.id,
				sourceId: savedPackage?.sourceId,
				error: result.reason,
			})
			continue
		}
		for (const topic of listPackageSubscriptions(result.value.manifest).map(
			(subscription) => subscription.topic,
		)) {
			const packageIds = byTopic.get(topic) ?? new Set<string>()
			packageIds.add(result.value.savedPackage.id)
			byTopic.set(topic, packageIds)
		}
	}
	const serialized: Record<string, Array<string>> = {}
	for (const topic of [...byTopic.keys()].sort((left, right) =>
		left.localeCompare(right),
	)) {
		serialized[topic] = [...(byTopic.get(topic) ?? [])].sort((left, right) =>
			left.localeCompare(right),
		)
	}
	return {
		map: {
			version: packageSubscriptionTopicMapVersion,
			userId: input.userId,
			generation,
			byTopic: serialized,
			cachedAt: new Date().toISOString(),
		},
		manifestLoadFailures,
	}
}

export async function readPackageSubscriptionTopicMap(input: {
	env: SubscriptionTopicCacheEnv
	userId: string
}): Promise<PackageSubscriptionTopicMap | null> {
	const kv = getSubscriptionTopicKv(input.env)
	if (!kv) return null
	const [raw, generation] = await Promise.all([
		kv.get(buildPackageSubscriptionTopicMapKey(input.userId), {
			type: 'json',
		}),
		readPackageSubscriptionTopicGeneration(input),
	])
	if (!isPackageSubscriptionTopicMap(raw, input.userId)) return null
	// Stale write from a wake that finished after a publish bump is a miss.
	if (raw.generation !== generation) return null
	return raw
}

export async function writePackageSubscriptionTopicMap(input: {
	env: SubscriptionTopicCacheEnv
	map: PackageSubscriptionTopicMap
}) {
	const kv = getSubscriptionTopicKv(input.env)
	if (!kv) return
	const generation = await readPackageSubscriptionTopicGeneration({
		env: input.env,
		userId: input.map.userId,
	})
	if (input.map.generation !== generation) {
		// A publish/unpublish bumped generation while this scan ran — do not
		// overwrite the newer (or pending) projection.
		return
	}
	// No expirationTtl: a TTL could hide a newly published subscription.
	await kv.put(
		buildPackageSubscriptionTopicMapKey(input.map.userId),
		JSON.stringify(input.map),
	)
}

/**
 * Drop the cached map so the next wake cannot match a stale projection.
 * Prefer this before a rebuild when a publish/unpublish changes manifests.
 */
export async function invalidatePackageSubscriptionTopicMap(input: {
	env: SubscriptionTopicCacheEnv
	userId: string
}) {
	const kv = getSubscriptionTopicKv(input.env)
	if (!kv || typeof kv.delete !== 'function') return
	await kv.delete(buildPackageSubscriptionTopicMapKey(input.userId))
}

/**
 * Remove map and generation keys for account deletion.
 */
export async function deletePackageSubscriptionTopicCacheForUser(input: {
	env: SubscriptionTopicCacheEnv
	userId: string
}) {
	const kv = getSubscriptionTopicKv(input.env)
	if (!kv || typeof kv.delete !== 'function') return
	await Promise.all([
		kv.delete(buildPackageSubscriptionTopicMapKey(input.userId)),
		kv.delete(buildPackageSubscriptionTopicGenerationKey(input.userId)),
	])
}

/**
 * Bump generation, delete the map, then recompute. Generation bumps first so a
 * failed delete still forces the next wake to miss (and rescan) instead of
 * matching a pre-publish map. Incomplete scans do not write.
 */
export async function refreshPackageSubscriptionTopicMap(input: {
	env: SubscriptionTopicCacheEnv
	baseUrl: string
	userId: string
}): Promise<PackageSubscriptionTopicMap | null> {
	const kv = getSubscriptionTopicKv(input.env)
	if (!kv) return null
	const generation = await bumpPackageSubscriptionTopicGeneration(input)
	try {
		await invalidatePackageSubscriptionTopicMap(input)
	} catch (error) {
		console.warn('package-subscription-topic-map-invalidate-failed', {
			userId: input.userId,
			error,
		})
	}
	const scanned = await scanPackageSubscriptionTopicMap({
		...input,
		generation,
	})
	if (scanned.manifestLoadFailures > 0) {
		// Leave the key missing so the next wake rescans rather than trusting
		// a partial map that dropped subscribers.
		return null
	}
	await writePackageSubscriptionTopicMap({
		env: input.env,
		map: scanned.map,
	})
	return scanned.map
}

/**
 * Wake path: one KV get on hit; on miss, scan once, fill KV only when the
 * scan was complete and generation is unchanged, return the map.
 */
export async function getOrFillPackageSubscriptionTopicMap(input: {
	env: SubscriptionTopicCacheEnv
	baseUrl: string
	userId: string
}): Promise<PackageSubscriptionTopicMap> {
	const cached = await readPackageSubscriptionTopicMap(input)
	if (cached) return cached
	const generation = await readPackageSubscriptionTopicGeneration(input)
	const scanned = await scanPackageSubscriptionTopicMap({
		...input,
		generation,
	})
	if (scanned.manifestLoadFailures === 0) {
		try {
			await writePackageSubscriptionTopicMap({
				env: input.env,
				map: scanned.map,
			})
		} catch (error) {
			console.warn('package-subscription-topic-map-write-failed', {
				userId: input.userId,
				error,
			})
		}
	}
	return scanned.map
}

/**
 * Resolve candidate package ids for a topic from the per-user map (hit or
 * miss-fill). When KV is unavailable, returns null so callers can fall back to
 * a full uncached scan.
 */
export async function resolvePackageIdsForSubscriptionTopic(input: {
	env: SubscriptionTopicCacheEnv
	baseUrl: string
	userId: string
	topic: string
}): Promise<Array<string> | null> {
	if (!getSubscriptionTopicKv(input.env)) return null
	const map = await getOrFillPackageSubscriptionTopicMap(input)
	return map.byTopic[input.topic] ?? []
}

export async function listSavedPackagesForSubscriptionTopic(input: {
	env: SubscriptionTopicCacheEnv
	baseUrl: string
	userId: string
	topic: string
}): Promise<{
	savedPackages: Array<SavedPackageRecord>
	/**
	 * True when the topic map was consulted (hit or miss-fill). False when KV
	 * was unavailable and the caller must scan every saved package.
	 */
	usedTopicMap: boolean
}> {
	const packageIds = await resolvePackageIdsForSubscriptionTopic(input)
	if (packageIds === null) {
		return { savedPackages: [], usedTopicMap: false }
	}
	if (packageIds.length === 0) {
		return { savedPackages: [], usedTopicMap: true }
	}
	const savedPackages = await listSavedPackagesByIds(input.env.APP_DB, {
		userId: input.userId,
		packageIds,
	})
	return { savedPackages, usedTopicMap: true }
}

/**
 * Read the topic map when present and generation-current. Returns `null` when
 * KV is unavailable, the key is missing, or the map is stale.
 */
export async function tryReadPackageSubscriptionTopicMap(input: {
	env: SubscriptionTopicCacheEnv
	userId: string
}): Promise<PackageSubscriptionTopicMap | null> {
	if (!getSubscriptionTopicKv(input.env)) return null
	return await readPackageSubscriptionTopicMap(input)
}

/**
 * Write a wake-built map only when it matches the current generation and the
 * scan had no manifest failures. Returns whether the write was attempted.
 */
export async function fillPackageSubscriptionTopicMapFromWakeScan(input: {
	env: SubscriptionTopicCacheEnv
	userId: string
	generation: number
	byTopic: Record<string, Array<string>>
	manifestLoadFailures: number
}) {
	if (input.manifestLoadFailures > 0) return false
	await writePackageSubscriptionTopicMap({
		env: input.env,
		map: {
			version: packageSubscriptionTopicMapVersion,
			userId: input.userId,
			generation: input.generation,
			byTopic: input.byTopic,
			cachedAt: new Date().toISOString(),
		},
	})
	return true
}
