import {
	listScannableModulePaths,
	parseModule,
	resolveRelativeModulePath,
} from '#worker/credentials/module-placeholder-scan.ts'
import { getSavedPackageByName } from '#worker/package-registry/repo.ts'
import { loadPackageSourceBySourceId } from '#worker/package-registry/source.ts'
import {
	type AuthoredPackageJson,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'
import {
	collectBundlerResolvedSpecifiers,
	collectModuleImportNodes,
} from '#worker/package-runtime/import-specifiers.ts'
import { resolvePackageExportSourcePath } from '#worker/package-runtime/module-graph-workspace.ts'
import {
	packageSpecifierPrefix,
	parseKodyPackageSpecifier,
} from '#worker/package-runtime/package-import-resolution.ts'
import { collectModuleKodyCalls } from './codemods/0017-detect-package-app-visitor-authority.ts'
import { type PackageAppCapabilityHostFacts } from './types.ts'

/** Bounds one app's closure walk; anything past it counts as unresolved. */
const maxClosurePackages = 50

export type ClosurePackage = {
	id: string
	files: Record<string, string>
	manifest: AuthoredPackageJson
}

/**
 * Loads an imported package by registry name, as the app's owner would at
 * run time. Null when it does not resolve.
 */
export type ClosurePackageLoader = (
	packageName: string,
) => Promise<ClosurePackage | null>

function isPackageSpecifier(specifier: string) {
	return specifier.startsWith(packageSpecifierPrefix)
}

function countComputedImports(source: string) {
	try {
		return collectModuleImportNodes(source).dynamicImportExpressions.filter(
			(node) => node.literalSpecifier == null,
		).length
	} catch {
		return 1
	}
}

/**
 * Kody calls reachable from an app through the packages it imports: each
 * `kody:@scope/name/export` is followed from that export's entry module along
 * relative imports, and into the packages those modules import. Only what an
 * import can reach counts, so an app never gains a capability a helper merely
 * contains.
 */
export async function scanPackageAppImportClosure(input: {
	appPackageId: string
	appFiles: Record<string, string>
	loadPackage: ClosurePackageLoader
}): Promise<PackageAppCapabilityHostFacts['closure']> {
	const names = new Set<string>()
	let computedCalls = 0
	let mcpCalls = 0
	let unresolvedImports = 0
	const loaded = new Map<string, ClosurePackage | null>()
	const visitedModules = new Set<string>()
	const pendingImports: Array<string> = []

	const queueImportsFrom = (source: string) => {
		const specifiers = collectBundlerResolvedSpecifiers(source)
		if (specifiers == null) {
			unresolvedImports += 1
			return []
		}
		unresolvedImports += countComputedImports(source)
		const relative: Array<string> = []
		for (const specifier of specifiers) {
			if (isPackageSpecifier(specifier)) pendingImports.push(specifier)
			else relative.push(specifier)
		}
		return relative
	}

	for (const path of listScannableModulePaths(input.appFiles)) {
		queueImportsFrom(input.appFiles[path]!)
	}

	while (pendingImports.length > 0) {
		const specifier = pendingImports.pop()!
		let packageName: string
		let exportName: string
		try {
			;({ packageName, exportName } = parseKodyPackageSpecifier(specifier))
		} catch {
			unresolvedImports += 1
			continue
		}
		if (!loaded.has(packageName)) {
			if (loaded.size >= maxClosurePackages) {
				unresolvedImports += 1
				continue
			}
			loaded.set(packageName, await input.loadPackage(packageName))
		}
		const dependency = loaded.get(packageName) ?? null
		if (dependency == null) {
			unresolvedImports += 1
			continue
		}
		// An app importing itself is already covered by its own scan.
		if (dependency.id === input.appPackageId) continue
		let entry: string
		try {
			entry = resolvePackageExportSourcePath({
				files: dependency.files,
				manifest: dependency.manifest,
				exportName,
			})
		} catch {
			unresolvedImports += 1
			continue
		}
		const modulePaths = new Set(listScannableModulePaths(dependency.files))
		const queue = [entry]
		while (queue.length > 0) {
			const path = queue.pop()!
			const key = `${dependency.id}\u0000${path}`
			if (visitedModules.has(key)) continue
			visitedModules.add(key)
			const source = dependency.files[path]
			const parsed = source == null ? null : parseModule(source)
			if (source == null || !parsed) {
				unresolvedImports += 1
				continue
			}
			const calls = collectModuleKodyCalls(parsed)
			for (const name of calls.names) names.add(name)
			computedCalls += calls.computedCalls
			mcpCalls += calls.mcpCalls
			for (const relative of queueImportsFrom(source)) {
				const target = resolveRelativeModulePath(path, relative, modulePaths)
				if (target) queue.push(target)
			}
		}
	}

	return {
		names: [...names].sort(),
		computedCalls,
		mcpCalls,
		unresolvedImports,
	}
}

const observedCallNamesSql = `SELECT DISTINCT call_name FROM package_app_authority_rejections
	WHERE package_id = ? AND difference_kind = 'capability_not_declared'
	UNION
	SELECT DISTINCT capability_name AS call_name FROM package_app_capability_allowances
	WHERE package_id = ?`

/**
 * Undeclared calls the runtime saw this app make (rejected, or allowed for a
 * published version).
 * `credential:<name>` rows are `credential.named` refusals; no capability
 * entry covers those, so only their count is kept.
 */
export async function loadObservedUndeclaredCalls(
	db: D1Database,
	packageId: string,
): Promise<PackageAppCapabilityHostFacts['observed']> {
	const rows = await db
		.prepare(observedCallNamesSql)
		.bind(packageId, packageId)
		.all<{ call_name: string }>()
	const names = new Set<string>()
	let credentialNamedCalls = 0
	for (const row of rows.results ?? []) {
		const name = String(row.call_name)
		if (name.startsWith('credential:')) credentialNamedCalls += 1
		else names.add(name)
	}
	return { names: [...names].sort(), credentialNamedCalls }
}

async function loadPlatformCapabilityNames() {
	// Lazy: the MCP registry imports the admin codemod capabilities.
	const { getStaticRegistry } = await import('#mcp/capabilities/registry.ts')
	const registry = await getStaticRegistry()
	return Object.keys(registry.capabilityMap).sort()
}

/** Loads imported packages from `userId`'s saved, published packages. */
export function createSavedPackageClosureLoader(input: {
	env: Env
	baseUrl: string
	userId: string
}): ClosurePackageLoader {
	return async (packageName) => {
		const row = await getSavedPackageByName(input.env.APP_DB, {
			userId: input.userId,
			name: packageName,
		})
		if (!row) return null
		try {
			const source = await loadPackageSourceBySourceId({
				env: input.env,
				baseUrl: input.baseUrl,
				userId: row.userId,
				sourceId: row.sourceId,
			})
			if (source.source.published_commit == null) return null
			return { id: row.id, files: source.files, manifest: source.manifest }
		} catch {
			return null
		}
	}
}

export async function computePackageAppCapabilityHostFacts(input: {
	env: Env
	baseUrl: string
	savedPackage: SavedPackageRecord
	files: Record<string, string>
}): Promise<PackageAppCapabilityHostFacts> {
	const { env, baseUrl, savedPackage } = input
	const loadPackage = createSavedPackageClosureLoader({
		env,
		baseUrl,
		userId: savedPackage.userId,
	})
	const [closure, observed, platformCapabilityNames] = await Promise.all([
		scanPackageAppImportClosure({
			appPackageId: savedPackage.id,
			appFiles: input.files,
			loadPackage,
		}),
		loadObservedUndeclaredCalls(env.APP_DB, savedPackage.id),
		loadPlatformCapabilityNames(),
	])
	return { closure, observed, platformCapabilityNames }
}
