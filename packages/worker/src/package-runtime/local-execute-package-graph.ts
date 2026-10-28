import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { isRetryableD1LockError } from '#worker/d1-retry.ts'
import { loadLocalExecuteRuntimeSupport } from '#worker/local-execute-runtime-support-load.ts'
import { signLocalExecutePackageBindings } from './local-execute-package-binding.ts'
import { packageSpecifierPrefix } from './package-import-resolution.ts'
import { collectDynamicImportExpressionNodes } from './import-specifiers.ts'
import { prepareKodyGraphFiles } from './module-graph-import-rewriting.ts'
import {
	createPackageProxyPathSegment,
	createRelativeImportSpecifier,
	joinPath,
	normalizeWorkspaceModulePath,
	packageImportProxyPrefix,
	packageRuntimeModulePrefix,
	packageSourcePrefix,
	resolveRelativeModulePath,
	rootSourcePrefix,
	runtimeModulePath,
} from './module-graph-paths.ts'
import { rewriteLocalExecuteModuleForSecretAwareFetch } from './rewrite-local-execute-secret-fetch.ts'
import {
	createPackageImportProxySource,
	createRuntimeModuleReexportSource,
	isKodyPublicRuntimeModulePath,
	isKodyRuntimeModulePath,
	parsePackageRuntimeModulePathPackageId,
} from './runtime-source-modules.ts'
import { publishedRuntimeBundleMissingMessage } from './published-source-dependencies.ts'
import { collectStaticKodyPackageImportsFromFiles } from './static-kody-imports.ts'

/** Host module name the CLI registers in local workerd (`localWorkerModuleNames.runtime`). */
export const localExecuteHostRuntimeModuleName = 'kody:runtime'

export type LocalExecutePackageModule = {
	name: string
	esModule: string
}

export type LocalExecutePackageGraph = {
	modules: Array<LocalExecutePackageModule>
	imports: Array<string>
	warnings: Array<string>
	/**
	 * Package id → signed local-execute binding (`kpb1.…`). Empty when the
	 * graph has no packages. CLI uses these to stamp CapabilityProxy calls
	 * without parsing shim source.
	 */
	packageBindings: Record<string, string>
	/**
	 * `kody:@…` specifier → package id for that export's package. Lets the CLI
	 * pick the binding for a local package run / facade rewrite.
	 */
	packageIdsByImport: Record<string, string>
}

export class LocalExecutePackageGraphError extends Error {
	readonly code:
		| 'package_import_unresolved'
		| 'package_import_unpublished'
		| 'unsupported_dynamic_package_import'

	constructor(
		code: LocalExecutePackageGraphError['code'],
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
		this.name = 'LocalExecutePackageGraphError'
		this.code = code
	}
}

/**
 * Tiny entry module for package-graph when the caller already knows the
 * `kody:@…` import list and does not want to POST a multi-megabyte bundle
 * (`kody dev` TanStack / React worker builds). Side-effect imports only —
 * enough for the static scanner and `prepareKodyGraphFiles`.
 */
export function synthesizeLocalExecutePackageGraphEntry(
	imports: ReadonlyArray<string>,
): string {
	const unique = uniqueSpecifiers(imports)
	if (unique.length === 0) {
		return 'export default async function main() {}\n'
	}
	const lines = unique.map((specifier) => `import ${JSON.stringify(specifier)}`)
	return `${lines.join('\n')}\nexport default async function main() {}\n`
}

/**
 * Resolve published, stamped `kody:@…` modules for CLI `execute --local`
 * embedding. Does not execute the user module and does not claim a dynamic
 * worker day — callers meter this as an Open API prep operation.
 */
export async function buildLocalExecutePackageGraph(input: {
	env: Env
	baseUrl: string
	userId: string
	/**
	 * Org actor the CLI authenticated as. Each package in the graph gets a
	 * binding signed for this org and actor; the shim sends that binding in
	 * place of the bare package id, so CapabilityProxy can tell which package
	 * a call comes from without trusting sandbox code.
	 */
	actorUserId: string | null
	code: string
}): Promise<LocalExecutePackageGraph> {
	assertNoLiteralDynamicSavedPackageImports(input.code)

	const sourceFiles = { 'entry.ts': input.code }
	const staticImports = uniqueSpecifiers(
		collectStaticKodyPackageImportsFromFiles(sourceFiles).map(
			(entry) => entry.specifier,
		),
	)

	const {
		rewriteInlinedLocalExecuteBundleSource,
		createLocalExecuteRuntimeShimSource,
		createLocalExecutePackageRuntimeModuleSource,
	} = await loadLocalExecuteRuntimeSupport()

	// Always embed the gateway-fetch runtime shim, even when the entry has no
	// `kody:@` imports. Ad-hoc scripts that call ambient `fetch` with
	// `{{secret:…}}` placeholders still need globalThis.fetch wrapped so the
	// hop expands on origin (or fails closed) instead of sending the raw
	// template to a third party (kody#3020).
	if (staticImports.length === 0) {
		return {
			modules: [
				{
					name: runtimeModulePath,
					esModule: createLocalExecuteRuntimeShimSource(runtimeModulePath),
				},
			],
			imports: [],
			warnings: [],
			packageBindings: {},
			packageIdsByImport: {},
		}
	}

	let prepared: Awaited<ReturnType<typeof prepareKodyGraphFiles>>
	try {
		prepared = await prepareKodyGraphFiles({
			env: input.env,
			baseUrl: input.baseUrl,
			userId: input.userId,
			sourceFiles,
			entryPoint: 'entry.ts',
		})
	} catch (error) {
		throw mapPrepareFailure(error, staticImports)
	}

	const modulesByName = new Map<string, string>()
	const runtimeModulePaths: Array<string> = []
	for (const [modulePath, source] of Object.entries(prepared.files)) {
		const normalized = normalizeWorkspaceModulePath(modulePath)
		if (shouldOmitPreparedModule(normalized)) continue
		if (isKodyRuntimeModulePath(normalized)) {
			runtimeModulePaths.push(normalized)
			continue
		}
		const packageRuntimeId = parsePackageRuntimeModulePathPackageId(normalized)
		modulesByName.set(
			normalized,
			packageRuntimeId != null
				? createLocalExecutePackageRuntimeModuleSource(packageRuntimeId)
				: source,
		)
	}

	// workerd path-joins bare `kody:runtime` from path-like module names
	// (`.__kody_virtual__/…`, `.__published_bundle__/…`). Put the CapabilityProxy
	// shim once at the primary runtime path with a relative import to the host
	// `kody:runtime` module; nested published-bundle copies re-export that root
	// (same shape as cloud stamp hydration).
	const primaryRuntimePath =
		pickLocalExecutePrimaryRuntimePath(runtimeModulePaths)
	for (const modulePath of runtimeModulePaths) {
		modulesByName.set(
			modulePath,
			modulePath === primaryRuntimePath
				? createLocalExecuteRuntimeShimSource(modulePath)
				: createRuntimeModuleReexportSource(modulePath, primaryRuntimePath),
		)
	}

	const packageIdsByPrefix = collectPackageIdsByModulePrefix(
		modulesByName.keys(),
	)
	const packageIdByModulePath = new Map<string, string>()
	const packageIdsByImport = new Map<string, string>()

	for (const specifier of staticImports) {
		const proxyPath = joinPath(
			packageImportProxyPrefix,
			`${createPackageProxyPathSegment(specifier)}.js`,
		)
		const proxySource = prepared.files[proxyPath]
		if (typeof proxySource !== 'string') {
			throw new LocalExecutePackageGraphError(
				'package_import_unresolved',
				`Could not resolve saved package import ${specifier} for local execute.`,
			)
		}
		const targetPath = readProxyTargetAbsolutePath(proxyPath, proxySource)
		if (targetPath == null || !targetPath.includes('/.__published_bundle__/')) {
			throw new LocalExecutePackageGraphError(
				'package_import_unpublished',
				`Saved package import ${specifier} has no published importable-module artifact for local execute. Publish the package export, then retry.`,
			)
		}
		if (!modulesByName.has(targetPath)) {
			throw new LocalExecutePackageGraphError(
				'package_import_unpublished',
				`Saved package import ${specifier} is missing its published artifact modules for local execute. Retry later or report it if it persists.`,
			)
		}
		const meteredPackageId = readMeteredProxyPackageId(proxySource)
		if (meteredPackageId) {
			const prefix = packagePrefixForPublishedModule(targetPath)
			if (prefix) packageIdsByPrefix.set(prefix, meteredPackageId)
			packageIdByModulePath.set(targetPath, meteredPackageId)
			packageIdsByImport.set(specifier, meteredPackageId)
		}
		// Alias the exact `kody:@…` specifier the CLI embeds next to user code.
		// Use an unmetered re-export so local workerd does not need cloud
		// static-call metering helpers from the shared runtime. Target must be
		// relative: workerd treats `.__kody_packages__/…` as a relative-path
		// reference from the alias module, not an exact module-name lookup.
		modulesByName.set(
			specifier,
			createPackageImportProxySource({
				targetPath: createRelativeImportSpecifier(specifier, targetPath),
			}),
		)
	}

	// Dropbox-style published bundles inline `.__kody_virtual__/runtime.js`.
	// Rewrite those preambles onto the CapabilityProxy shim so --local does
	// not depend on cloud's ALS preload (kody#2810 residual / inlined CAF).
	for (const [modulePath, source] of modulesByName.entries()) {
		if (isKodyRuntimeModulePath(modulePath)) continue
		if (parsePackageRuntimeModulePathPackageId(modulePath) != null) continue
		const rewritten = rewriteInlinedLocalExecuteBundleSource({
			modulePath,
			source,
			primaryRuntimePath,
		})
		if (rewritten.rewritten) {
			modulesByName.set(modulePath, rewritten.source)
			if (rewritten.packageId) {
				packageIdByModulePath.set(modulePath, rewritten.packageId)
				const prefix = packagePrefixForPublishedModule(modulePath)
				if (prefix) packageIdsByPrefix.set(prefix, rewritten.packageId)
			}
		}
	}

	// Fill packageIdsByImport from rewritten / prefix package ids when the
	// import proxy did not expose a metered package id.
	for (const specifier of staticImports) {
		if (packageIdsByImport.has(specifier)) continue
		const aliasSource = modulesByName.get(specifier)
		if (typeof aliasSource !== 'string') continue
		const targetPath = readProxyTargetAbsolutePath(specifier, aliasSource)
		if (!targetPath) continue
		const packageId =
			packageIdByModulePath.get(targetPath) ??
			packageIdForModulePath(targetPath, packageIdsByPrefix)
		if (packageId) packageIdsByImport.set(specifier, packageId)
	}

	// Secret-bearing ambient fetch: cloud expands placeholders at the fetch
	// gateway; local ambient fetch does not. Rebind published modules onto
	// CapabilityProxy gatewayFetch and rewrite quoted `{{secret:…}}` literals
	// to `__kodySecretRef(...)` so the resolvable template never leaves origin
	// via ambient workerd fetch (kody#2808).
	for (const [modulePath, source] of modulesByName.entries()) {
		if (!shouldRewritePublishedModuleForSecretAwareFetch(modulePath)) {
			continue
		}
		const packageId =
			packageIdByModulePath.get(modulePath) ??
			packageIdForModulePath(modulePath, packageIdsByPrefix)
		const rewritten = rewriteLocalExecuteModuleForSecretAwareFetch({
			modulePath,
			source,
			primaryRuntimePath,
			packageId,
		})
		if (rewritten.rewritten) {
			modulesByName.set(modulePath, rewritten.source)
		}
	}

	// Sign one binding per package this graph serves and embed them in the
	// primary shim (module-private, never exported). Nested runtime copies
	// re-export the primary, so they share its bindings.
	const graphPackageIds = new Set<string>([
		...packageIdsByPrefix.values(),
		...packageIdByModulePath.values(),
	])
	for (const modulePath of modulesByName.keys()) {
		const packageRuntimeId = parsePackageRuntimeModulePathPackageId(modulePath)
		if (packageRuntimeId) graphPackageIds.add(packageRuntimeId)
	}
	// Published bundles can inline other packages' facades; their ids come
	// from bundler provenance (loaded rows and recorded dependencies), never
	// from strings in module source.
	for (const loaded of prepared.packages.values()) {
		graphPackageIds.add(loaded.row.id)
	}
	for (const dependency of prepared.publishedArtifactDependencies) {
		if (dependency.packageId) graphPackageIds.add(dependency.packageId)
	}
	// The entry code is ad hoc, so its direct imports are the run's entries
	// (`credentialNeedsEntryPackageIds`); each binding carries them so
	// CapabilityProxy reads a dependency's mappings from its entry. Order them
	// like hosted bundle dependencies (kodyId, then sourceId) so first entry
	// wins picks the same entry in both.
	const entryRows = new Map(
		[...prepared.packages.values()].map((loaded) => [
			loaded.row.id,
			loaded.row,
		]),
	)
	const entryPackageIds = [
		...new Set(
			staticImports.flatMap((specifier) => {
				const packageId = packageIdsByImport.get(specifier)
				return packageId ? [packageId] : []
			}),
		),
	].sort((left, right) => {
		const a = entryRows.get(left)
		const b = entryRows.get(right)
		return (
			(a?.kodyId ?? left).localeCompare(b?.kodyId ?? right) ||
			(a?.sourceId ?? left).localeCompare(b?.sourceId ?? right)
		)
	})
	const packageBindings = await signLocalExecutePackageBindings({
		env: input.env,
		packageIds: graphPackageIds,
		subject: { org: input.userId, actor: input.actorUserId },
		entryPackageIds,
	})
	if (modulesByName.has(primaryRuntimePath) || packageBindings.size > 0) {
		modulesByName.set(
			primaryRuntimePath,
			createLocalExecuteRuntimeShimSource(primaryRuntimePath, {
				packageBindings: Object.fromEntries(packageBindings),
			}),
		)
	}

	const modules = [...modulesByName.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([name, esModule]) => ({ name, esModule }))

	return {
		modules,
		imports: staticImports,
		warnings: [],
		packageBindings: Object.fromEntries(packageBindings),
		packageIdsByImport: Object.fromEntries(
			[...packageIdsByImport.entries()].sort(([left], [right]) =>
				left.localeCompare(right),
			),
		),
	}
}

function assertNoLiteralDynamicSavedPackageImports(code: string) {
	for (const node of collectDynamicImportExpressionNodes(code)) {
		if (node.literalSpecifier?.startsWith(packageSpecifierPrefix)) {
			throw new LocalExecutePackageGraphError(
				'unsupported_dynamic_package_import',
				`Local execute cannot bind literal dynamic import(${JSON.stringify(node.literalSpecifier)}) yet — use a static import.`,
			)
		}
	}
}

function uniqueSpecifiers(specifiers: ReadonlyArray<string>) {
	return [...new Set(specifiers)].sort((left, right) =>
		left.localeCompare(right),
	)
}

function shouldOmitPreparedModule(modulePath: string) {
	if (modulePath === 'package.json') return true
	if (modulePath.startsWith(`${rootSourcePrefix}/`)) return true
	if (isKodyPublicRuntimeModulePath(modulePath)) return true
	// Cloud import proxies are replaced by `kody:@…` aliases in the response.
	if (modulePath.startsWith(`${packageImportProxyPrefix}/`)) return true
	if (isKodyRuntimeModulePath(modulePath)) return false
	if (parsePackageRuntimeModulePathPackageId(modulePath) != null) return false
	// Prefer published importable-module artifacts only — omit live package
	// source and npm dependency copies from a rebuild miss.
	if (modulePath.includes('/.__published_bundle__/')) return false
	if (modulePath.startsWith(`${packageSourcePrefix}/`)) return true
	if (modulePath.startsWith('.__kody_virtual__/')) return false
	return true
}

function shouldRewritePublishedModuleForSecretAwareFetch(modulePath: string) {
	if (isKodyRuntimeModulePath(modulePath)) return false
	if (parsePackageRuntimeModulePathPackageId(modulePath) != null) return false
	if (modulePath.startsWith(packageSpecifierPrefix)) return false
	return modulePath.includes('/.__published_bundle__/')
}

function collectPackageIdsByModulePrefix(modulePaths: Iterable<string>) {
	const packageIdsByPrefix = new Map<string, string>()
	const marker = `/${packageRuntimeModulePrefix}/`
	for (const modulePath of modulePaths) {
		const packageId = parsePackageRuntimeModulePathPackageId(modulePath)
		if (!packageId) continue
		const index = modulePath.lastIndexOf(marker)
		const prefix = index >= 0 ? modulePath.slice(0, index) : ''
		packageIdsByPrefix.set(prefix, packageId)
	}
	return packageIdsByPrefix
}

function packagePrefixForPublishedModule(modulePath: string) {
	const bundleIndex = modulePath.indexOf('/.__published_bundle__/')
	if (bundleIndex >= 0) return modulePath.slice(0, bundleIndex)
	const virtualIndex = modulePath.indexOf('/.__kody_virtual__/')
	if (virtualIndex >= 0 && modulePath.includes(`${packageSourcePrefix}/`)) {
		return modulePath.slice(0, virtualIndex)
	}
	return null
}

function packageIdForModulePath(
	modulePath: string,
	packageIdsByPrefix: ReadonlyMap<string, string>,
) {
	let bestPackageId: string | null = null
	let bestPrefixLength = -1
	for (const [prefix, packageId] of packageIdsByPrefix) {
		if (prefix.length === 0) {
			if (
				bestPrefixLength < 0 &&
				!modulePath.includes(`${packageSourcePrefix}/`) &&
				!modulePath.includes('.__kody_packages__/')
			) {
				bestPackageId = packageId
				bestPrefixLength = 0
			}
			continue
		}
		if (
			(modulePath === prefix || modulePath.startsWith(`${prefix}/`)) &&
			prefix.length > bestPrefixLength
		) {
			bestPackageId = packageId
			bestPrefixLength = prefix.length
		}
	}
	return bestPackageId
}

function readMeteredProxyPackageId(proxySource: string) {
	const match =
		/__kodyMeterStaticPackageExport\(\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.exec(
			proxySource,
		)
	if (!match?.[1]) return null
	try {
		return JSON.parse(
			match[1].startsWith("'")
				? `"${match[1].slice(1, -1).replaceAll('"', '\\"')}"`
				: match[1],
		) as string
	} catch {
		return null
	}
}

function readProxyTargetAbsolutePath(proxyPath: string, proxySource: string) {
	const match =
		/export\s*\*\s*from\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/.exec(
			proxySource,
		)
	if (!match?.[1]) return null
	let targetSpecifier: string
	try {
		targetSpecifier = JSON.parse(
			match[1].startsWith("'")
				? `"${match[1].slice(1, -1).replaceAll('"', '\\"')}"`
				: match[1],
		) as string
	} catch {
		return null
	}
	if (targetSpecifier.startsWith('./') || targetSpecifier.startsWith('../')) {
		return resolveRelativeModulePath(proxyPath, targetSpecifier)
	}
	return normalizeWorkspaceModulePath(targetSpecifier)
}

function mapPrepareFailure(
	error: unknown,
	imports: ReadonlyArray<string>,
): LocalExecutePackageGraphError {
	if (error instanceof LocalExecutePackageGraphError) return error
	// Scope/permission denials must surface as AuthorizationError →
	// Open API `insufficient_scope` (names `package:execute`), not as a
	// misleading "package was not found".
	if (error instanceof AuthorizationError) throw error
	// Transient D1 unavailability is not a resolution failure: let the API
	// layer report it as a retryable 503 instead of a 400 that blames the
	// caller's imports.
	if (isRetryableD1LockError(error)) throw error
	const message =
		error instanceof Error
			? error.message
			: 'Could not resolve package imports.'
	const importList = imports.join(', ')
	// Missing published runtime bundle: consumer cannot republish an upstream
	// package. Honest next step matches Open API internal_error copy.
	if (message.includes(publishedRuntimeBundleMissingMessage)) {
		return new LocalExecutePackageGraphError(
			'package_import_unpublished',
			`Saved package import(s) for local execute are missing a published runtime bundle (${importList}). Retry later or report it if it persists.`,
			{ cause: error },
		)
	}
	if (/not found/i.test(message) || /was not found/i.test(message)) {
		return new LocalExecutePackageGraphError(
			'package_import_unresolved',
			`Could not resolve saved package import(s) for local bundling (${importList}): ${message}`,
			{ cause: error },
		)
	}
	if (/sealed secret provider/i.test(message)) {
		return new LocalExecutePackageGraphError(
			'package_import_unresolved',
			message,
			{ cause: error },
		)
	}
	if (
		/unsupported kody package specifier/i.test(message) ||
		/nested dynamic import/i.test(message)
	) {
		return new LocalExecutePackageGraphError(
			'unsupported_dynamic_package_import',
			message,
			{ cause: error },
		)
	}
	return new LocalExecutePackageGraphError(
		'package_import_unresolved',
		`Could not resolve saved package import(s) for local bundling (${importList}): ${message}`,
		{ cause: error },
	)
}

/**
 * Local workerd supplies `kody:runtime` (CapabilityProxy bridge). Stamped
 * package moka published-bundle copies re-export one shim (and one relative hop to
 * host `kody:runtime`). Artifact-only graphs fall back to the shortest path.
 */
export function pickLocalExecutePrimaryRuntimePath(
	paths: ReadonlyArray<string>,
) {
	const normalized = [
		...new Set(paths.map((path) => normalizeWorkspaceModulePath(path))),
	]
	if (normalized.length === 0) return runtimeModulePath
	if (normalized.includes(runtimeModulePath)) return runtimeModulePath
	normalized.sort(
		(left, right) => left.length - right.length || left.localeCompare(right),
	)
	return normalized[0] ?? runtimeModulePath
}
