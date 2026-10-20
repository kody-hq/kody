import {
	loadPackageSourceBySourceId,
	type LoadedPackageSource,
} from '#worker/package-registry/source.ts'
import {
	normalizePackageWorkspacePath,
	parseAuthoredPackageJson,
	resolvePackageExportPath,
} from '#worker/package-registry/manifest.ts'
import {
	type AuthoredPackageJson,
	type SavedPackageRecord,
} from '#worker/package-registry/types.ts'
import {
	buildPlainRepoPromotionErrorMessage,
	findPlainRepoPromotionHint,
} from '#worker/repo/user-repos.ts'
import {
	parseKodyPackageSpecifier,
	packageSpecifierPrefix,
	resolveSavedPackageImport,
	SavedPackageNotFoundError,
} from './package-import-resolution.ts'
import {
	collectStaticKodyPackageImportsFromFiles,
	isTypeDeclarationFilePath,
} from './static-kody-imports.ts'
import {
	collectModuleImportNodesCached,
	type ModuleImportNodesCache,
} from './import-specifiers.ts'
import { type BundleArtifactDependency } from './published-runtime-artifacts.ts'
import {
	dirname,
	joinPath,
	packageManifestPath,
	rootSourcePrefix,
	wranglerConfigPaths,
	resolveWorkspaceSourceFilePath,
} from './module-graph-paths.ts'

export function resolvePackageExportSourcePath(input: {
	files: Record<string, string>
	manifest: AuthoredPackageJson
	exportName: string
}) {
	const exportPath = resolvePackageExportPath({
		manifest: input.manifest,
		exportName: input.exportName,
	})
	return (
		resolveWorkspaceSourceFilePath({
			files: input.files,
			path: exportPath,
		}) ?? exportPath
	)
}

export function readRootPackage(sourceFiles: Record<string, string>) {
	const packageJson = sourceFiles[packageManifestPath]
	if (!packageJson) return null
	try {
		return {
			manifest: parseAuthoredPackageJson({
				content: packageJson,
				mode: 'published',
			}),
			prefix: rootSourcePrefix,
		}
	} catch {
		return null
	}
}

export function isBundlerRootConfigPath(path: string) {
	return path === packageManifestPath || wranglerConfigPaths.includes(path)
}

export function isBundlerRootDependencyPath(path: string) {
	return path === 'node_modules' || path.startsWith('node_modules/')
}

function resolveLocalImportPath(input: {
	files: Record<string, string>
	fromPath: string
	specifier: string
}) {
	if (!input.specifier.startsWith('./') && !input.specifier.startsWith('../')) {
		return null
	}
	return resolveWorkspaceSourceFilePath({
		files: input.files,
		path: joinPath(dirname(input.fromPath), input.specifier),
	})
}

export function collectReachableSourceFilePaths(input: {
	files: Record<string, string>
	entryPoint: string
	rootPackage: {
		manifest: AuthoredPackageJson
		prefix: string
	} | null
	includeTypeOnly?: boolean
	/**
	 * Optional request-scoped AST cache so prepare can reuse the same parse
	 * when rewriting the same source files.
	 */
	importNodesCache?: ModuleImportNodesCache
}) {
	const reachable = new Set<string>()
	const stack = [
		resolveWorkspaceSourceFilePath({
			files: input.files,
			path: input.entryPoint,
		}) ?? normalizePackageWorkspacePath(input.entryPoint),
	]
	while (stack.length > 0) {
		const filePath = stack.pop()
		if (
			!filePath ||
			reachable.has(filePath) ||
			isTypeDeclarationFilePath(filePath)
		) {
			continue
		}
		const source = input.files[filePath]
		if (source == null) continue
		reachable.add(filePath)
		for (const node of collectModuleImportNodesCached(
			input.importNodesCache,
			source,
			{
				includeTypeOnly: input.includeTypeOnly,
			},
		).literalImports) {
			if (
				node.kind === 'static' &&
				node.specifier.startsWith(packageSpecifierPrefix)
			) {
				const parsed = parseKodyPackageSpecifier(node.specifier)
				if (parsed.packageName === input.rootPackage?.manifest.name) {
					const exportPath = resolvePackageExportPath({
						manifest: input.rootPackage.manifest,
						exportName: parsed.exportName,
					})
					stack.push(
						resolveWorkspaceSourceFilePath({
							files: input.files,
							path: exportPath,
						}) ?? exportPath,
					)
				}
				continue
			}
			const localPath = resolveLocalImportPath({
				files: input.files,
				fromPath: filePath,
				specifier: node.specifier,
			})
			if (localPath && !reachable.has(localPath)) {
				stack.push(localPath)
			}
		}
	}
	return reachable
}

type LoadedDependencyPackage = LoadedPackageSource & {
	row: SavedPackageRecord
	prefix: string
}

function createBundleArtifactDependency(input: {
	row: SavedPackageRecord
	sourceId: string
	publishedCommit: string
}): BundleArtifactDependency {
	return {
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		kodyId: input.row.kodyId,
		packageName: input.row.name,
		packageId: input.row.id,
	}
}

/**
 * Saved packages reached only through another saved package's static
 * `kody:@` imports, walked from each direct import's export entry over the
 * package sources `prepareKodyGraphFiles` already loaded. Their stamped
 * modules are inlined into this bundle, so they need the same host-side
 * provenance as direct imports. Only files reachable from the imported
 * export count, so a dependency's unrelated exports never widen the set.
 */
function collectTransitiveKodyDependencies(input: {
	directSpecifiers: Array<string>
	directPackageIds: ReadonlySet<string>
	rootPackageName: string | undefined
	loadedPackages: Map<string, LoadedDependencyPackage>
}): Array<BundleArtifactDependency> {
	const transitive = new Map<string, BundleArtifactDependency>()
	const visitedExports = new Set<string>()
	const pending: Array<{
		specifier: string
		importer: LoadedDependencyPackage | null
	}> = input.directSpecifiers.map((specifier) => ({
		specifier,
		importer: null,
	}))
	while (pending.length > 0) {
		const next = pending.pop()
		if (!next) continue
		const parsed = parseKodyPackageSpecifier(next.specifier)
		if (parsed.packageName === input.rootPackageName) continue
		const loaded = input.loadedPackages.get(parsed.packageName)
		if (!loaded) continue
		const exportEntryPoint = resolvePackageExportSourcePath({
			files: loaded.files,
			manifest: loaded.manifest,
			exportName: parsed.exportName,
		})
		const visitKey = `${loaded.row.id}\0${exportEntryPoint}`
		if (visitedExports.has(visitKey)) continue
		visitedExports.add(visitKey)
		const publishedCommit = loaded.source.published_commit
		if (
			next.importer &&
			publishedCommit &&
			!input.directPackageIds.has(loaded.row.id) &&
			!transitive.has(loaded.row.id)
		) {
			transitive.set(loaded.row.id, {
				...createBundleArtifactDependency({
					row: loaded.row,
					sourceId: loaded.source.id,
					publishedCommit,
				}),
				transitive: true,
			})
		}
		const reachable = collectReachableSourceFilePaths({
			files: loaded.files,
			entryPoint: exportEntryPoint,
			rootPackage: { manifest: loaded.manifest, prefix: '' },
		})
		const reachableFiles = Object.fromEntries(
			Object.entries(loaded.files).filter(([filePath]) =>
				reachable.has(filePath),
			),
		)
		for (const imported of collectStaticKodyPackageImportsFromFiles(
			reachableFiles,
		)) {
			if (imported.packageName === loaded.manifest.name) continue
			pending.push({ specifier: imported.specifier, importer: loaded })
		}
	}
	return [...transitive.values()]
}

/**
 * Bundle dependency metadata for one entry point: every saved package the
 * entry statically imports, plus packages those dependencies statically
 * import (marked `transitive`). Grants for `packageStorage()`, stamp-aligned
 * secret authority, and static-call metering derive from this list.
 */
export async function resolveKodyDependenciesForEntryPoint(input: {
	env: Env
	baseUrl: string
	userId: string
	sourceFiles: Record<string, string>
	entryPoint: string
	loadedPackages?: Map<string, LoadedDependencyPackage>
}) {
	const rootPackage = readRootPackage(input.sourceFiles)
	const entryPoint =
		resolveWorkspaceSourceFilePath({
			files: input.sourceFiles,
			path: input.entryPoint,
		}) ?? normalizePackageWorkspacePath(input.entryPoint)
	const reachable = collectReachableSourceFilePaths({
		files: input.sourceFiles,
		entryPoint,
		rootPackage,
	})
	const reachableFiles = Object.fromEntries(
		Object.entries(input.sourceFiles).filter(([filePath]) =>
			reachable.has(filePath),
		),
	)
	const importedPackages = new Map<string, string>()
	const importedSpecifiers = new Set<string>()
	for (const imported of collectStaticKodyPackageImportsFromFiles(
		reachableFiles,
	)) {
		if (imported.packageName === rootPackage?.manifest.name) continue
		importedPackages.set(imported.packageName, imported.specifier)
		importedSpecifiers.add(imported.specifier)
	}
	const sortedSpecifiers = [...importedPackages.values()].sort((left, right) =>
		left.localeCompare(right),
	)
	const dependencies = await Promise.all(
		sortedSpecifiers.map(async (specifier) => {
			const parsed = parseKodyPackageSpecifier(specifier)
			const cached = input.loadedPackages?.get(parsed.packageName)
			const resolution = cached
				? { row: cached.row }
				: await resolveSavedPackageImport({
						db: input.env.APP_DB,
						userId: input.userId,
						specifier: parsed,
					})
			if (!resolution) {
				const plainRepo = await findPlainRepoPromotionHint(input.env.APP_DB, {
					userId: input.userId,
					packageIdOrKodyId: parsed.packageName,
				})
				if (plainRepo) {
					throw new Error(
						buildPlainRepoPromotionErrorMessage(parsed.packageName),
					)
				}
				throw new SavedPackageNotFoundError(parsed.packageName)
			}
			const { row } = resolution
			const loaded =
				cached ??
				(await loadPackageSourceBySourceId({
					env: input.env,
					baseUrl: input.baseUrl,
					userId: input.userId,
					sourceId: row.sourceId,
				}))
			if (!loaded.source.published_commit) {
				throw new Error(
					`Saved package "${row.name}" source "${row.sourceId}" has no published commit.`,
				)
			}
			return createBundleArtifactDependency({
				row,
				sourceId: loaded.source.id,
				publishedCommit: loaded.source.published_commit,
			})
		}),
	)
	const transitiveDependencies = input.loadedPackages
		? collectTransitiveKodyDependencies({
				directSpecifiers: [...importedSpecifiers].sort((left, right) =>
					left.localeCompare(right),
				),
				directPackageIds: new Set(
					dependencies
						.map((dependency) => dependency.packageId)
						.filter((packageId): packageId is string => Boolean(packageId)),
				),
				rootPackageName: rootPackage?.manifest.name,
				loadedPackages: input.loadedPackages,
			})
		: []
	return [...dependencies, ...transitiveDependencies].sort(
		(left, right) =>
			left.kodyId.localeCompare(right.kodyId) ||
			left.sourceId.localeCompare(right.sourceId),
	)
}
