/**
 * Writing published bundle artifacts: identity normalization, the batched
 * D1-first identity upsert, and building + persisting package artifact
 * targets. Loading, reuse, and rebuild live in `published-bundle-artifacts.ts`.
 */
import { type SavedPackageRecord } from '#worker/package-registry/types.ts'
import {
	publishedBundleArtifactIdentityKey,
	type PublishedBundleArtifactUpsertInput,
	upsertPublishedBundleArtifactRow,
	upsertPublishedBundleArtifactRows,
} from '#worker/repo/published-bundle-artifacts-repo.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { type PublishedPackageArtifactBuildTarget } from './package-artifact-targets.ts'
import { packageBindingRewriteVersion } from './pre-binding-artifact-repair.ts'
import {
	type BundleArtifactDependency,
	type BundleArtifactDynamicDependency,
	type BundleArtifactKind,
	type PublishedBundleArtifact,
	bundleArtifactVersion,
	buildPublishedBundleArtifactKvKey,
	hasPublishedRuntimeArtifacts,
	writePublishedBundleArtifact,
} from './published-runtime-artifacts.ts'

export type PersistPublishedBundleArtifactInput = {
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

export type PublishedPackageArtifactBuilders = {
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

export function normalizeArtifactName(artifactName: string | null | undefined) {
	const trimmed = artifactName?.trim()
	return trimmed && trimmed.length > 0 ? trimmed : null
}

export function normalizeEntryPoint(entryPoint: string) {
	const trimmed = entryPoint.trim().replace(/^\.?\//, '')
	if (!trimmed) {
		throw new Error('Bundle artifact entrypoint must be non-empty.')
	}
	return trimmed
}

export function toDbRowInput(input: {
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

export function matchesPublishedBundleArtifactIdentity(input: {
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

export type PreparedPublishedBundleArtifactPersist = {
	env: Env
	kvKey: string
	artifact: PublishedBundleArtifact
	rowInput: PublishedBundleArtifactUpsertInput
}

export function preparePublishedBundleArtifactPersist(
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

export async function writePreparedPublishedBundleArtifact(
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

export async function upsertPreparedPublishedBundleArtifactRows(
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

export async function buildPublishedPackageArtifactTargetBundle(
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

export function toPersistPublishedPackageArtifactInput(input: {
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
