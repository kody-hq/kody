import {
	normalizePackageExportKey,
	normalizePackageWorkspacePath,
} from '#worker/package-registry/manifest.ts'
import { type WorkerLoaderModules } from '#worker/worker-loader-types.ts'
import {
	type BundleArtifactDependency,
	type BundleArtifactDynamicDependency,
	type BundleArtifactKind,
	type PublishedBundleArtifact,
	bundleArtifactVersion,
} from './published-runtime-artifacts.ts'
import {
	parseKodyPackageSpecifier,
	packageSpecifierPrefix,
} from './package-import-resolution.ts'
import {
	isNodeBuiltinBarePackageName,
	throwUnresolvedBarePackageImportsError,
} from './bare-package-import-declarations.ts'
import {
	collectLiteralImportSpecifiers,
	getBarePackageNameFromSpecifier,
	isBarePackageImportSpecifier,
} from './import-specifiers.ts'
import {
	createPackageSpecifierFromProxyPath,
	createRelativeImportSpecifier,
	dirname,
	dynamicPackageImportArtifactSegment,
	dynamicPackageImportResolvedMarker,
	dynamicPackageImportSpecifierExportName,
	encodePathKeyAsPath,
	joinPath,
} from './module-graph-paths.ts'
import {
	createDynamicPackageImportProxySource,
	iterateModuleSourceTexts,
	refreshKodyRuntimeModules,
} from './runtime-source-modules.ts'

export function includeDynamicDependenciesWhenPresent(
	modules: WorkerLoaderModules,
) {
	const dynamicDependencies = collectDynamicKodyDependenciesFromModules(modules)
	return dynamicDependencies.length > 0 ? { dynamicDependencies } : {}
}

function collectUnresolvedBareImports(modules: WorkerLoaderModules) {
	const unresolved = new Map<string, Set<string>>()
	for (const [modulePath, source] of iterateModuleSourceTexts(modules)) {
		for (const specifier of collectLiteralImportSpecifiers(source)) {
			if (!isBarePackageImportSpecifier(specifier)) continue
			// Match the pre-bundle check: unprefixed Node builtins stay external
			// under nodejs_compat (e.g. fflate's `import … from "module"`). Prefixed
			// `node:` imports are already excluded by isBarePackageImportSpecifier.
			const packageName = getBarePackageNameFromSpecifier(specifier)
			if (packageName && isNodeBuiltinBarePackageName(packageName)) continue
			let existing = unresolved.get(modulePath)
			if (!existing) {
				existing = new Set()
				unresolved.set(modulePath, existing)
			}
			existing.add(specifier)
		}
	}
	return [...unresolved.entries()].map(([modulePath, specifiers]) => ({
		modulePath,
		specifiers: [...specifiers].sort((left, right) =>
			left.localeCompare(right),
		),
	}))
}

export function assertBundleHasNoUnresolvedBareImports(input: {
	modules: WorkerLoaderModules
	bundleLabel: string
	resolutionHint?: string
	/**
	 * Package snapshot used to decide whether unresolved bare imports are a
	 * caller-fixable missing declaration (UserCodeError) or a declared dep
	 * that failed to install/resolve (platform Error). Omit only when the
	 * caller has no snapshot (tests asserting the message phrase alone).
	 */
	sourceFiles?: Record<string, string>
}) {
	const unresolved = collectUnresolvedBareImports(input.modules)
	if (unresolved.length === 0) return
	const details = unresolved
		.map(
			(entry) =>
				`${entry.modulePath}: ${entry.specifiers
					.map((specifier) => `"${specifier}"`)
					.join(', ')}`,
		)
		.join('; ')
	const message = `${input.bundleLabel} still contains unresolved bare package imports after bundling (${details}). ${input.resolutionHint ?? 'Declare supported runtime dependencies in package.json and ensure checks/publish can resolve them before execution.'}`
	const unresolvedSpecifiers = unresolved.flatMap((entry) => entry.specifiers)
	if (input.sourceFiles) {
		throwUnresolvedBarePackageImportsError({
			message,
			unresolvedSpecifiers,
			sourceFiles: input.sourceFiles,
		})
	}
	throw new Error(message)
}

function materializeArtifactModuleSource(input: {
	modulePath: string
	module: WorkerLoaderModules[string]
}): string {
	if (typeof input.module === 'string') {
		return input.module
	}
	if (typeof input.module.js === 'string') {
		return input.module.js
	}
	if (typeof input.module.cjs === 'string') {
		return input.module.cjs
	}
	if (typeof input.module.text === 'string') {
		return input.module.text
	}
	if (input.module.json !== undefined) {
		return JSON.stringify(input.module.json)
	}
	throw new Error(
		`Saved package published bundle module "${input.modulePath}" uses an unsupported artifact module shape for import composition.`,
	)
}

export function materializePublishedArtifactModules(input: {
	artifactPrefix: string
	modules: WorkerLoaderModules
}) {
	const materializedModules: Record<string, string> = {}
	for (const [modulePath, module] of Object.entries(input.modules)) {
		materializedModules[joinPath(input.artifactPrefix, modulePath)] =
			materializeArtifactModuleSource({
				modulePath,
				module,
			})
	}
	return refreshKodyRuntimeModules(materializedModules, {
		includeDefaultRuntimePath: false,
	}) as Record<string, string>
}

function isStandaloneDynamicPackageImportPlaceholder(source: string) {
	return source
		.trimStart()
		.startsWith(`export const ${dynamicPackageImportSpecifierExportName}`)
}

function readDynamicPackageImportSpecifier(input: {
	modulePath: string
	module: WorkerLoaderModules[string]
}) {
	const specifierFromProxyPath = createPackageSpecifierFromProxyPath(
		input.modulePath,
	)
	const source =
		typeof input.module === 'string'
			? input.module
			: typeof input.module.js === 'string'
				? input.module.js
				: typeof input.module.cjs === 'string'
					? input.module.cjs
					: typeof input.module.text === 'string'
						? input.module.text
						: ''
	if (!source.includes(dynamicPackageImportSpecifierExportName)) {
		if (source.includes(dynamicPackageImportResolvedMarker)) return null
		return specifierFromProxyPath
	}
	if (
		!specifierFromProxyPath &&
		!isStandaloneDynamicPackageImportPlaceholder(source)
	) {
		return null
	}
	const markerIndex = source.indexOf(dynamicPackageImportSpecifierExportName)
	const match = source.slice(markerIndex).match(/=\s*("(?:[^"\\]|\\.)*")/)
	const rawSpecifier = match?.[1]
	if (!rawSpecifier) return specifierFromProxyPath
	try {
		const specifier = JSON.parse(rawSpecifier) as unknown
		return typeof specifier === 'string' &&
			specifier.startsWith(packageSpecifierPrefix)
			? specifier
			: null
	} catch {
		return specifierFromProxyPath
	}
}

export function collectDynamicPackageImportsFromModules(
	modules: WorkerLoaderModules,
) {
	return Object.entries(modules)
		.map(([modulePath, module]) => ({
			modulePath,
			specifier: readDynamicPackageImportSpecifier({ modulePath, module }),
		}))
		.filter(
			(
				entry,
			): entry is {
				modulePath: string
				specifier: string
			} => entry.specifier != null,
		)
}

export function collectDynamicKodyDependenciesFromModules(
	modules: WorkerLoaderModules,
): Array<BundleArtifactDynamicDependency> {
	const dependencies = new Map<string, BundleArtifactDynamicDependency>()
	for (const { specifier } of collectDynamicPackageImportsFromModules(
		modules,
	)) {
		const parsed = parseKodyPackageSpecifier(specifier)
		dependencies.set(specifier, {
			specifier,
			packageName: parsed.packageName,
			exportName: normalizePackageExportKey(parsed.exportName),
		})
	}
	return [...dependencies.values()].sort(
		(left, right) =>
			left.packageName.localeCompare(right.packageName) ||
			left.exportName.localeCompare(right.exportName),
	)
}

export function installDynamicPackageArtifactModules(input: {
	modules: WorkerLoaderModules
	modulePath: string
	specifier: string
	artifact: PublishedBundleArtifact
}) {
	const artifactPrefix = joinPath(
		dirname(input.modulePath),
		dynamicPackageImportArtifactSegment,
		encodePathKeyAsPath(
			`${input.specifier}#${input.artifact.sourceId}#${input.artifact.publishedCommit}`,
		),
	)
	for (const [artifactModulePath, module] of Object.entries(
		materializePublishedArtifactModules({
			artifactPrefix,
			modules: input.artifact.modules,
		}),
	)) {
		input.modules[artifactModulePath] = module
	}
	input.modules[input.modulePath] = createDynamicPackageImportProxySource({
		targetPath: createRelativeImportSpecifier(
			input.modulePath,
			joinPath(artifactPrefix, input.artifact.mainModule),
		),
	})
	return joinPath(artifactPrefix, input.artifact.mainModule)
}

export function createDynamicPackageImportArtifactKey(input: {
	specifier: string
	artifact: PublishedBundleArtifact
}) {
	return `${input.specifier}:${input.artifact.sourceId}:${input.artifact.publishedCommit}`
}

export function createPublishedBundleArtifact(input: {
	kind: BundleArtifactKind
	artifactName?: string | null
	sourceId: string
	publishedCommit: string
	entryPoint: string
	mainModule: string
	modules: WorkerLoaderModules
	dependencies: Array<BundleArtifactDependency>
	dynamicDependencies?: Array<BundleArtifactDynamicDependency>
	packageContext?: {
		packageId: string
		kodyId: string
		sourceId: string
	} | null
}): PublishedBundleArtifact {
	return {
		version: bundleArtifactVersion,
		kind: input.kind,
		artifactName: input.artifactName?.trim() || null,
		sourceId: input.sourceId,
		publishedCommit: input.publishedCommit,
		entryPoint: normalizePackageWorkspacePath(input.entryPoint),
		mainModule: input.mainModule,
		modules: input.modules,
		dependencies: input.dependencies,
		dynamicDependencies: input.dynamicDependencies ?? [],
		packageContext: input.packageContext ?? null,
		createdAt: new Date().toISOString(),
	}
}
