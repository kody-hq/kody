import { base64ToBytes, bytesToBase64 } from '@kody-internal/shared/base64.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'

const sourceSnapshotVersion = 1
const sourceManifestSnapshotVersion = 1
export const bundleArtifactVersion = 1
const sourceSnapshotPrefix = 'source-snapshot'
const sourceManifestSnapshotPrefix = 'source-manifest-snapshot'
const bundleArtifactPrefix = 'bundle-artifact'
const credentialNeedsVersion = 1
const credentialNeedsPrefix = 'credential-needs'
const credentialStampVersion = 1
const credentialStampPrefix = 'credential-stamp'

/**
 * `app` is the Worker fetch bundle loaded into the package-app isolate;
 * `app-client` is the browser ESM built from `kody.app.client` and served
 * as a fingerprinted static module (never loaded into an isolate).
 */
export type BundleArtifactKind =
	| 'app'
	| 'app-client'
	| 'importable-module'
	| 'job'
	| 'module'

export type BundleArtifactDependency = {
	sourceId: string
	publishedCommit: string
	kodyId: string
	packageName?: string
	/**
	 * Immutable saved-package UUID of the dependency, recorded at bundle time
	 * from the resolved saved-package row. This is bundler-controlled
	 * provenance: `packageStorage()` grants (see `createPackageStorageKodyTools`
	 * in `#worker/storage-runner.ts`) are derived from it, never from strings in
	 * module source. Absent on artifacts persisted before the field existed;
	 * those bundles carry no package-runtime stamps either, so nothing can
	 * claim the missing grant.
	 */
	packageId?: string
	/**
	 * True when the entry does not import this package directly: another
	 * dependency's reachable source statically imports it, so its stamped
	 * modules are inlined here too. Transitive ids join `packageStorage()` /
	 * secret-authority grants and static-call metering (innermost re-export
	 * layers). Popularity and republish staleness use direct dependencies
	 * only. Absent on artifacts persisted before the field existed; those
	 * recorded direct imports only.
	 */
	transitive?: true
}

export function isDirectBundleDependency(
	dependency: BundleArtifactDependency,
): boolean {
	return dependency.transitive !== true
}

export type BundleArtifactDynamicDependency = {
	specifier: string
	packageName: string
	exportName: string
}

type SerializedWorkerLoaderModule =
	| string
	| {
			js?: string
			cjs?: string
			text?: string
			dataBase64?: string
			json?: object
	  }

export type PublishedSourceSnapshot = {
	version: typeof sourceSnapshotVersion
	sourceId: string
	repoId: string
	entityKind: EntitySourceRow['entity_kind']
	entityId: string
	publishedCommit: string
	manifestPath: string
	sourceRoot: string
	files: Record<string, string>
	createdAt: string
	/**
	 * When set, same-commit artifacts older than this timestamp are treated
	 * as leftovers from a prior snapshot rewrite. Used so an interrupted
	 * already_published rebuild cannot keep serving stale bundles after the
	 * snapshot now matches HEAD.
	 */
	invalidateArtifactsBefore?: string
	/**
	 * True when this KV entry was rebuilt from Artifacts git (or the local
	 * mock API) after a miss — not written by a real publish finalize.
	 * Loaders must not treat `createdAt` as the publish clock for npm-bundle
	 * rebuild windows (#3497).
	 */
	recoveredFromArtifacts?: true
}

export type PublishedSourceManifestSnapshot = {
	version: typeof sourceManifestSnapshotVersion
	sourceId: string
	publishedCommit: string
	manifestPath: string
	manifestContent: string
	createdAt: string
}

export type PublishedBundleArtifact = {
	version: typeof bundleArtifactVersion
	kind: BundleArtifactKind
	artifactName: string | null
	sourceId: string
	publishedCommit: string
	entryPoint: string
	mainModule: string
	modules: WorkerLoaderModules
	dependencies: Array<BundleArtifactDependency>
	dynamicDependencies?: Array<BundleArtifactDynamicDependency>
	packageContext: {
		packageId: string
		kodyId: string
		sourceId: string
	} | null
	createdAt: string
}

type StoredPublishedBundleArtifact = Omit<
	PublishedBundleArtifact,
	'modules'
> & {
	modules: Record<string, SerializedWorkerLoaderModule>
	/**
	 * Present on platform-injection-built artifacts from before decision
	 * 0057. Readers reject those payloads so Remix-injected modules stop
	 * serving without orphaning ordinary npm-backed v1 artifacts.
	 */
	remixVersion?: string
	remixUiVersion?: string
}

/**
 * True when a stored bundle artifact may keep serving. Rejects wrong
 * versions, missing modules, and platform-injection-built payloads that
 * stamped `remixVersion` / `remixUiVersion`.
 */
export function isUsableStoredPublishedBundleArtifact(artifact: {
	version?: unknown
	modules?: unknown
	remixVersion?: unknown
	remixUiVersion?: unknown
}) {
	if (artifact.version !== bundleArtifactVersion) return false
	if (typeof artifact.remixVersion === 'string') return false
	if (typeof artifact.remixUiVersion === 'string') return false
	return typeof artifact.modules === 'object' && artifact.modules != null
}

function getBundleArtifactsKv(env: Env) {
	const kv = (env as Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace })
		.BUNDLE_ARTIFACTS_KV
	if (!kv) {
		throw new Error(
			'Missing BUNDLE_ARTIFACTS_KV binding for published runtime artifacts.',
		)
	}
	return kv
}

function serializeWorkerLoaderModules(
	modules: WorkerLoaderModules,
): Record<string, SerializedWorkerLoaderModule> {
	return Object.fromEntries(
		Object.entries(modules).map(([path, module]) => {
			if (typeof module === 'string') {
				return [path, module]
			}
			return [
				path,
				{
					...(module.js !== undefined ? { js: module.js } : {}),
					...(module.cjs !== undefined ? { cjs: module.cjs } : {}),
					...(module.text !== undefined ? { text: module.text } : {}),
					...(module.data !== undefined
						? { dataBase64: bytesToBase64(new Uint8Array(module.data)) }
						: {}),
					...(module.json !== undefined ? { json: module.json } : {}),
				} satisfies SerializedWorkerLoaderModule,
			]
		}),
	)
}

function deserializeWorkerLoaderModules(
	modules: Record<string, SerializedWorkerLoaderModule>,
): WorkerLoaderModules {
	return Object.fromEntries(
		Object.entries(modules).map(([path, module]) => {
			if (typeof module === 'string') {
				return [path, module]
			}
			return [
				path,
				{
					...(module.js !== undefined ? { js: module.js } : {}),
					...(module.cjs !== undefined ? { cjs: module.cjs } : {}),
					...(module.text !== undefined ? { text: module.text } : {}),
					...(module.dataBase64 !== undefined
						? { data: base64ToBytes(module.dataBase64).buffer }
						: {}),
					...(module.json !== undefined ? { json: module.json } : {}),
				},
			]
		}),
	)
}

function normalizeArtifactName(artifactName: string | null | undefined) {
	return artifactName?.trim() || '_'
}

function normalizeEntryPoint(entryPoint: string) {
	return entryPoint.trim().replace(/^\.?\//, '')
}

export function buildPublishedSourceSnapshotKvKey(input: {
	sourceId: string
	publishedCommit: string
}) {
	return `${sourceSnapshotPrefix}:v${sourceSnapshotVersion}:${input.sourceId}:${input.publishedCommit}`
}

export function buildPublishedSourceManifestSnapshotKvKey(input: {
	sourceId: string
	publishedCommit: string
}) {
	return `${sourceManifestSnapshotPrefix}:v${sourceManifestSnapshotVersion}:${input.sourceId}:${input.publishedCommit}`
}

/** A package's credential needs closure at one publish (ADR 0068). */
export function buildPublishedCredentialNeedsKvKey(input: {
	sourceId: string
	publishedCommit: string
}) {
	return `${credentialNeedsPrefix}:v${credentialNeedsVersion}:${input.sourceId}:${input.publishedCommit}`
}

export async function writePublishedCredentialNeeds(input: {
	env: Env
	sourceId: string
	publishedCommit: string
	needs: unknown
}) {
	await getBundleArtifactsKv(input.env).put(
		buildPublishedCredentialNeedsKvKey(input),
		JSON.stringify(input.needs),
	)
}

/** The stored closure as written, or null when that publish stored none. */
export async function readPublishedCredentialNeeds(input: {
	env: Env
	sourceId: string
	publishedCommit: string
}): Promise<unknown> {
	return await getBundleArtifactsKv(input.env).get(
		buildPublishedCredentialNeedsKvKey(input),
		'json',
	)
}

/** A package's sealed credential stamp at one publish (issue #3836). */
export function buildPublishedCredentialStampKvKey(input: {
	sourceId: string
	publishedCommit: string
}) {
	return `${credentialStampPrefix}:v${credentialStampVersion}:${input.sourceId}:${input.publishedCommit}`
}

export async function writePublishedCredentialStamp(input: {
	env: Env
	sourceId: string
	publishedCommit: string
	stamp: unknown
}) {
	await getBundleArtifactsKv(input.env).put(
		buildPublishedCredentialStampKvKey(input),
		JSON.stringify(input.stamp),
	)
}

/** The stored stamp as written, or null when that publish stored none. */
export async function readPublishedCredentialStamp(input: {
	env: Env
	sourceId: string
	publishedCommit: string
}): Promise<unknown> {
	return await getBundleArtifactsKv(input.env).get(
		buildPublishedCredentialStampKvKey(input),
		'json',
	)
}

export function buildPublishedBundleArtifactKvKey(input: {
	sourceId: string
	publishedCommit: string
	kind: BundleArtifactKind
	artifactName?: string | null
	entryPoint: string
}) {
	return [
		bundleArtifactPrefix,
		`v${bundleArtifactVersion}`,
		input.sourceId,
		input.publishedCommit,
		input.kind,
		normalizeArtifactName(input.artifactName),
		normalizeEntryPoint(input.entryPoint),
	].join(':')
}

export function hasPublishedRuntimeArtifacts(env: Env) {
	return (
		(env as Env & { BUNDLE_ARTIFACTS_KV?: KVNamespace | undefined })
			.BUNDLE_ARTIFACTS_KV != null
	)
}

export async function writePublishedSourceSnapshot(input: {
	env: Env
	source: EntitySourceRow
	files: Record<string, string>
	invalidateExistingArtifacts?: boolean
	/** Mark this write as a heal/backfill, not a publish finalize. */
	recoveredFromArtifacts?: boolean
}) {
	if (!input.source.published_commit) {
		return null
	}
	const createdAt = new Date().toISOString()
	const snapshot: PublishedSourceSnapshot = {
		version: sourceSnapshotVersion,
		sourceId: input.source.id,
		repoId: input.source.repo_id,
		entityKind: input.source.entity_kind,
		entityId: input.source.entity_id,
		publishedCommit: input.source.published_commit,
		manifestPath: input.source.manifest_path,
		sourceRoot: input.source.source_root,
		files: input.files,
		createdAt,
		...(input.invalidateExistingArtifacts
			? { invalidateArtifactsBefore: createdAt }
			: {}),
		...(input.recoveredFromArtifacts ? { recoveredFromArtifacts: true } : {}),
	}
	const key = buildPublishedSourceSnapshotKvKey({
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
	})
	const manifestContent = input.files[input.source.manifest_path]
	if (typeof manifestContent !== 'string') {
		throw new Error(
			`Published source snapshot is missing manifest "${input.source.manifest_path}".`,
		)
	}
	const manifestKey = buildPublishedSourceManifestSnapshotKvKey({
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
	})
	const manifestSnapshot: PublishedSourceManifestSnapshot = {
		version: sourceManifestSnapshotVersion,
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
		manifestPath: input.source.manifest_path,
		manifestContent,
		createdAt: snapshot.createdAt,
	}
	await Promise.all([
		getBundleArtifactsKv(input.env).put(key, JSON.stringify(snapshot)),
		getBundleArtifactsKv(input.env).put(
			manifestKey,
			JSON.stringify(manifestSnapshot),
		),
	])
	return key
}

export async function readPublishedSourceSnapshot(input: {
	env: Env
	sourceId: string
	publishedCommit: string | null
}) {
	if (!input.publishedCommit) return null
	const key = buildPublishedSourceSnapshotKvKey({
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
	})
	const stored = await getBundleArtifactsKv(input.env).get(key, 'json')
	if (!stored || typeof stored !== 'object') return null
	const snapshot = stored as PublishedSourceSnapshot
	if (
		snapshot.version !== sourceSnapshotVersion ||
		snapshot.sourceId !== input.sourceId ||
		snapshot.publishedCommit !== input.publishedCommit
	) {
		return null
	}
	return snapshot
}

export async function loadPublishedSourceSnapshot(input: {
	env: Env
	userId: string
	source: EntitySourceRow
}) {
	void input.userId
	return await readPublishedSourceSnapshot({
		env: input.env,
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
	})
}

/**
 * True when the stored snapshot file map is the same set of paths and
 * contents as `files`. Missing snapshots never match, so callers can decide
 * whether an already_published refresh must rewrite KV.
 */
export function publishedSourceSnapshotFilesMatch(
	existing: PublishedSourceSnapshot | null | undefined,
	files: Record<string, string>,
) {
	if (!existing?.files) return false
	const existingKeys = Object.keys(existing.files)
	const nextKeys = Object.keys(files)
	if (existingKeys.length !== nextKeys.length) return false
	for (const key of nextKeys) {
		if (existing.files[key] !== files[key]) return false
	}
	return true
}

export async function readPublishedSourceManifestSnapshot(input: {
	env: Env
	sourceId: string
	publishedCommit: string | null
}) {
	if (!input.publishedCommit) return null
	const key = buildPublishedSourceManifestSnapshotKvKey({
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
	})
	const stored = await getBundleArtifactsKv(input.env).get(key, 'json')
	if (!stored || typeof stored !== 'object') return null
	const snapshot = stored as PublishedSourceManifestSnapshot
	if (
		snapshot.version !== sourceManifestSnapshotVersion ||
		snapshot.sourceId !== input.sourceId ||
		snapshot.publishedCommit !== input.publishedCommit
	) {
		return null
	}
	return snapshot
}

export async function loadPublishedSourceManifestSnapshot(input: {
	env: Env
	userId: string
	source: EntitySourceRow
}) {
	void input.userId
	return await readPublishedSourceManifestSnapshot({
		env: input.env,
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
	})
}

export async function persistPublishedSourceSnapshot(input: {
	env: Env
	userId: string
	source: EntitySourceRow
	snapshot: Pick<PublishedSourceSnapshot, 'files'>
	recoveredFromArtifacts?: boolean
}) {
	void input.userId
	return await writePublishedSourceSnapshot({
		env: input.env,
		source: input.source,
		files: input.snapshot.files,
		recoveredFromArtifacts: input.recoveredFromArtifacts,
	})
}

/** Publish clock for npm-bundle rebuild windows; recovered heals are not publishes. */
export function publishedSourceSnapshotCreatedAt(
	snapshot: Pick<
		PublishedSourceSnapshot,
		'createdAt' | 'recoveredFromArtifacts'
	> | null,
) {
	if (!snapshot || snapshot.recoveredFromArtifacts) return null
	return snapshot.createdAt
}

export async function persistPublishedSourceManifestSnapshot(input: {
	env: Env
	userId: string
	source: EntitySourceRow
	snapshot: Pick<PublishedSourceManifestSnapshot, 'manifestContent'>
}) {
	void input.userId
	if (!input.source.published_commit) return null
	const manifestSnapshot: PublishedSourceManifestSnapshot = {
		version: sourceManifestSnapshotVersion,
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
		manifestPath: input.source.manifest_path,
		manifestContent: input.snapshot.manifestContent,
		createdAt: new Date().toISOString(),
	}
	const key = buildPublishedSourceManifestSnapshotKvKey({
		sourceId: input.source.id,
		publishedCommit: input.source.published_commit,
	})
	await getBundleArtifactsKv(input.env).put(
		key,
		JSON.stringify(manifestSnapshot),
	)
	return key
}

export async function deletePublishedSourceSnapshot(input: {
	env: Env
	sourceId: string
	publishedCommit: string | null
}) {
	if (!input.publishedCommit) return
	await Promise.all([
		getBundleArtifactsKv(input.env).delete(
			buildPublishedSourceSnapshotKvKey({
				sourceId: input.sourceId,
				publishedCommit: input.publishedCommit,
			}),
		),
		getBundleArtifactsKv(input.env).delete(
			buildPublishedSourceManifestSnapshotKvKey({
				sourceId: input.sourceId,
				publishedCommit: input.publishedCommit,
			}),
		),
	])
}

export async function writePublishedBundleArtifact(input: {
	env: Env
	artifact: PublishedBundleArtifact
	kvKey?: string
}) {
	const kvKey =
		input.kvKey ??
		buildPublishedBundleArtifactKvKey({
			sourceId: input.artifact.sourceId,
			publishedCommit: input.artifact.publishedCommit,
			kind: input.artifact.kind,
			artifactName: input.artifact.artifactName,
			entryPoint: input.artifact.entryPoint,
		})
	await getBundleArtifactsKv(input.env).put(
		kvKey,
		JSON.stringify({
			...input.artifact,
			modules: serializeWorkerLoaderModules(input.artifact.modules),
		}),
	)
	return kvKey
}

export async function readPublishedBundleArtifact(input: {
	env: Env
	kvKey: string
}) {
	const stored = await getBundleArtifactsKv(input.env).get(input.kvKey, 'json')
	if (!stored || typeof stored !== 'object') return null
	const artifact = stored as StoredPublishedBundleArtifact
	if (!isUsableStoredPublishedBundleArtifact(artifact)) {
		return null
	}
	return {
		version: artifact.version,
		kind: artifact.kind,
		artifactName: artifact.artifactName,
		sourceId: artifact.sourceId,
		publishedCommit: artifact.publishedCommit,
		entryPoint: artifact.entryPoint,
		mainModule: artifact.mainModule,
		dynamicDependencies: artifact.dynamicDependencies ?? [],
		dependencies: artifact.dependencies,
		packageContext: artifact.packageContext
			? {
					...artifact.packageContext,
					sourceId: artifact.packageContext.sourceId ?? artifact.sourceId,
				}
			: null,
		modules: deserializeWorkerLoaderModules(artifact.modules),
		createdAt: artifact.createdAt,
	} satisfies PublishedBundleArtifact
}

export async function deletePublishedBundleArtifact(input: {
	env: Env
	kvKey: string
}) {
	await getBundleArtifactsKv(input.env).delete(input.kvKey)
}
