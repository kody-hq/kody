import type { WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	decodePathKey,
	linkedPackageImportPrefix,
} from './module-graph-paths.ts'

export const bundleArtifactManifestVersion = 1

/**
 * What a stored module is, recorded by the writer so a loader does not have
 * to work it out from the path:
 * - `main`: the artifact's entry module.
 * - `linked-artifact`: a module of another package's artifact that linking
 *   copied in under `.__kody_linked__/artifacts/`.
 * - `linked-import`: a `.__kody_linked__/` module that stands for an import
 *   of another package.
 * - `module`: everything else the bundle carries.
 */
export type BundleArtifactModuleRole =
	| 'main'
	| 'linked-artifact'
	| 'linked-import'
	| 'module'

/**
 * The published package version a stored module came from. For a
 * `linked-artifact` module this is the dependency Kody linked in, read from
 * the path Kody wrote it under (a build cannot upload `.__kody_linked__/`
 * paths). Every other module belongs to the artifact's own source and commit.
 * A dependency a cloud build inlined into the bundle is not separable, so its
 * code counts as the importer's.
 */
export type BundleArtifactModuleOwner = {
	sourceId: string
	publishedCommit: string
	/** The `kody:@…` specifier a linked dependency was imported by. */
	specifier?: string
}

export type BundleArtifactManifest = {
	version: typeof bundleArtifactManifestVersion
	/** Sum of `modules[*].bytes`. */
	totalBytes: number
	modules: Record<
		string,
		{
			role: BundleArtifactModuleRole
			bytes: number
			/** Absent on manifests written before owners were recorded. */
			owner?: BundleArtifactModuleOwner
		}
	>
}

const textEncoder = new TextEncoder()
const linkedSegment = `${linkedPackageImportPrefix}/`
const linkedArtifactsSegment = `${linkedPackageImportPrefix}/artifacts/`

function moduleBytes(module: WorkerLoaderModules[string]) {
	if (typeof module === 'string') return textEncoder.encode(module).byteLength
	let bytes = 0
	for (const source of [module.js, module.cjs, module.text]) {
		if (typeof source === 'string') {
			bytes += textEncoder.encode(source).byteLength
		}
	}
	if (module.data !== undefined) bytes += module.data.byteLength
	if (module.json !== undefined) {
		bytes += textEncoder.encode(JSON.stringify(module.json) ?? '').byteLength
	}
	return bytes
}

function moduleRole(
	modulePath: string,
	mainModule: string,
): BundleArtifactModuleRole {
	if (modulePath === mainModule) return 'main'
	const path = `/${modulePath}`
	if (path.includes(`/${linkedArtifactsSegment}`)) return 'linked-artifact'
	if (path.includes(`/${linkedSegment}`)) return 'linked-import'
	return 'module'
}

const linkedArtifactKey = /^(.+)#([^#]+)#([0-9a-f]{40})$/

/**
 * The dependency version a `.__kody_linked__/artifacts/…` path names. The
 * path does not mark where the encoded key ends, and a module directory can
 * look like one more piece of it, so this takes the shortest run of segments
 * that decodes to a whole `specifier#sourceId#commit` key.
 */
function linkedArtifactOwner(
	modulePath: string,
): BundleArtifactModuleOwner | null {
	// The innermost group, in case a linked artifact sits under another one.
	const innermost = `/${modulePath}`.lastIndexOf(`/${linkedArtifactsSegment}`)
	const segments = modulePath
		.slice(innermost + linkedArtifactsSegment.length)
		.split('/')
	let encoded = ''
	for (const segment of segments.slice(0, -1)) {
		encoded += segment
		const match = linkedArtifactKey.exec(decodePathKey(encoded) ?? '')
		if (match) {
			return {
				specifier: match[1]!,
				sourceId: match[2]!,
				publishedCommit: match[3]!,
			}
		}
	}
	return null
}

export function createBundleArtifactManifest(input: {
	sourceId: string
	publishedCommit: string
	mainModule: string
	modules: WorkerLoaderModules
}): BundleArtifactManifest {
	const modules: BundleArtifactManifest['modules'] = {}
	const ownOwner = {
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
	}
	let totalBytes = 0
	for (const [modulePath, module] of Object.entries(input.modules)) {
		const bytes = moduleBytes(module)
		totalBytes += bytes
		const role = moduleRole(modulePath, input.mainModule)
		const owner =
			role === 'linked-artifact' ? linkedArtifactOwner(modulePath) : ownOwner
		modules[modulePath] = { role, bytes, ...(owner ? { owner } : {}) }
	}
	return { version: bundleArtifactManifestVersion, totalBytes, modules }
}

const moduleRoles = new Set<string>([
	'main',
	'linked-artifact',
	'linked-import',
	'module',
])

function isModuleOwner(value: unknown): value is BundleArtifactModuleOwner {
	if (!value || typeof value !== 'object') return false
	const owner = value as Record<string, unknown>
	return (
		typeof owner.sourceId === 'string' &&
		typeof owner.publishedCommit === 'string' &&
		(owner.specifier === undefined || typeof owner.specifier === 'string')
	)
}

/**
 * The stored manifest when it describes exactly the stored modules, else
 * null. A manifest from a newer version, or one that does not match the
 * modules beside it, is treated as absent rather than trusted.
 */
export function parseStoredBundleArtifactManifest(
	stored: unknown,
	modulePaths: ReadonlyArray<string>,
): BundleArtifactManifest | null {
	if (!stored || typeof stored !== 'object') return null
	const manifest = stored as Partial<BundleArtifactManifest>
	if (manifest.version !== bundleArtifactManifestVersion) return null
	if (!Number.isSafeInteger(manifest.totalBytes)) return null
	if (!manifest.modules || typeof manifest.modules !== 'object') return null
	const entries = Object.entries(manifest.modules)
	if (entries.length !== modulePaths.length) return null
	let moduleBytesSum = 0
	for (const modulePath of modulePaths) {
		const entry = (manifest.modules as Record<string, unknown>)[modulePath] as
			| { role?: unknown; bytes?: unknown; owner?: unknown }
			| undefined
		if (!entry || typeof entry !== 'object') return null
		if (typeof entry.role !== 'string' || !moduleRoles.has(entry.role)) {
			return null
		}
		if (entry.owner !== undefined && !isModuleOwner(entry.owner)) return null
		const bytes = entry.bytes
		if (
			typeof bytes !== 'number' ||
			!Number.isSafeInteger(bytes) ||
			bytes < 0
		) {
			return null
		}
		moduleBytesSum += bytes
	}
	if (manifest.totalBytes !== moduleBytesSum) return null
	return manifest as BundleArtifactManifest
}
