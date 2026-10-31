import { chunkArray } from '@kody-internal/shared/chunk.ts'
import {
	loadPackageManifestForSource,
	loadPackageSourceRowsForUser,
} from '#worker/package-registry/source.ts'
import {
	type AuthoredPackageJson,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'

const savedPackageManifestDiscoveryConcurrency = 5

export type LoadedManifestForSavedPackage = {
	savedPackage: SavedPackageRecord
	manifest: AuthoredPackageJson
}

export async function mapSettledInChunks<T, TResult>(
	items: ReadonlyArray<T>,
	mapper: (item: T) => Promise<TResult>,
) {
	const results: Array<PromiseSettledResult<TResult>> = []
	for (const itemChunk of chunkArray(
		items,
		savedPackageManifestDiscoveryConcurrency,
	)) {
		results.push(...(await Promise.allSettled(itemChunk.map(mapper))))
	}
	return results
}

/**
 * Prefetch every saved package source row in one `IN (…)` (KODY-BC), then
 * load manifests with the existing chunk concurrency of 5. A missing or
 * foreign-owned source becomes a per-package rejection with the same
 * "was not found" message as `loadPackageSourceRowForUser`. A prefetch
 * query failure rejects every package so callers collect discovery errors
 * and skip the KV topic map fill.
 *
 * Shared by wake discovery (`loadMatchingPackageSubscriptions`) and the
 * publish/refresh topic-map scan so both paths issue one `entity_sources`
 * query instead of ceil(N/5) sequential `IN`s.
 */
export async function loadManifestsForSavedPackages(input: {
	env: Pick<Env, 'APP_DB' | 'BUNDLE_ARTIFACTS_KV'>
	userId: string
	savedPackages: ReadonlyArray<SavedPackageRecord>
}): Promise<Array<PromiseSettledResult<LoadedManifestForSavedPackage>>> {
	if (input.savedPackages.length === 0) return []

	let sourcesById: Map<string, EntitySourceRow>
	try {
		sourcesById = await loadPackageSourceRowsForUser({
			env: input.env,
			userId: input.userId,
			sourceIds: input.savedPackages.map(
				(savedPackage) => savedPackage.sourceId,
			),
		})
	} catch (error) {
		return input.savedPackages.map(() => ({
			status: 'rejected',
			reason: error,
		}))
	}

	return await mapSettledInChunks(input.savedPackages, async (savedPackage) => {
		const source = sourcesById.get(savedPackage.sourceId)
		if (!source) {
			throw new Error(
				`Saved package source "${savedPackage.sourceId}" was not found.`,
			)
		}
		const loaded = await loadPackageManifestForSource({
			env: input.env as Env,
			userId: input.userId,
			source,
		})
		return {
			savedPackage,
			manifest: loaded.manifest,
		} satisfies LoadedManifestForSavedPackage
	})
}
