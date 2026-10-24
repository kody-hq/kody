import {
	isPublishedArtifactRefusedByLoadSites,
	isUnrepairablePreBindingArtifact,
	packageBindingRewriteVersion,
} from './pre-binding-artifact-repair.ts'
import {
	type AuthoredPackageJson,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'
import {
	type BundleArtifactDependency,
	type BundleArtifactDynamicDependency,
	type BundleArtifactKind,
	type PublishedBundleArtifact,
	type PublishedSourceSnapshot,
	bundleArtifactVersion,
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
	type PublishedBundleArtifactUpsertInput,
	updatePublishedBundleArtifactRow,
	upsertPublishedBundleArtifactRow,
	upsertPublishedBundleArtifactRows,
} from '#worker/repo/published-bundle-artifacts-repo.ts'
import { listEntitySourcesByIds } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	collectPublishedPackageArtifactTargets,
	type PublishedPackageArtifactBuildTarget,
} from './package-artifact-targets.ts'
import { publishedPackageArtifactTargetInputsChanged } from './published-bundle-artifact-inputs.ts'

type PersistPublishedBundleArtifactInput = {
	env: Env
	userId: string
	source: EntitySourceRow
	kind: BundleArtifactKind
	artifactName?: string | null
	entryPoint: string
	mainModule: string
	modules: WorkerLoaderModules
	dependencies: Array<BundleArtifactDependency>
	dynamicDependencies?: Array<BundleArtifactDynamicDependency>
	packageContext?: PublishedBundleArtifact['packageContext']
}

type PublishedPackageArtifactBuilders = {
	buildAppBundle: (args: { entryPoint: string }) => Promise<{
		mainModule: string
		modules: WorkerLoaderModules
		dependencies: Array<BundleArtifactDependency>
		dynamicDependencies?: Array<BundleArtifactDynamicDependency>
	}>
	buildAppClientBundle: (args: { entryPoint: string }) => Promise<{
		mainModule: string
		modules: WorkerLoaderModules
		dependencies: Array<BundleArtifactDependency>
		dynamicDependencies?: Array<BundleArtifactDynamicDependency>
	}>
	buildModuleBundle: (args: { entryPoint: string }) => Promise<{
		mainModule: string
		modules: WorkerLoaderModules
		dependencies: Array<BundleArtifactDependency>
		dynamicDependencies?: Array<BundleArtifactDynamicDependency>
	}>
	buildImportableModuleBundle: (args: { entryPoint: string }) => Promise<{
		mainModule: string
		modules: WorkerLoaderModules
		dependencies: Array<BundleArtifactDependency>
		dynamicDependencies?: Array<BundleArtifactDynamicDependency>
	}>
}

function normalizeArtifactName(artifactName: string | null | undefined) {
	const trimmed = artifactName?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : null
}

function normalizeEntryPoint(entryPoint: string) {
	const trimmed = entryPoint.trim().replace(/^\.?\//, '')
	if (!trimmed) {
		throw new Error('Bundle artifact entrypoint must be non-empty.')
	}
	return trimmed
}

function toDbRowInput(input: {
	userId: string
	sourceId: string
	publishedCommit: string
	kind: BundleArtifactKind
	artifactName: string | null
	entryPoint: string
	kvKey: string
	dependencies: Array<BundleArtifactDependency>
}): PublishedBundleArtifactUpsertInput {
	return {
		userId: input.userId,
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		artifactKind: input.kind,
		artifactName: input.artifactName,
		entryPoint: input.entryPoint,
		kvKey: input.kvKey,
		dependenciesJson: JSON.stringify(input.dependencies),
	}
}

function matchesPublishedBundleArtifactIdentity(input: {
	artifact: PublishedBundleArtifact
	sourceId: string
	publishedCommit: string
	kind: BundleArtifactKind
	artifactName: string | null
	entryPoint: string
}) {
	let artifactEntryPoint: string
	try {
		artifactEntryPoint = normalizeEntryPoint(input.artifact.entryPoint)
	} catch {
		return false
	}
	return (
		input.artifact.sourceId === input.sourceId &&
		input.artifact.publishedCommit === input.publishedCommit &&
		input.artifact.kind === input.kind &&
		normalizeArtifactName(input.artifact.artifactName) === input.artifactName &&
		artifactEntryPoint === input.entryPoint &&
		input.artifact.modules[input.artifact.mainModule] != null
	)
}

type PreparedPublishedBundleArtifactPersist = {
	env: Env
	kvKey: string
	artifact: PublishedBundleArtifact
	rowInput: PublishedBundleArtifactUpsertInput
}

function preparePublishedBundleArtifactPersist(
	input: PersistPublishedBundleArtifactInput,
): PreparedPublishedBundleArtifactPersist | null {
	if (
		!input.source.published_commit ||
		!hasPublishedRuntimeArtifacts(input.env)
	) {
		return null
	}
	const artifactName = normalizeArtifactName(input.artifactName)
	const entryPoint = normalizeEntryPoint(input.entryPoint)
	const kvKey = buildPublishedBundleArtifactKvKey({
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
		kind: input.kind,
		artifactName,
		entryPoint,
	})
	const artifact: PublishedBundleArtifact = {
		version: bundleArtifactVersion,
		kind: input.kind,
		artifactName,
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
		entryPoint,
		mainModule: input.mainModule,
		modules: input.modules,
		dependencies: input.dependencies,
		dynamicDependencies: input.dynamicDependencies ?? [],
		packageContext: input.packageContext ?? null,
		createdAt: new Date().toISOString(),
		// Persisted modules come from the current builder, which binds package
		// `fetch` lexically and never inlines an unbound pre-fetch bundle.
		packageBindingRewrite: packageBindingRewriteVersion,
	}
	return {
		env: input.env,
		kvKey,
		artifact,
		rowInput: toDbRowInput({
			userId: input.userId,
			sourceId: input.source.id,
			publishedCommit: input.source.published_commit,
			kind: input.kind,
			artifactName,
			entryPoint,
			kvKey,
			dependencies: input.dependencies,
		}),
	}
}

type WrittenPublishedBundleArtifactPersist = {
	env: Env
	kvKey: string
	rowInput: PublishedBundleArtifactUpsertInput
}

/** Last write wins per identity — matches upsertPublishedBundleArtifactRows. */
function dedupePreparedPublishedBundleArtifacts(
	prepared: ReadonlyArray<PreparedPublishedBundleArtifactPersist>,
) {
	const byKey = new Map<string, PreparedPublishedBundleArtifactPersist>()
	for (const entry of prepared) {
		byKey.set(
			publishedBundleArtifactIdentityKey({
				sourceId: entry.rowInput.sourceId,
				artifactKind: entry.rowInput.artifactKind,
				artifactName: entry.rowInput.artifactName,
				entryPoint: entry.rowInput.entryPoint,
			}),
			entry,
		)
	}
	return [...byKey.values()]
}

/**
 * Persist many published bundle artifacts with one batched identity upsert
 * (constant D1 round trips for the row writes). D1 is committed first; KV is
 * written only for accepted rows. That avoids same-commit KV overwrites that
 * can skip rebuild or strand committed rows when a later step fails.
 */
export async function persistPublishedBundleArtifacts(
	inputs: ReadonlyArray<PersistPublishedBundleArtifactInput>,
): Promise<Array<string | null>> {
	if (inputs.length === 0) return []
	const preparedByIndex: Array<PreparedPublishedBundleArtifactPersist | null> =
		inputs.map((input) => preparePublishedBundleArtifactPersist(input))
	const prepared = dedupePreparedPublishedBundleArtifacts(
		preparedByIndex.filter(
			(entry): entry is PreparedPublishedBundleArtifactPersist => entry != null,
		),
	)
	if (prepared.length === 0) {
		return preparedByIndex.map(() => null)
	}
	const written = prepared.map((entry) => ({
		env: entry.env,
		kvKey: entry.kvKey,
		rowInput: entry.rowInput,
	}))
	const rowIds = await upsertPreparedPublishedBundleArtifactRows(written)
	const accepted: Array<PreparedPublishedBundleArtifactPersist> = []
	for (const [index, entry] of prepared.entries()) {
		if (rowIds[index] == null) continue
		accepted.push(entry)
	}
	const settled = await Promise.allSettled(
		accepted.map(async (entry) => {
			await writePublishedBundleArtifact({
				env: entry.env,
				artifact: entry.artifact,
				kvKey: entry.kvKey,
			})
		}),
	)
	const rejected = settled.find((result) => result.status === 'rejected')
	if (rejected && rejected.status === 'rejected') {
		throw rejected.reason
	}
	const kvByIdentity = new Map<string, string>()
	for (const [index, entry] of prepared.entries()) {
		if (rowIds[index] == null) continue
		kvByIdentity.set(
			publishedBundleArtifactIdentityKey({
				sourceId: entry.rowInput.sourceId,
				artifactKind: entry.rowInput.artifactKind,
				artifactName: entry.rowInput.artifactName,
				entryPoint: entry.rowInput.entryPoint,
			}),
			entry.kvKey,
		)
	}
	return preparedByIndex.map((entry) => {
		if (!entry) return null
		return (
			kvByIdentity.get(
				publishedBundleArtifactIdentityKey({
					sourceId: entry.rowInput.sourceId,
					artifactKind: entry.rowInput.artifactKind,
					artifactName: entry.rowInput.artifactName,
					entryPoint: entry.rowInput.entryPoint,
				}),
			) ?? null
		)
	})
}

async function writePreparedPublishedBundleArtifact(
	prepared: PreparedPublishedBundleArtifactPersist,
) {
	await writePublishedBundleArtifact({
		env: prepared.env,
		artifact: prepared.artifact,
		kvKey: prepared.kvKey,
	})
}

function writtenPublishedBundleArtifactIdentityKey(
	entry: WrittenPublishedBundleArtifactPersist,
) {
	return publishedBundleArtifactIdentityKey({
		sourceId: entry.rowInput.sourceId,
		artifactKind: entry.rowInput.artifactKind,
		artifactName: entry.rowInput.artifactName,
		entryPoint: entry.rowInput.entryPoint,
	})
}

async function upsertPreparedPublishedBundleArtifactRows(
	prepared: ReadonlyArray<WrittenPublishedBundleArtifactPersist>,
): Promise<Array<string | null>> {
	if (prepared.length === 0) return []
	const unique = new Map<string, WrittenPublishedBundleArtifactPersist>()
	for (const entry of prepared) {
		unique.set(writtenPublishedBundleArtifactIdentityKey(entry), entry)
	}
	const entries = [...unique.values()]
	const db = entries[0]!.env.APP_DB
	const rowInputs = entries.map((entry) => entry.rowInput)
	const uniqueRowIds =
		rowInputs.length === 1
			? [await upsertPublishedBundleArtifactRow(db, rowInputs[0]!)]
			: await upsertPublishedBundleArtifactRows(db, rowInputs)
	const idByIdentity = new Map<string, string | null>()
	for (const [index, entry] of entries.entries()) {
		idByIdentity.set(
			writtenPublishedBundleArtifactIdentityKey(entry),
			uniqueRowIds[index] ?? null,
		)
	}
	// Expand back to the caller’s written order (duplicates share the winner).
	return prepared.map(
		(entry) =>
			idByIdentity.get(writtenPublishedBundleArtifactIdentityKey(entry)) ??
			null,
	)
}

export async function persistPublishedBundleArtifact(
	input: PersistPublishedBundleArtifactInput,
) {
	const [kvKey] = await persistPublishedBundleArtifacts([input])
	return kvKey ?? null
}

export type LoadedPublishedBundleArtifact = {
	row: PublishedBundleArtifactRecord
	artifact: PublishedBundleArtifact | null
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
}): Promise<LoadedPublishedBundleArtifact> {
	const artifact = await readPublishedBundleArtifact({
		env: input.env,
		kvKey: input.row.kvKey,
	})
	if (!artifact) {
		return {
			row: input.row,
			artifact: null,
		}
	}
	if (
		!matchesPublishedBundleArtifactIdentity({
			artifact,
			sourceId: input.row.sourceId,
			publishedCommit: input.row.publishedCommit,
			kind: input.kind,
			artifactName: input.artifactName,
			entryPoint: input.entryPoint,
		})
	) {
		return {
			row: input.row,
			artifact: null,
		}
	}
	return {
		row: input.row,
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
	}>
}): Promise<Map<string, LoadedPublishedBundleArtifact | null>> {
	const normalized = new Map<
		string,
		{
			identity: PublishedBundleArtifactIdentity
			kind: BundleArtifactKind
			artifactName: string | null
			entryPoint: string
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
	await Promise.all(
		[...normalized.entries()].map(async ([key, entry]) => {
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
				}),
			)
		}),
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
}) {
	if (!hasPublishedRuntimeArtifacts(input.env)) return false
	const loaded = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
		kind: input.target.kind,
		artifactName: input.target.artifactName,
		entryPoint: input.target.entryPoint,
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
}) {
	if (!hasPublishedRuntimeArtifacts(input.env)) return false
	const loaded = await loadPublishedBundleArtifactByIdentity({
		env: input.env,
		userId: input.userId,
		sourceId: input.sourceId,
		kind: input.target.kind,
		artifactName: input.target.artifactName,
		entryPoint: input.target.entryPoint,
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

async function buildPublishedPackageArtifactTargetBundle(
	input: {
		target: PublishedPackageArtifactBuildTarget
	} & PublishedPackageArtifactBuilders,
) {
	const { entryPoint } = input.target
	switch (input.target.bundleKind) {
		case 'app':
			return await input.buildAppBundle({ entryPoint })
		case 'app-client':
			return await input.buildAppClientBundle({ entryPoint })
		case 'importable-module':
			return await input.buildImportableModuleBundle({ entryPoint })
		case 'module':
			return await input.buildModuleBundle({ entryPoint })
		default: {
			const bundleKind: never = input.target.bundleKind
			throw new Error(`Unhandled package artifact bundle kind: ${bundleKind}`)
		}
	}
}

function toPersistPublishedPackageArtifactInput(input: {
	env: Env
	userId: string
	source: EntitySourceRow
	savedPackage: SavedPackageRecord
	target: PublishedPackageArtifactBuildTarget
	bundle: {
		mainModule: string
		modules: WorkerLoaderModules
		dependencies: Array<BundleArtifactDependency>
		dynamicDependencies?: Array<BundleArtifactDynamicDependency>
	}
}): PersistPublishedBundleArtifactInput {
	return {
		env: input.env,
		userId: input.userId,
		source: input.source,
		kind: input.target.kind,
		artifactName: input.target.artifactName,
		entryPoint: input.target.entryPoint,
		mainModule: input.bundle.mainModule,
		modules: input.bundle.modules,
		dependencies: input.bundle.dependencies,
		dynamicDependencies: input.bundle.dynamicDependencies,
		packageContext: {
			packageId: input.savedPackage.id,
			kodyId: input.savedPackage.kodyId,
			sourceId: input.savedPackage.sourceId,
		},
	}
}

export async function persistPublishedPackageArtifactTarget(
	input: {
		env: Env
		userId: string
		source: EntitySourceRow
		savedPackage: SavedPackageRecord
		target: PublishedPackageArtifactBuildTarget
	} & PublishedPackageArtifactBuilders,
) {
	const bundle = await buildPublishedPackageArtifactTargetBundle(input)
	return await persistPublishedBundleArtifact(
		toPersistPublishedPackageArtifactInput({ ...input, bundle }),
	)
}

export type PersistPublishedPackageArtifactTargetResult =
	| {
			ok: true
			target: PublishedPackageArtifactBuildTarget
			kvKey: string | null
	  }
	| {
			ok: false
			target: PublishedPackageArtifactBuildTarget
			error: unknown
	  }

/**
 * Build then persist many package artifact targets with one batched D1 upsert.
 * Each successful build writes KV immediately (so heap stays one bundle) and
 * only the identity row writes are batched. Per-target build failures are
 * isolated; a batch upsert failure marks built targets failed but leaves their
 * KV keys (orphan KV is safe; deleting keys identity rows may point at is not).
 */
export async function persistPublishedPackageArtifactTargets(
	input: {
		env: Env
		userId: string
		source: EntitySourceRow
		savedPackage: SavedPackageRecord
		targets: ReadonlyArray<PublishedPackageArtifactBuildTarget>
	} & PublishedPackageArtifactBuilders,
): Promise<Array<PersistPublishedPackageArtifactTargetResult>> {
	if (input.targets.length === 0) return []
	const results: Array<PersistPublishedPackageArtifactTargetResult | null> =
		input.targets.map(() => null)
	const pending: Array<{
		index: number
		prepared: PreparedPublishedBundleArtifactPersist
	}> = []
	for (const [index, target] of input.targets.entries()) {
		try {
			const bundle = await buildPublishedPackageArtifactTargetBundle({
				...input,
				target,
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
			if (!prepared) {
				results[index] = { ok: true, target, kvKey: null }
				continue
			}
			pending.push({ index, prepared })
		} catch (error) {
			results[index] = { ok: false, target, error }
		}
	}
	if (pending.length > 0) {
		try {
			const written = pending.map(({ prepared }) => ({
				env: prepared.env,
				kvKey: prepared.kvKey,
				rowInput: prepared.rowInput,
			}))
			const rowIds = await upsertPreparedPublishedBundleArtifactRows(written)
			for (const [persistOffset, entry] of pending.entries()) {
				const target = input.targets[entry.index]
				if (!target) continue
				if (rowIds[persistOffset] == null) {
					results[entry.index] = {
						ok: false,
						target,
						error: new Error(
							'Published bundle artifact identity write was refused (stale live commit).',
						),
					}
					continue
				}
				await writePreparedPublishedBundleArtifact(entry.prepared)
				results[entry.index] = {
					ok: true,
					target,
					kvKey: entry.prepared.kvKey,
				}
			}
		} catch (error) {
			for (const entry of pending) {
				const target = input.targets[entry.index]
				if (!target) continue
				if (results[entry.index]) continue
				results[entry.index] = { ok: false, target, error }
			}
		}
	}
	return results.map((result, index) => {
		if (result) return result
		const target = input.targets[index]
		if (!target) {
			throw new Error('Published package artifact target missing at index.')
		}
		return {
			ok: false,
			target,
			error: new Error('Published package artifact target was not built.'),
		}
	})
}

/**
 * Cap concurrent esbuild-wasm rebuilds so a many-export package cannot stack
 * isolate heap the way fully sequential rebuilds used to stretch wall time.
 * Two at a time cuts typical 4-target publishes roughly in half without
 * reopening the session-DO memory failure in kody-hq/kody#987.
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
	const targetsNeedingPersist: Array<PublishedPackageArtifactBuildTarget> = []
	await mapWithConcurrency(
		collectPublishedPackageArtifactTargets(input.manifest),
		publishedPackageArtifactRebuildConcurrency,
		async (target) => {
			if (publishedCommit) {
				const alreadyBuilt = await isPublishedPackageArtifactBuiltForCommit({
					env: input.env,
					userId: input.userId,
					sourceId: input.source.id,
					publishedCommit,
					target,
					snapshotCache,
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
				})
				if (reused) return
			}
			targetsNeedingPersist.push(target)
		},
	)
	if (targetsNeedingPersist.length === 0) return

	// Overlap esbuild (cap 2), write each KV immediately so peak heap stays
	// near the concurrency window, then one batched identity upsert. Build
	// failures are isolated so successful siblings still land (same as the
	// prior per-target persist loop).
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
