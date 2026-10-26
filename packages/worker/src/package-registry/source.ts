import { runD1WithRetry } from '#worker/d1-retry.ts'
import {
	getEntitySourceById,
	listEntitySourcesByIds,
} from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import {
	loadPublishedEntityManifest,
	loadPublishedEntitySource,
} from '#worker/repo/published-source.ts'
import {
	createPublishedPackageCacheKey,
	PromiseLruCache,
} from './published-package-cache.ts'
import { parseAuthoredPackageJson } from './manifest.ts'
import { type AuthoredPackageJson } from './types.ts'

export type LoadedPackageSource = {
	source: EntitySourceRow
	manifest: AuthoredPackageJson
	files: Record<string, string>
	/** KV snapshot `createdAt` when finalize wrote this commit; null on artifact backfill. */
	snapshotCreatedAt?: string | null
}

export type LoadedPackageManifest = {
	source: EntitySourceRow
	manifest: AuthoredPackageJson
}

const packageSourceCache = new PromiseLruCache<LoadedPackageSource>()
const packageManifestCache = new PromiseLruCache<LoadedPackageManifest>()

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (value && typeof value === 'object') {
		const objectValue = value as object
		if (seen.has(objectValue)) {
			return value
		}
		seen.add(objectValue)
		for (const child of Object.values(value as Record<string, unknown>)) {
			deepFreeze(child, seen)
		}
		Object.freeze(objectValue)
	}
	return value
}

function freezeFiles(files: Record<string, string>) {
	return Object.freeze({ ...files }) as Record<string, string>
}

function finalizeLoadedSource(input: {
	source: EntitySourceRow
	manifest: AuthoredPackageJson
	files: Record<string, string>
	snapshotCreatedAt?: string | null
}) {
	return Object.freeze({
		source: deepFreeze({ ...input.source }),
		manifest: deepFreeze(structuredClone(input.manifest)),
		files: freezeFiles(input.files),
		snapshotCreatedAt: input.snapshotCreatedAt ?? null,
	}) as LoadedPackageSource
}

function parsePackageManifest(input: {
	source: EntitySourceRow
	content: string
}) {
	return parseAuthoredPackageJson({
		content: input.content,
		manifestPath: input.source.manifest_path,
		mode: 'published',
	})
}

function getManifestContent(input: {
	source: EntitySourceRow
	files: Record<string, string>
}) {
	const manifestContent = input.files[input.source.manifest_path]
	if (!manifestContent) {
		throw new Error(
			`Saved package manifest "${input.source.manifest_path}" was not found in the repo source.`,
		)
	}
	return manifestContent
}

function canResolveRepoBackedPackageSource(env: Env) {
	const anyEnv = env as Env & {
		APP_DB?: unknown
		BUNDLE_ARTIFACTS_KV?: unknown
	}
	return (
		anyEnv.APP_DB != null &&
		typeof anyEnv.APP_DB === 'object' &&
		anyEnv.BUNDLE_ARTIFACTS_KV != null &&
		typeof anyEnv.BUNDLE_ARTIFACTS_KV === 'object'
	)
}

type PendingPackageSourceRowRequest = {
	sourceId: string
	userId: string
	resolve: (source: EntitySourceRow) => void
	reject: (error: unknown) => void
}

const pendingPackageSourceRowBatches = new WeakMap<
	D1Database,
	Array<PendingPackageSourceRowRequest>
>()

/**
 * Fresh D1 read of the entity-source rows for `sourceIds`, omitting ids that
 * are missing or owned by a different user. Queue subscription discovery
 * (`loadMatchingPackageSubscriptions`) and the publish/refresh topic-map
 * scan (`scanPackageSubscriptionTopicMap`) prefetch every saved package's
 * source with this helper before chunked manifest loads, so one `IN (…)`
 * (chunked by `maxD1BoundParameters`) replaces ceil(N/5) sequential
 * batched lookups from the per-call microtask batcher alone.
 */
export async function loadPackageSourceRowsForUser(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
	sourceIds: ReadonlyArray<string>
}): Promise<Map<string, EntitySourceRow>> {
	const uniqueIds = [...new Set(input.sourceIds)]
	if (uniqueIds.length === 0) return new Map()
	const [singleId] = uniqueIds
	const rows = await runD1WithRetry(async () => {
		if (uniqueIds.length === 1 && singleId) {
			const row = await getEntitySourceById(input.env.APP_DB, singleId)
			return row ? [row] : []
		}
		return await listEntitySourcesByIds(input.env.APP_DB, uniqueIds)
	})
	const byId = new Map<string, EntitySourceRow>()
	for (const row of rows) {
		if (row.user_id === input.userId) byId.set(row.id, row)
	}
	return byId
}

/**
 * Loads the entity-source row for a saved package, rejecting rows owned by a
 * different user. Always a fresh D1 read: publish and rebuild flows depend on
 * observing the current `published_commit`. Invocation hot paths that can
 * tolerate a bounded-staleness row wrap this in the invoke contract cache
 * instead (see `#worker/package-invocations/invoke-contract-cache.ts`).
 *
 * Concurrent calls against the same `APP_DB` in one isolate turn share one
 * batched `IN (…)` read (KODY-7H). A lone lookup still uses
 * {@link getEntitySourceById}.
 */
export async function loadPackageSourceRowForUser(input: {
	env: Env
	userId: string
	sourceId: string
}) {
	const db = input.env.APP_DB
	return await new Promise<EntitySourceRow>((resolve, reject) => {
		const pending = pendingPackageSourceRowBatches.get(db)
		if (pending) {
			pending.push({
				sourceId: input.sourceId,
				userId: input.userId,
				resolve,
				reject,
			})
			return
		}
		pendingPackageSourceRowBatches.set(db, [
			{
				sourceId: input.sourceId,
				userId: input.userId,
				resolve,
				reject,
			},
		])
		queueMicrotask(() => {
			void flushPackageSourceRowBatch(db)
		})
	})
}

async function flushPackageSourceRowBatch(db: D1Database) {
	const pending = pendingPackageSourceRowBatches.get(db)
	pendingPackageSourceRowBatches.delete(db)
	if (!pending || pending.length === 0) return

	const uniqueIds = [...new Set(pending.map((request) => request.sourceId))]
	const uniqueUserIds = [...new Set(pending.map((request) => request.userId))]
	const [singleUserId] = uniqueUserIds
	try {
		const rowsById =
			uniqueUserIds.length === 1 && singleUserId
				? await loadPackageSourceRowsForUser({
						env: { APP_DB: db },
						userId: singleUserId,
						sourceIds: uniqueIds,
					})
				: new Map(
						(
							await runD1WithRetry(() => listEntitySourcesByIds(db, uniqueIds))
						).map((row) => [row.id, row]),
					)
		for (const request of pending) {
			const source = rowsById.get(request.sourceId)
			if (!source || source.user_id !== request.userId) {
				request.reject(
					new Error(
						`Saved package source "${request.sourceId}" was not found.`,
					),
				)
				continue
			}
			request.resolve(source)
		}
	} catch (error) {
		for (const request of pending) {
			request.reject(error)
		}
	}
}

function createPackageSourceCacheKey(input: {
	userId: string
	source: EntitySourceRow
}) {
	return createPublishedPackageCacheKey({
		userId: input.userId,
		source: input.source,
	})
}

async function loadPackageSourceUncached(input: {
	env: Env
	baseUrl: string
	userId: string
	source: EntitySourceRow
}): Promise<LoadedPackageSource> {
	void input.baseUrl
	const published = await loadPublishedEntitySource({
		env: input.env,
		userId: input.userId,
		sourceId: input.source.id,
		source: input.source,
	})
	return finalizeLoadedSource({
		source: input.source,
		manifest: parsePackageManifest({
			source: input.source,
			content: getManifestContent({
				source: input.source,
				files: published.files,
			}),
		}),
		files: published.files,
		snapshotCreatedAt: published.snapshotCreatedAt,
	})
}

export async function loadPackageSourceFromFiles(input: {
	env: Env
	userId: string
	sourceId: string
	files: Record<string, string>
}): Promise<LoadedPackageSource> {
	const source = await loadPackageSourceRowForUser({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
	})
	return finalizeLoadedSource({
		source,
		manifest: parsePackageManifest({
			source,
			content: getManifestContent({
				source,
				files: input.files,
			}),
		}),
		files: input.files,
	})
}

export async function loadPackageSourceBySourceId(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceId: string
}): Promise<LoadedPackageSource> {
	if (!canResolveRepoBackedPackageSource(input.env)) {
		throw new Error('Saved package source bindings are not available.')
	}
	const source = await loadPackageSourceRowForUser({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
	})
	const cacheKey = createPackageSourceCacheKey({
		userId: input.userId,
		source,
	})
	if (!cacheKey) {
		return await loadPackageSourceUncached({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			source,
		})
	}
	return await packageSourceCache.getOrCreate({
		cacheKey,
		create: async () =>
			await loadPackageSourceUncached({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: input.userId,
				source,
			}),
	})
}

export async function loadPackageManifestBySourceId(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceId: string
}): Promise<LoadedPackageManifest> {
	if (!canResolveRepoBackedPackageSource(input.env)) {
		throw new Error('Saved package source bindings are not available.')
	}
	const source = await loadPackageSourceRowForUser({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
	})
	return await loadPackageManifestForSource({
		env: input.env,
		userId: input.userId,
		source,
	})
}

/**
 * Manifest load for a caller that already holds the entity-source row (e.g.
 * the invoke contract check, which resolves the row through its own
 * freshness-bounded cache). Shares the commit-keyed manifest cache with
 * {@link loadPackageManifestBySourceId}, so the KV snapshot is read at most
 * once per published commit per isolate.
 */
export async function loadPackageManifestForSource(input: {
	env: Env
	userId: string
	source: EntitySourceRow
}): Promise<LoadedPackageManifest> {
	const source = input.source
	const cacheKey = createPackageSourceCacheKey({
		userId: input.userId,
		source,
	})
	if (!cacheKey) {
		const published = await loadPublishedEntityManifest({
			env: input.env,
			userId: input.userId,
			sourceId: source.id,
			source,
		})
		return Object.freeze({
			source,
			manifest: parsePackageManifest({
				source,
				content: published.content,
			}),
		}) as LoadedPackageManifest
	}
	const cachedManifest = packageManifestCache.get(cacheKey)
	if (cachedManifest) {
		return await cachedManifest
	}
	return await packageManifestCache.getOrCreate({
		cacheKey,
		create: async () => {
			const published = await loadPublishedEntityManifest({
				env: input.env,
				userId: input.userId,
				sourceId: source.id,
				source,
			})
			return Object.freeze({
				source,
				manifest: parsePackageManifest({
					source,
					content: published.content,
				}),
			}) as LoadedPackageManifest
		},
	})
}
