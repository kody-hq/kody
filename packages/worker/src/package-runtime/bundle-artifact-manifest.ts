import type { WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import { linkedPackageImportPrefix } from './module-graph-paths.ts'

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

export type BundleArtifactManifest = {
	version: typeof bundleArtifactManifestVersion
	/** Sum of `modules[*].bytes`. */
	totalBytes: number
	modules: Record<string, { role: BundleArtifactModuleRole; bytes: number }>
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

export function createBundleArtifactManifest(input: {
	mainModule: string
	modules: WorkerLoaderModules
}): BundleArtifactManifest {
	const modules: BundleArtifactManifest['modules'] = {}
	let totalBytes = 0
	for (const [modulePath, module] of Object.entries(input.modules)) {
		const bytes = moduleBytes(module)
		totalBytes += bytes
		modules[modulePath] = {
			role: moduleRole(modulePath, input.mainModule),
			bytes,
		}
	}
	return { version: bundleArtifactManifestVersion, totalBytes, modules }
}

const moduleRoles = new Set<string>([
	'main',
	'linked-artifact',
	'linked-import',
	'module',
])

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
	for (const modulePath of modulePaths) {
		const entry = (manifest.modules as Record<string, unknown>)[modulePath] as
			| { role?: unknown; bytes?: unknown }
			| undefined
		if (!entry || typeof entry !== 'object') return null
		if (typeof entry.role !== 'string' || !moduleRoles.has(entry.role)) {
			return null
		}
		if (!Number.isSafeInteger(entry.bytes)) return null
	}
	return manifest as BundleArtifactManifest
}
