import {
	isPublishedArtifactRefusedByLoadSites,
	isUnrepairablePreBindingArtifact,
} from './pre-binding-artifact-repair.ts'
import type {
	AuthoredPackageJson,
	SavedPackageRecord,
} from '#worker/package-registry/types.ts'
import {
	type BundleArtifactDependency,
	type BundleArtifactKind,
	type PublishedBundleArtifact,
	type PublishedSourceSnapshot,
	buildPublishedBundleArtifactKvKey,
	deletePublishedBundleArtifact,
	hasPublishedRuntimeArtifacts,
	isDirectBundleDependency,
	readPublishedBundleArtifact,
	readPublishedSourceSnapshot,
	writePublishedBundleArtifact,
} from './published-runtime-artifacts.ts'
import {
	deletePublishedBundleArtifactRowsBySourceId,
	getPublishedBundleArtifactByIdentity,
	listPublishedBundleArtifactsByIdentities,
	listPublishedBundleArtifactsBySourceId,
	publishedBundleArtifactIdentityKey,
	type PublishedBundleArtifactIdentity,
	type PublishedBundleArtifactRecord,
	updatePublishedBundleArtifactRow,
} from '#worker/repo/published-bundle-artifacts-repo.ts'
import {
	advanceEntitySourceServingCommit,
	listEntitySourcesByIds,
} from '#worker/repo/entity-sources.ts'
import { normalizeRepoWorkspacePath } from '#worker/repo/manifest.ts'
import type { EntitySourceRow } from '#worker/repo/types.ts'
import {
	collectPublishedPackageArtifactTargets,
	type PublishedPackageArtifactBuildTarget,
} from './package-artifact-targets.ts'
import { publishedPackageArtifactTargetInputsChanged } from './published-bundle-artifact-inputs.ts'
import {
	matchesPublishedBundleArtifactIdentity,
	normalizeArtifactName,
	normalizeEntryPoint,
	preparePublishedBundleArtifactPersist,
	type PreparedPublishedBundleArtifactPersist,
	type PublishedPackageArtifactBuilders,
	buildPublishedPackageArtifactTargetBundle,
	toDbRowInput,
	toPersistPublishedPackageArtifactInput,
	upsertPreparedPublishedBundleArtifactRows,
	writePreparedPublishedBundleArtifact,
} from './published-bundle-artifact-persist.ts'

export type LoadedPublishedBundleArtifact = {
	row: PublishedBundleArtifactRecord
	artifact: PublishedBundleArtifact | null
}

/**
 * Cap concurrent rebuilds and KV hydrations so a many-export package cannot
 * stack isolate heap. Two at a time cuts typical 4-target publishes roughly in
 * half without reopening the session-DO memory failure in kody-hq/kody#987.
 */
const publishedPackageArtifactRebuildConcurrency = 2

async function mapWithConcurrency<T>(
	items: ReadonlyArray<T>,
	concurrency: number,
	mapper: (item: T) => Promise<void>,
) {
	if (items.length === 0) return
	const limit = Math.max(1, Math.min(concurrency, items.length))
	let nextIndex = 0
	async function worker() {
		while (nextIndex < items.length) {
			const index = nextIndex
			nextIndex += 1
			const item = items[index]
			if (item === undefined) return
			await mapper(item)
		}
	}
	await Promise.all(Array.from({ length: limit }, () => worker()))
}

export function publishedBundleLoadIdentityKey(input: {
	sourceId: string
	kind: BundleArtifactKind
	artifactName?: string | null
	entryPoint: string
}) {
	return publishedBundleArtifactIdentityKey({
		sourceId: input.sourceId,
		artifactKind: input.kind,
		artifactName: normalizeArtifactName(input.artifactName),
		entryPoint: normalizeEntryPoint(input.entryPoint),
	})
}

async function hydratePublishedBundleArtifactRow(input: {
	env: Env
	row: PublishedBundleArtifactRecord
	kind: BundleArtifactKind
	artifactName: string | null
	entryPoint: string
	commit?: string | null
}): Promise<LoadedPublishedBundleArtifact> {
	// The identity row tracks the newest saved build. A runtime reader pinned
	// to an older serving commit reads that commit's payload instead: payloads
	// are commit-keyed and outlive the row moving on.
	const row =
		input.commit != null && input.commit !== input.row.publishedCommit
			? {
					...input.row,
					publishedCommit: input.commit,
					kvKey: buildPublishedBundleArtifactKvKey({
						sourceId: input.row.sourceId,
						publishedCommit: input.commit,
						kind: input.kind,
						artifactName: input.artifactName,
						entryPoint: input.entryPoint,
					}),
				}
			: input.row
	const artifact = await readPublishedBundleArtifact({
		env: input.env,
		kvKey: row.kvKey,
	})
	if (!artifact) {
		return {
			row: row,
			artifact: null,
		}
	}
	if (
		!matchesPublishedBundleArtifactIdentity({
			artifact,
			sourceId: row.sourceId,
			publishedCommit: row.publishedCommit,
			kind: input.kind,
			artifactName: input.artifactName,
			entryPoint: input.entryPoint,
		})
	) {
		return {
			row: row,
			artifact: null,
		}
	}
	return {
		row: row,
		artifact,
	}
}

export async function loadPublishedBundleArtifactByIdentity(input: {
	env: Env
	userId: string
	sourceId: string
	kind: BundleArtifactKind
	artifactName?: string | null
	entryPoint: string
	/**
	 * Load this commit's payload (runtime readers pass the serving commit)
	 * even when the identity row already names a newer build.
	 */
	commit?: string | null
}): Promise<LoadedPublishedBundleArtifact | null> {
	const artifactName = normalizeArtifactName(input.artifactName)
	const entryPoint = normalizeEntryPoint(input.entryPoint)
	const row = await getPublishedBundleArtifactByIdentity(input.env.APP_DB, {
		userId: input.userId,
		sourceId: input.sourceId,
		artifactKind: input.kind,
		artifactName,
		entryPoint,
	})
	if (!row) return null
	return await hydratePublishedBundleArtifactRow({
		env: input.env,
		row,
		kind: input.kind,
		artifactName,
		entryPoint,
		commit: input.commit,
	})
}

/**
 * Batch form of {@link loadPublishedBundleArtifactByIdentity}: one D1 identity
 * SELECT (chunked only at the D1 bind cap), then parallel KV hydrations.
 * Keys use {@link publishedBundleLoadIdentityKey}.
 */
export async function loadPublishedBundleArtifactsByIdentities(input: {
	env: Env
	userId: string
	identities: ReadonlyArray<{
		sourceId: string
		kind: BundleArtifactKind
		artifactName?: string | null
		entryPoint: string
		/** See {@link loadPublishedBundleArtifactByIdentity}. */
		commit?: string | null
	}>
}): Promise<Map<string, LoadedPublishedBundleArtifact | null>> {
	const normalized = new Map<
		string,
		{
			identity: PublishedBundleArtifactIdentity
			kind: BundleArtifactKind
			artifactName: string | null
			entryPoint: string
			commit: string | null
		}
	>()
	for (const identity of input.identities) {
		const artifactName = normalizeArtifactName(identity.artifactName)
		const entryPoint = normalizeEntryPoint(identity.entryPoint)
		const key = publishedBundleArtifactIdentityKey({
			sourceId: identity.sourceId,
			artifactKind: identity.kind,
			artifactName,
			entryPoint,
		})
		if (!normalized.has(key)) {
			normalized.set(key, {
				identity: {
					sourceId: identity.sourceId,
					artifactKind: identity.kind,
					artifactName,
					entryPoint,
				},
				kind: identity.kind,
				artifactName,
				entryPoint,
				commit: identity.commit ?? null,
			})
		}
	}
	const loaded = new Map<string, LoadedPublishedBundleArtifact | null>()
	if (normalized.size === 0) return loaded

	const rowsByKey = await listPublishedBundleArtifactsByIdentities(
		input.env.APP_DB,
		{
			userId: input.userId,
			identities: [...normalized.values()].map((entry) => entry.identity),
		},
	)
	await mapWithConcurrency(
		[...normalized.entries()],
		publishedPackageArtifactRebuildConcurrency,
		async ([key, entry]) => {
			const row = rowsByKey.get(key) ?? null
			if (!row) {
				loaded.set(key, null)
				return
			}
			loaded.set(
				key,
				await hydratePublishedBundleArtifactRow({
					env: input.env,
					row,
					kind: entry.kind,
					artifactName: entry.artifactName,
					entryPoint: entry.entryPoint,
					commit: entry.commit,
				}),
			)
		},
	)
	return loaded
}

/**
 * True when a loaded identity artifact may keep serving for the source tip.
 * Rejects a prior-commit leftover while `published_commit` has already
 * advanced (publish rebuild still in flight). Jobs already enforced this;
 * apps must too so run records naming the new tip do not serve old modules.
 */
export function isPublishedBundleArtifactCurrentForCommit(input: {
	artifact: Pick<PublishedBundleArtifact, 'publishedCommit'> | null | undefined
	rowPublishedCommit?: string | null
	currentPublishedCommit: string | null | undefined
}) {
	return (
		input.currentPublishedCommit != null &&
		input.artifact?.publishedCommit === input.currentPublishedCommit &&
		(input.rowPublishedCommit == null ||
			input.rowPublishedCommit === input.currentPublishedCommit)
	)
}

/**
 * Batch-load identity rows + KV payloads for every rebuild target. Multi-target
 * rebuild pre-checks should call this once and pass each result as `preloaded`
 * so D1 does not repeat the per-identity SELECT (Sentry KODY-B2).
 */
export async function loadPublishedBundleArtifactsForPackageTargets(input: {
	env: Env
	userId: string
	sourceId: string
	targets: ReadonlyArray<PublishedPackageArtifactBuildTarget>
}): Promise<Map<string, LoadedPublishedBundleArtifact | null>> {
	return await loadPublishedBundleArtifactsByIdentities({
		env: input.env,
		userId: input.userId,
		identities: input.targets.map((target) => ({
			sourceId: input.sourceId,
			kind: target.kind,
			artifactName: target.artifactName,
			entryPoint: target.entryPoint,
		})),
	})
}

export function publishedBundleArtifactForPackageTarget(input: {
	sourceId: string
	target: PublishedPackageArtifactBuildTarget
	loadedByIdentity: ReadonlyMap<string, LoadedPublishedBundleArtifact | null>
}): LoadedPublishedBundleArtifact | null {
	return (
		input.loadedByIdentity.get(
			publishedBundleLoadIdentityKey({
				sourceId: input.sourceId,
				kind: input.target.kind,
				artifactName: input.target.artifactName,
				entryPoint: input.target.entryPoint,
			}),
		) ?? null
	)
}

async function resolvePublishedBundleArtifactForTarget(input: {
	env: Env
	userId: string
	sourceId: string
	target: PublishedPackageArtifactBuildTarget
	/**
	 * When the property is present (including `null`), skip the identity load.
	 */
	preloaded?: LoadedPublishedBundleArtifact | null
	preloadedProvided: boolean
}): Promise<LoadedPublishedBundleArtifact | null> {
	if (input.preloadedProvided) {
		return input.preloaded ?? null
	}
	return await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
		kind: input.target.kind,
		artifactName: input.target.artifactName,
		entryPoint: input.target.entryPoint,
	})
}

/**
 * True when a published bundle artifact already exists for this target
 * identity at `publishedCommit` (row + KV payload) and the artifact is not
 * older than the snapshot's `invalidateArtifactsBefore` cutoff. Used to
 * skip rebuild work that would only rewrite the same commit's artifact,
 * while still repairing leftovers after a mismatched already_published
 * snapshot rewrite.
 */
export async function isPublishedPackageArtifactBuiltForCommit(input: {
	env: Env
	userId: string
	sourceId: string
	publishedCommit: string
	target: PublishedPackageArtifactBuildTarget
	snapshotCache?: PublishedPackageArtifactReuseSnapshotCache
	/**
	 * Snapshot already loaded for this rebuild's `publishedCommit`.
	 * `null` means that load found none. Omit to read it here.
	 */
	publishedSnapshot?: PublishedSourceSnapshot | null
	/**
	 * When present (including `null`), skips the identity D1/KV load.
	 * Prefer {@link loadPublishedBundleArtifactsForPackageTargets} for
	 * multi-target rebuilds.
	 */
	preloaded?: LoadedPublishedBundleArtifact | null
}) {
	if (!hasPublishedRuntimeArtifacts(input.env)) return false
	const loaded = await resolvePublishedBundleArtifactForTarget({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
		target: input.target,
		preloaded: input.preloaded,
		preloadedProvided: 'preloaded' in input,
	})
	if (!loaded?.artifact) return false
	if (
		loaded.row.publishedCommit !== input.publishedCommit ||
		loaded.artifact.publishedCommit !== input.publishedCommit
	) {
		return false
	}
	const snapshot = await currentPublishedSnapshot(input)
	const cutoff = snapshot?.invalidateArtifactsBefore
	if (
		cutoff &&
		!publishedArtifactCreatedAtIsAtLeast(loaded.artifact.createdAt, cutoff)
	) {
		return false
	}
	// A row + KV payload at this commit is not enough: a bundle the load
	// sites refuse (built before lexical package identity and inlining other
	// packages) is a gap. Local execute has no source fallback and reports it
	// as a missing importable artifact, so publish repair must rebuild it.
	if (
		isPublishedArtifactRefusedByLoadSites({
			artifact: loaded.artifact,
			sourceFiles: snapshot?.files ?? null,
		})
	) {
		return false
	}
	return true
}

export type PublishedPackageArtifactReuseSnapshotCache = Map<
	string,
	Promise<PublishedSourceSnapshot | null>
>

export type PublishedPackageArtifactDependencySourceCache = Map<
	string,
	Promise<{
		id: string
		user_id: string
		published_commit: string | null
	} | null>
>

function readPublishedSourceSnapshotCached(input: {
	env: Env
	sourceId: string
	publishedCommit: string
	snapshotCache?: PublishedPackageArtifactReuseSnapshotCache
}) {
	const cache = input.snapshotCache
	if (!cache) {
		return readPublishedSourceSnapshot({
			env: input.env,
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
		})
	}
	const cached = cache.get(input.publishedCommit)
	if (cached) return cached
	const pending = readPublishedSourceSnapshot({
		env: input.env,
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
	})
	cache.set(input.publishedCommit, pending)
	return pending
}

/**
 * `publishedSnapshot` is the snapshot loaded for this rebuild. Callers pass
 * that same value to every target. A later rebuild loads again.
 */
function currentPublishedSnapshot(input: {
	env: Env
	sourceId: string
	publishedCommit: string
	snapshotCache?: PublishedPackageArtifactReuseSnapshotCache
	publishedSnapshot?: PublishedSourceSnapshot | null
}) {
	if (input.publishedSnapshot !== undefined) {
		if (
			input.publishedSnapshot &&
			(input.publishedSnapshot.sourceId !== input.sourceId ||
				input.publishedSnapshot.publishedCommit !== input.publishedCommit)
		) {
			throw new Error(
				`Published snapshot for source "${input.publishedSnapshot.sourceId}" at commit "${input.publishedSnapshot.publishedCommit}" does not match rebuild source "${input.sourceId}" at commit "${input.publishedCommit}".`,
			)
		}
		return input.publishedSnapshot
	}
	return readPublishedSourceSnapshotCached({
		env: input.env,
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		snapshotCache: input.snapshotCache,
	})
}

/**
 * Copy a prior-commit artifact onto `publishedCommit` when the target's
 * bundler inputs are unchanged and captured `kody:@` dependency commits
 * still match those sources' current `published_commit`. Artifacts are
 * keyed by commit, so reuse writes the same modules under the new commit
 * key and retargets the identity row. Returns false (rebuild) when prior
 * artifacts or snapshots are missing, inputs changed, bundled dependency
 * snapshots are stale, or the copy fails.
 */
export async function reusePublishedPackageArtifactIfUnchanged(input: {
	env: Env
	userId: string
	sourceId: string
	publishedCommit: string
	target: PublishedPackageArtifactBuildTarget
	snapshotCache?: PublishedPackageArtifactReuseSnapshotCache
	dependencySourceCache?: PublishedPackageArtifactDependencySourceCache
	/**
	 * Snapshot already loaded for this rebuild's `publishedCommit`.
	 * `null` means that load found none. Omit to read it here.
	 * Prior-commit snapshots still go through `snapshotCache`.
	 */
	publishedSnapshot?: PublishedSourceSnapshot | null
	/**
	 * When present (including `null`), skips the identity D1/KV load.
	 * Prefer {@link loadPublishedBundleArtifactsForPackageTargets} for
	 * multi-target rebuilds.
	 */
	preloaded?: LoadedPublishedBundleArtifact | null
}) {
	if (!hasPublishedRuntimeArtifacts(input.env)) return false
	const loaded = await resolvePublishedBundleArtifactForTarget({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
		target: input.target,
		preloaded: input.preloaded,
		preloadedProvided: 'preloaded' in input,
	})
	if (!loaded?.artifact) return false
	if (
		loaded.row.publishedCommit === input.publishedCommit ||
		loaded.artifact.publishedCommit === input.publishedCommit
	) {
		return false
	}
	const priorCommit = loaded.artifact.publishedCommit
	if (loaded.row.publishedCommit !== priorCommit) {
		return false
	}
	// Never carry a bundle the current builder would not produce onto the new
	// commit. A pre-binding bundle that inlines other packages cannot be bound
	// in place, so copying it forward would keep the gap at every later
	// commit. Rebuild it from source instead.
	if (isUnrepairablePreBindingArtifact(loaded.artifact)) {
		return false
	}
	const [previousSnapshot, nextSnapshot] = await Promise.all([
		readPublishedSourceSnapshotCached({
			env: input.env,
			sourceId: input.sourceId,
			publishedCommit: priorCommit,
			snapshotCache: input.snapshotCache,
		}),
		currentPublishedSnapshot(input),
	])
	if (!previousSnapshot?.files || !nextSnapshot?.files) return false
	if (
		publishedPackageArtifactTargetInputsChanged({
			entryPoint: input.target.entryPoint,
			previousFiles: previousSnapshot.files,
			nextFiles: nextSnapshot.files,
		})
	) {
		return false
	}
	if (
		!(await publishedPackageArtifactDependenciesMatchCurrent({
			env: input.env,
			userId: input.userId,
			dependencies: loaded.artifact.dependencies,
			dependencySourceCache: input.dependencySourceCache,
		}))
	) {
		return false
	}
	const artifactName = normalizeArtifactName(input.target.artifactName)
	const entryPoint = normalizeEntryPoint(input.target.entryPoint)
	const kvKey = buildPublishedBundleArtifactKvKey({
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		kind: input.target.kind,
		artifactName,
		entryPoint,
	})
	const artifact: PublishedBundleArtifact = {
		...loaded.artifact,
		publishedCommit: input.publishedCommit,
		createdAt: new Date().toISOString(),
	}
	const rowInput = toDbRowInput({
		userId: input.userId,
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		kind: input.target.kind,
		artifactName,
		entryPoint,
		kvKey,
		dependencies: loaded.artifact.dependencies,
	})
	try {
		await writePublishedBundleArtifact({
			env: input.env,
			artifact,
			kvKey,
		})
		const updated = await updatePublishedBundleArtifactRow(input.env.APP_DB, {
			id: loaded.row.id,
			...rowInput,
		})
		if (!updated) {
			throw new Error('Published bundle artifact identity row was not updated.')
		}
		return true
	} catch {
		await deletePublishedBundleArtifact({
			env: input.env,
			kvKey,
		}).catch(() => {
			// Best effort; fall back to a real rebuild for this target.
		})
		return false
	}
}

/**
 * Read-only twin of {@link reusePublishedPackageArtifactIfUnchanged} for a
 * tree that is not published yet (`packageCheck`): the targets whose current
 * artifact the publish rebuild would copy instead of building, because their
 * bundler inputs in `files` match the snapshot that artifact was built from
 * and its bundled `kody:@` dependencies are still current. `files` are keyed
 * from the package root. Writes nothing.
 */
export async function publishedPackageArtifactTargetsReusableForFiles(input: {
	env: Env
	userId: string
	source: Pick<EntitySourceRow, 'id' | 'manifest_path' | 'source_root'>
	targets: ReadonlyArray<PublishedPackageArtifactBuildTarget>
	files: Record<string, string>
}): Promise<Set<PublishedPackageArtifactBuildTarget>> {
	const reusable = new Set<PublishedPackageArtifactBuildTarget>()
	if (!hasPublishedRuntimeArtifacts(input.env) || input.targets.length === 0) {
		return reusable
	}
	const loadedByIdentity = await loadPublishedBundleArtifactsForPackageTargets({
		env: input.env,
		userId: input.userId,
		sourceId: input.source.id,
		targets: input.targets,
	})
	const snapshotCache: PublishedPackageArtifactReuseSnapshotCache = new Map()
	const dependencySourceCache: PublishedPackageArtifactDependencySourceCache =
		new Map()
	for (const target of input.targets) {
		const loaded = publishedBundleArtifactForPackageTarget({
			sourceId: input.source.id,
			target,
			loadedByIdentity,
		})
		if (!loaded?.artifact) continue
		const priorCommit = loaded.artifact.publishedCommit
		if (loaded.row.publishedCommit !== priorCommit) continue
		if (isUnrepairablePreBindingArtifact(loaded.artifact)) continue
		const previousSnapshot = await readPublishedSourceSnapshotCached({
			env: input.env,
			sourceId: input.source.id,
			publishedCommit: priorCommit,
			snapshotCache,
		})
		if (!previousSnapshot?.files) continue
		const previousFiles = packageRootFiles(input.source, previousSnapshot.files)
		if (
			publishedPackageArtifactTargetInputsChanged({
				entryPoint: target.entryPoint,
				previousFiles,
				nextFiles: input.files,
			})
		) {
			continue
		}
		if (
			!(await publishedPackageArtifactDependenciesMatchCurrent({
				env: input.env,
				userId: input.userId,
				dependencies: loaded.artifact.dependencies,
				dependencySourceCache,
			}))
		) {
			continue
		}
		reusable.add(target)
	}
	return reusable
}

/** Snapshot files (keyed from the repo root) re-keyed from the package root. */
function packageRootFiles(
	source: Pick<EntitySourceRow, 'manifest_path' | 'source_root'>,
	files: Record<string, string>,
) {
	const root = normalizeRepoWorkspacePath(source.source_root).replace(
		/\/+$/,
		'',
	)
	if (!root || root === '.') return files
	const prefix = `${root}/`
	// Older snapshots were keyed from the source root already.
	if (typeof files[source.manifest_path] !== 'string') return files
	const rekeyed: Record<string, string> = {}
	for (const [path, content] of Object.entries(files)) {
		const normalized = normalizeRepoWorkspacePath(path)
		if (normalized.startsWith(prefix)) {
			rekeyed[normalized.slice(prefix.length)] = content
		}
	}
	return rekeyed
}

async function publishedPackageArtifactDependenciesMatchCurrent(input: {
	env: Env
	userId: string
	dependencies: ReadonlyArray<BundleArtifactDependency>
	dependencySourceCache?: PublishedPackageArtifactDependencySourceCache
}) {
	const directDependencies: Array<BundleArtifactDependency> = []
	for (const dependency of input.dependencies) {
		if (!isDirectBundleDependency(dependency)) continue
		if (!dependency.publishedCommit) return false
		directDependencies.push(dependency)
	}
	if (directDependencies.length === 0) return true

	const uniqueIds = [
		...new Set(directDependencies.map((dependency) => dependency.sourceId)),
	]
	const byId = new Map<
		string,
		{
			id: string
			user_id: string
			published_commit: string | null
		}
	>()
	const missingIds: Array<string> = []
	for (const sourceId of uniqueIds) {
		const cached = input.dependencySourceCache?.get(sourceId)
		if (cached) {
			const source = await cached
			if (source) byId.set(sourceId, source)
			continue
		}
		missingIds.push(sourceId)
	}
	if (missingIds.length > 0) {
		const loaded = await listEntitySourcesByIds(input.env.APP_DB, missingIds)
		for (const source of loaded) {
			byId.set(source.id, source)
			input.dependencySourceCache?.set(
				source.id,
				Promise.resolve({
					id: source.id,
					user_id: source.user_id,
					published_commit: source.published_commit,
				}),
			)
		}
		for (const sourceId of missingIds) {
			if (byId.has(sourceId)) continue
			input.dependencySourceCache?.set(sourceId, Promise.resolve(null))
		}
	}

	for (const dependency of directDependencies) {
		const source = byId.get(dependency.sourceId)
		if (!source?.published_commit) return false
		// Deps must belong to the publishing owner (same as
		// getEntitySourceByIdForUser).
		if (source.user_id !== input.userId) return false
		if (source.published_commit !== dependency.publishedCommit) return false
	}
	return true
}

function publishedArtifactCreatedAtIsAtLeast(
	createdAt: string | undefined,
	cutoff: string,
) {
	return typeof createdAt === 'string' && createdAt >= cutoff
}

export async function rebuildPublishedPackageArtifacts(
	input: {
		env: Env
		userId: string
		source: EntitySourceRow
		savedPackage: SavedPackageRecord
		manifest: AuthoredPackageJson
	} & PublishedPackageArtifactBuilders,
) {
	const publishedCommit = input.source.published_commit
	const snapshotCache: PublishedPackageArtifactReuseSnapshotCache = new Map()
	const dependencySourceCache: PublishedPackageArtifactDependencySourceCache =
		new Map()
	const targets = collectPublishedPackageArtifactTargets(input.manifest)
	const loadedByIdentity =
		publishedCommit && hasPublishedRuntimeArtifacts(input.env)
			? await loadPublishedBundleArtifactsForPackageTargets({
					env: input.env,
					userId: input.userId,
					sourceId: input.source.id,
					targets,
				})
			: null
	const targetsNeedingPersist: Array<PublishedPackageArtifactBuildTarget> = []
	await mapWithConcurrency(
		targets,
		publishedPackageArtifactRebuildConcurrency,
		async (target) => {
			if (publishedCommit && loadedByIdentity) {
				const preloaded = publishedBundleArtifactForPackageTarget({
					sourceId: input.source.id,
					target,
					loadedByIdentity,
				})
				const alreadyBuilt = await isPublishedPackageArtifactBuiltForCommit({
					env: input.env,
					userId: input.userId,
					sourceId: input.source.id,
					publishedCommit,
					target,
					snapshotCache,
					preloaded,
				})
				if (alreadyBuilt) return
				const reused = await reusePublishedPackageArtifactIfUnchanged({
					env: input.env,
					userId: input.userId,
					sourceId: input.source.id,
					publishedCommit,
					target,
					snapshotCache,
					dependencySourceCache,
					preloaded,
				})
				if (reused) return
			}
			targetsNeedingPersist.push(target)
		},
	)
	if (targetsNeedingPersist.length === 0) {
		await advanceServingCommitAfterCompleteRebuild(input)
		return
	}

	// Overlap esbuild (cap 2), batch D1 identity upserts, then write KV only
	// for accepted rows. Build failures are isolated so successful siblings
	// still land (same as the prior per-target persist loop).
	const pending: Array<PreparedPublishedBundleArtifactPersist> = []
	let firstError: unknown = null
	await mapWithConcurrency(
		targetsNeedingPersist,
		publishedPackageArtifactRebuildConcurrency,
		async (target) => {
			try {
				const bundle = await buildPublishedPackageArtifactTargetBundle({
					target,
					buildAppBundle: input.buildAppBundle,
					buildAppClientBundle: input.buildAppClientBundle,
					buildModuleBundle: input.buildModuleBundle,
					buildImportableModuleBundle: input.buildImportableModuleBundle,
				})
				const prepared = preparePublishedBundleArtifactPersist(
					toPersistPublishedPackageArtifactInput({
						env: input.env,
						userId: input.userId,
						source: input.source,
						savedPackage: input.savedPackage,
						target,
						bundle,
					}),
				)
				if (!prepared) return
				pending.push(prepared)
			} catch (error) {
				firstError ??= error
			}
		},
	)
	if (pending.length > 0) {
		try {
			const written = pending.map((prepared) => ({
				env: prepared.env,
				kvKey: prepared.kvKey,
				rowInput: prepared.rowInput,
			}))
			const rowIds = await upsertPreparedPublishedBundleArtifactRows(written)
			for (const [index, prepared] of pending.entries()) {
				if (rowIds[index] == null) continue
				await writePreparedPublishedBundleArtifact(prepared)
			}
		} catch (error) {
			firstError ??= error
		}
	}
	if (firstError != null) throw firstError
	await advanceServingCommitAfterCompleteRebuild(input)
}

/** Every target for the published commit is saved: start serving it. */
async function advanceServingCommitAfterCompleteRebuild(input: {
	env: Env
	userId: string
	source: EntitySourceRow
}) {
	const publishedCommit = input.source.published_commit
	if (!publishedCommit) return
	await advanceEntitySourceServingCommit(input.env.APP_DB, {
		id: input.source.id,
		userId: input.source.user_id,
		commit: publishedCommit,
	})
}

export async function deletePublishedArtifactsForSource(input: {
	env: Env
	userId: string
	sourceId: string
}) {
	const rows = await listPublishedBundleArtifactsBySourceId(
		input.env.APP_DB,
		input.userId,
		input.sourceId,
	)
	if (hasPublishedRuntimeArtifacts(input.env)) {
		await Promise.all(
			rows.map(async (row: PublishedBundleArtifactRecord) => {
				await deletePublishedBundleArtifact({
					env: input.env,
					kvKey: row.kvKey,
				})
			}),
		)
	}
	await deletePublishedBundleArtifactRowsBySourceId(
		input.env.APP_DB,
		input.userId,
		input.sourceId,
	)
}

export type { PublishedBundleArtifactRecord }
export { collectPublishedPackageArtifactTargets }
export type { PublishedPackageArtifactBuildTarget }
export {
	persistPublishedBundleArtifact,
	persistPublishedBundleArtifacts,
	persistPublishedPackageArtifactTarget,
	persistPublishedPackageArtifactTargets,
	type PersistPublishedPackageArtifactTargetResult,
} from './published-bundle-artifact-persist.ts'
