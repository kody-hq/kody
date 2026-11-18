import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
import {
	createRelativeImportSpecifier,
	normalizeWorkspaceModulePath,
} from './module-graph-path-basics.ts'

/**
 * Published importable-module artifacts sometimes esbuild-inline
 * `.__kody_virtual__/runtime.js` (and the per-package runtime facade) into the
 * bundle. Those inlined helpers capture
 * `AsyncLocalStorage.getStore()` at module evaluation time via
 * `__kodyOptionalRuntimeFunctionExport`. Cloud execute imports the bundle
 * inside `__kodyRunInRuntime`, so the store is populated; CLI `execute --local`
 * evaluates modules without that ALS entry, leaving `createAuthenticatedFetch`
 * (and siblings) as permanent `undefined`.
 *
 * Google-style artifacts keep an external `./.__kody_virtual__/runtime.js`
 * import and already work under --local via the CapabilityProxy shim. Dropbox-
 * style inlined artifacts need this rewrite: strip the inlined virtual runtime
 * / package-runtime sections and bind the same shim factories the
 * external-import path uses. Author modules (including `.__kody_root__/`
 * dependencies that appear before or after those sections) are preserved.
 */

const virtualRuntimeMarker = '// virtual:.__kody_virtual__/runtime.js'
const virtualPackageRuntimeMarker =
	'// virtual:.__kody_virtual__/package-runtime/'
const virtualBannerPattern = /^\/\/ virtual:[^\n]*/gm

const optionalCreateAuthenticatedFetchPattern =
	/__kodyOptionalRuntimeFunctionExport\(\s*["']createAuthenticatedFetch["']\s*\)/

export function moduleSourceHasInlinedKodyRuntime(source: string) {
	return (
		source.includes(virtualRuntimeMarker) ||
		optionalCreateAuthenticatedFetchPattern.test(source)
	)
}

/**
 * When `source` inlines the virtual runtime, replace those sections with
 * imports/bindings from the local-execute primary runtime shim. Returns the
 * original source when no rewrite is needed or the runtime sections cannot be
 * identified safely (CLI ALS install remains the fallback for those shapes).
 */
export async function rewriteInlinedLocalExecuteBundleSource(input: {
	modulePath: string
	source: string
	primaryRuntimePath: string
}): Promise<{ source: string; rewritten: boolean; packageId: string | null }> {
	if (!moduleSourceHasInlinedKodyRuntime(input.source)) {
		return { source: input.source, rewritten: false, packageId: null }
	}

	const sections = splitVirtualSections(input.source)
	const removable = sections.filter((section) =>
		isRemovableRuntimeSection(section.banner),
	)
	if (removable.length === 0) {
		return { source: input.source, rewritten: false, packageId: null }
	}

	const preambleSource = removable.map((section) => section.source).join('')
	const retained = sections
		.filter((section) => !isRemovableRuntimeSection(section.banner))
		.map((section) => section.source)
		.join('')
	const authorBindings = await collectTopLevelBindingNames(retained)
	if (authorBindings == null) {
		// Retained author source is not parseable as a module; refuse rather
		// than emit aliases that might collide with undetectable bindings.
		return { source: input.source, rewritten: false, packageId: null }
	}
	const packageBoundBindings = readPackageBoundBindings(preambleSource)
	const packageId =
		packageBoundBindings.findLast(
			(binding) => binding.kind === 'packageStorage',
		)?.packageId ??
		packageBoundBindings.at(-1)?.packageId ??
		null
	const bindingNames = readInlinedBindingNames(preambleSource)
	const removableInitNames = readRemovableEsmInitNames(preambleSource).filter(
		(name) => retained.includes(name),
	)
	const sharedRuntimeExportAliases = (() => {
		const sharedAliasByName = new Map<string, SharedRuntimeExportAlias>()
		for (const alias of [
			...readRemovableSharedRuntimeExportAliases(preambleSource),
			...readRetainedSharedRuntimeExportAliases(retained, authorBindings),
		]) {
			if (!retained.includes(alias.name) || authorBindings.has(alias.name)) {
				continue
			}
			if (!sharedAliasByName.has(alias.name)) {
				sharedAliasByName.set(alias.name, alias)
			}
		}
		return [...sharedAliasByName.values()]
	})()
	const relativeShim = createRelativeImportSpecifier(
		normalizeWorkspaceModulePath(input.modulePath),
		normalizeWorkspaceModulePath(input.primaryRuntimePath),
	)
	const preamble = createInlinedRuntimeReplacementPreamble({
		relativeShimSpecifier: relativeShim,
		packageId,
		packageBoundBindings,
		bindingNames,
		authorBindings,
		removableInitNames,
		sharedRuntimeExportAliases,
	})

	// Walk sections in order: keep author modules where they were, emit the
	// shim once at the first removed runtime/package-runtime section.
	const parts: Array<string> = []
	let emittedPreamble = false
	for (const section of sections) {
		if (isRemovableRuntimeSection(section.banner)) {
			if (!emittedPreamble) {
				parts.push(preamble)
				emittedPreamble = true
			}
			continue
		}
		parts.push(section.source)
	}
	if (!emittedPreamble) parts.unshift(preamble)
	return {
		source: parts.join('\n\n'),
		rewritten: true,
		packageId,
	}
}

type VirtualSection = {
	banner: string | null
	start: number
	end: number
	source: string
}

function splitVirtualSections(source: string): Array<VirtualSection> {
	const matches = [...source.matchAll(virtualBannerPattern)]
	if (matches.length === 0) {
		return [{ banner: null, start: 0, end: source.length, source }]
	}
	const sections: Array<VirtualSection> = []
	const firstIndex = matches[0]?.index ?? 0
	if (firstIndex > 0) {
		sections.push({
			banner: null,
			start: 0,
			end: firstIndex,
			source: source.slice(0, firstIndex),
		})
	}
	for (let i = 0; i < matches.length; i += 1) {
		const match = matches[i]
		if (!match) continue
		const start = match.index ?? 0
		const end = matches[i + 1]?.index ?? source.length
		sections.push({
			banner: match[0] ?? null,
			start,
			end,
			source: source.slice(start, end),
		})
	}
	return sections
}

function isRemovableRuntimeSection(banner: string | null) {
	if (!banner) return false
	return (
		banner === virtualRuntimeMarker ||
		banner.startsWith(virtualPackageRuntimeMarker)
	)
}

type PackageBoundBindingKind =
	| 'packageStorage'
	| 'packageSecrets'
	| 'createAuthenticatedFetch'
	| 'oauthClientCredentials'

type PackageBoundBinding = {
	kind: PackageBoundBindingKind
	name: string
	packageId: string
}

const packageBoundFactoryPatterns: ReadonlyArray<{
	kind: PackageBoundBindingKind
	rhs: RegExp
}> = [
	// Esbuild renames colliding inlined factories (`…Storage` → `…Storage2`).
	{ kind: 'packageStorage', rhs: /__kodyCreatePackageBoundStorage\d*\s*\(/ },
	{ kind: 'packageSecrets', rhs: /__kodyCreatePackageBoundSecrets\d*\s*\(/ },
	{
		kind: 'createAuthenticatedFetch',
		rhs: /__kodyCreatePackageBoundAuthenticatedFetch\d*\s*\(/,
	},
	{
		kind: 'oauthClientCredentials',
		rhs: /__kodyCreatePackageBoundOauthClientCredentials\d*\s*\(/,
	},
]

/**
 * Shared ALS / CapabilityProxy exports that the local shim re-provides under
 * their canonical names. Esbuild renames colliding inlined copies
 * (`packageContext` → `packageContext6`); retained author modules keep the
 * renamed identifier after the removable runtime sections are stripped.
 */
const sharedRuntimeExportCanonicals = [
	'kody',
	'secretHeaders',
	'packageContext',
	'email',
	'workflows',
	'packages',
	'events',
] as const

type SharedRuntimeExportCanonical =
	(typeof sharedRuntimeExportCanonicals)[number]

type SharedRuntimeExportAlias = {
	canonical: SharedRuntimeExportCanonical
	name: string
}

const sharedRuntimeExportFactoryPatterns: ReadonlyArray<{
	canonical: SharedRuntimeExportCanonical
	rhs: RegExp
}> = [
	{
		canonical: 'kody',
		rhs: /__kodyCreateRuntimeObjectProxy\d*\s*\(\s*["']kody["']/,
	},
	{
		canonical: 'secretHeaders',
		rhs: /__kodyOptionalRuntimeObjectExport\d*\s*\(\s*["']secretHeaders["']/,
	},
	{
		canonical: 'packageContext',
		rhs: /__kodyCreateRuntimeRecordExport\d*\s*\(\s*["']packageContext["']/,
	},
	{
		canonical: 'email',
		rhs: /__kodyOptionalRuntimeObjectExport\d*\s*\(\s*["']email["']/,
	},
	{
		canonical: 'workflows',
		rhs: /__kodyOptionalRuntimeObjectExport\d*\s*\(\s*["']workflows["']/,
	},
	{
		canonical: 'packages',
		rhs: /__kodyOptionalRuntimeObjectExport\d*\s*\(\s*["']packages["']/,
	},
	{
		canonical: 'events',
		rhs: /__kodyOptionalRuntimeObjectExport\d*\s*\(\s*["']events["']/,
	},
]

/**
 * Every package-stamped factory assignment in the removed preamble, in source
 * order. Multi-facade graphs bind dependency storage/secrets before the root;
 * each binding keeps the package ID from its own facade.
 *
 * Matches both Dropbox-style top-level `var name = factory("id")` and esbuild
 * `__esm` bodies that hoist `var name;` then assign inside the init callback.
 */
export function readPackageBoundBindings(
	preambleSource: string,
): Array<PackageBoundBinding> {
	const bindings: Array<PackageBoundBinding & { index: number }> = []
	for (const { kind, rhs } of packageBoundFactoryPatterns) {
		const pattern = new RegExp(
			`(?:(?:var|let|const)\\s+)?([A-Za-z_$][\\w$]*)\\s*=\\s*${rhs.source}\\s*["']([^"']+)["']`,
			'g',
		)
		for (const match of preambleSource.matchAll(pattern)) {
			const name = match[1]
			const packageId = match[2]
			if (!name || !packageId) continue
			bindings.push({ kind, name, packageId, index: match.index ?? 0 })
		}
	}
	bindings.sort((left, right) => left.index - right.index)
	return bindings.map(({ kind, name, packageId }) => ({
		kind,
		name,
		packageId,
	}))
}

/**
 * Renamed shared runtime exports declared in removable sections
 * (`packageContext6 = __kodyCreateRuntimeRecordExport("packageContext")`, a
 * hoisted `var packageContext6` — including multi-declarator lists — or any
 * other removable-text mention of the renamed binding). Retained author
 * modules keep those names; the replacement preamble must alias them to the
 * shim.
 */
export function readRemovableSharedRuntimeExportAliases(
	preambleSource: string,
): Array<SharedRuntimeExportAlias> {
	const aliases: Array<SharedRuntimeExportAlias & { index: number }> = []
	const seen = new Set<string>()
	const remember = (
		canonical: SharedRuntimeExportCanonical,
		name: string | undefined,
		index: number,
	) => {
		if (!name || name === canonical || seen.has(name)) return
		if (!name.startsWith(canonical)) return
		const suffix = name.slice(canonical.length)
		if (!/^\d+$/.test(suffix)) return
		seen.add(name)
		aliases.push({ canonical, name, index })
	}

	for (const { canonical, rhs } of sharedRuntimeExportFactoryPatterns) {
		const assignPattern = new RegExp(
			`(?:(?:var|let|const)\\s+)?([A-Za-z_$][\\w$]*)\\s*=\\s*${rhs.source}`,
			'g',
		)
		for (const match of preambleSource.matchAll(assignPattern)) {
			remember(canonical, match[1], match.index ?? 0)
		}
	}

	for (const canonical of sharedRuntimeExportCanonicals) {
		// Any mention in removable text, including multi-declarator lists
		// (`var packageStorage6, packageContext6`), facade fields, and
		// assignments left after inlining stripped the factory call.
		const anyPattern = new RegExp(`\\b(${canonical}\\d+)\\b`, 'g')
		for (const match of preambleSource.matchAll(anyPattern)) {
			remember(canonical, match[1], match.index ?? 0)
		}
	}

	aliases.sort((left, right) => left.index - right.index)
	return aliases.map(({ canonical, name }) => ({ canonical, name }))
}

/**
 * Retained author modules may still reference `packageContext6` after the
 * removable sections that declared it are stripped, even when the removable
 * text no longer contains that identifier (unusual inlining shapes). Collect
 * numbered shared-export names from retained source that are not already
 * top-level author bindings.
 *
 * Skip names that appear only as bare `typeof name` probes — those are
 * intentional unbound checks and must keep returning `"undefined"` rather
 * than gaining a shim binding.
 */
export function readRetainedSharedRuntimeExportAliases(
	retainedSource: string,
	authorBindings: ReadonlySet<string>,
): Array<SharedRuntimeExportAlias> {
	const aliases: Array<SharedRuntimeExportAlias & { index: number }> = []
	const seen = new Set<string>()
	for (const canonical of sharedRuntimeExportCanonicals) {
		const pattern = new RegExp(`\\b(${canonical}\\d+)\\b`, 'g')
		for (const match of retainedSource.matchAll(pattern)) {
			const name = match[1]
			const index = match.index ?? 0
			if (!name || seen.has(name) || authorBindings.has(name)) continue
			if (isOnlyBareTypeofProbe(retainedSource, name)) continue
			seen.add(name)
			aliases.push({ canonical, name, index })
		}
	}
	aliases.sort((left, right) => left.index - right.index)
	return aliases.map(({ canonical, name }) => ({ canonical, name }))
}

/**
 * `typeof undeclared` is defined to return `"undefined"`. Binding that name
 * to the shim would flip feature probes. `typeof name?.prop` still throws if
 * `name` is undeclared, so those uses still need an alias.
 */
function isOnlyBareTypeofProbe(source: string, name: string) {
	const pattern = new RegExp(`\\b${name}\\b`, 'g')
	const matches = [...source.matchAll(pattern)]
	if (matches.length === 0) return true
	return matches.every((match) => {
		const index = match.index ?? 0
		if (!isPrecededByTypeof(source, index)) return false
		const after = source.slice(index + name.length, index + name.length + 2)
		// Bare probe: typeof name / typeof name === … — not typeof name?.x
		return !/^[?.([]/.test(after)
	})
}

/** True when `source[index]` is immediately after `typeof` plus whitespace. */
function isPrecededByTypeof(source: string, index: number) {
	let cursor = index
	while (cursor > 0 && /\s/.test(source[cursor - 1] ?? '')) {
		cursor -= 1
	}
	const keyword = 'typeof'
	if (cursor < keyword.length) return false
	if (source.slice(cursor - keyword.length, cursor) !== keyword) return false
	const beforeKeyword = cursor - keyword.length - 1
	if (beforeKeyword >= 0 && /[A-Za-z0-9_$]/.test(source[beforeKeyword] ?? '')) {
		return false
	}
	return true
}

/**
 * `__esm` init helpers defined in removable runtime / package-runtime sections.
 * Retained author modules often call these (`init_storage` → `init_<pkg>()`);
 * stripping the section without re-emitting the init leaves
 * `ReferenceError: init_… is not defined` under local workerd after the
 * rewrite clears the SyntaxError path.
 */
export function readRemovableEsmInitNames(preambleSource: string) {
	const names: Array<string> = []
	const seen = new Set<string>()
	for (const match of preambleSource.matchAll(
		/(?:var|let|const)\s+(init_[A-Za-z0-9_$]+)\s*=\s*__esm\s*\(/g,
	)) {
		const name = match[1]
		if (!name || seen.has(name)) continue
		seen.add(name)
		names.push(name)
	}
	return names
}

function readAssignmentBindingName(preambleSource: string, rhsPattern: RegExp) {
	const match = new RegExp(
		`(?:(?:var|let|const)\\s+)?([A-Za-z_$][\\w$]*)\\s*=\\s*${rhsPattern.source}`,
	).exec(preambleSource)
	return match?.[1] ?? null
}

function readLastAssignmentBindingName(
	preambleSource: string,
	rhsPattern: RegExp,
) {
	const matches = [
		...preambleSource.matchAll(
			new RegExp(
				`(?:(?:var|let|const)\\s+)?([A-Za-z_$][\\w$]*)\\s*=\\s*${rhsPattern.source}`,
				'g',
			),
		),
	]
	return matches.at(-1)?.[1] ?? null
}

function lastBindingNameForKind(
	bindings: ReadonlyArray<PackageBoundBinding>,
	kind: PackageBoundBindingKind,
) {
	return bindings.findLast((binding) => binding.kind === kind)?.name ?? null
}

/**
 * Esbuild renames colliding inlined bindings (`packageStorage` →
 * `packageStorage2`). Author code after the cut references those renamed
 * identifiers, so the replacement preamble must reuse the same names.
 *
 * For multi-facade graphs, package-bound names come from
 * {@link readPackageBoundBindings} (last-of-kind for facades/aliases). This
 * helper still resolves optional-export CAF/oauth names and facade identifiers.
 */
export function readInlinedBindingNames(preambleSource: string) {
	const packageBoundBindings = readPackageBoundBindings(preambleSource)
	const packageStorage =
		lastBindingNameForKind(packageBoundBindings, 'packageStorage') ??
		'packageStorage'
	const packageSecrets =
		lastBindingNameForKind(packageBoundBindings, 'packageSecrets') ??
		'packageSecrets'
	const createAuthenticatedFetch =
		lastBindingNameForKind(packageBoundBindings, 'createAuthenticatedFetch') ??
		readAssignmentBindingName(
			preambleSource,
			/__kodyOptionalRuntimeFunctionExport\s*\(\s*["']createAuthenticatedFetch["']/,
		) ??
		'createAuthenticatedFetch'
	const oauthClientCredentials =
		lastBindingNameForKind(packageBoundBindings, 'oauthClientCredentials') ??
		readAssignmentBindingName(
			preambleSource,
			/__kodyOptionalRuntimeFunctionExport\s*\(\s*["']oauthClientCredentials["']/,
		) ??
		'oauthClientCredentials'
	const packageRuntimeDefault =
		readLastAssignmentBindingName(
			preambleSource,
			/new\s+Proxy\s*\(\s*runtime_default\s*,/,
		) ?? null
	// Prefer the package-runtime facade freeze (last match) over the shared
	// runtime `KodyRuntime = Object.freeze({ defaultValue: runtime_default })`.
	const kodyRuntime =
		readLastAssignmentBindingName(
			preambleSource,
			/Object\.freeze\s*\(\s*\{\s*defaultValue:\s*(?:__kodyPackageRuntimeDefault|[A-Za-z_$][\w$]*)/,
		) ?? null
	return {
		packageStorage,
		packageSecrets,
		createAuthenticatedFetch,
		oauthClientCredentials,
		packageRuntimeDefault,
		kodyRuntime,
	}
}

function getBindingIdentifierName(node: unknown): string | null {
	if (!node || typeof node !== 'object') return null
	const candidate = node as { name?: unknown; value?: unknown }
	if (typeof candidate.name === 'string') return candidate.name
	if (typeof candidate.value === 'string') return candidate.value
	return null
}

function collectPatternBoundNames(node: unknown, names: Set<string>) {
	if (!node || typeof node !== 'object') return
	const typedNode = node as ModuleAstNode
	switch (typedNode.type) {
		case 'Identifier': {
			const name = getBindingIdentifierName(typedNode)
			if (name) names.add(name)
			return
		}
		case 'ObjectPattern': {
			const properties = (typedNode as { properties?: unknown }).properties
			if (!Array.isArray(properties)) return
			for (const property of properties) {
				if (!property || typeof property !== 'object') continue
				const typedProperty = property as ModuleAstNode
				if (typedProperty.type === 'RestElement') {
					collectPatternBoundNames(
						(typedProperty as { argument?: unknown }).argument,
						names,
					)
					continue
				}
				collectPatternBoundNames(
					(typedProperty as { value?: unknown }).value,
					names,
				)
			}
			return
		}
		case 'ArrayPattern': {
			const elements = (typedNode as { elements?: unknown }).elements
			if (!Array.isArray(elements)) return
			for (const element of elements) {
				collectPatternBoundNames(element, names)
			}
			return
		}
		case 'AssignmentPattern': {
			collectPatternBoundNames((typedNode as { left?: unknown }).left, names)
			return
		}
		case 'RestElement': {
			collectPatternBoundNames(
				(typedNode as { argument?: unknown }).argument,
				names,
			)
			return
		}
		default:
			return
	}
}

/**
 * Top-level value bindings in retained author source. Returns `null` when the
 * source cannot be parsed (caller should refuse the rewrite).
 */
async function collectTopLevelBindingNames(
	source: string,
): Promise<Set<string> | null> {
	if (!source.trim()) return new Set()
	try {
		const parsed = (await parseModuleSource(source)) as unknown as ModuleAstNode
		const program = parsed.program as
			| { body?: Array<ModuleAstNode> }
			| undefined
		const body =
			program?.body ?? (parsed.body as Array<ModuleAstNode> | undefined)
		if (!Array.isArray(body)) return new Set()
		const names = new Set<string>()
		for (const statement of body) {
			if (!statement || typeof statement !== 'object') continue
			const node = statement as ModuleAstNode & {
				declaration?: ModuleAstNode | null
				specifiers?: Array<ModuleAstNode>
				id?: unknown
				declarations?: Array<{ id?: unknown }>
			}
			if (node.type === 'ImportDeclaration') {
				for (const specifier of node.specifiers ?? []) {
					const local = getBindingIdentifierName(
						(specifier as { local?: unknown }).local,
					)
					if (local) names.add(local)
				}
				continue
			}
			if (
				node.type === 'FunctionDeclaration' ||
				node.type === 'ClassDeclaration'
			) {
				const name = getBindingIdentifierName(node.id)
				if (name) names.add(name)
				continue
			}
			if (node.type === 'VariableDeclaration') {
				for (const declarator of node.declarations ?? []) {
					collectPatternBoundNames(declarator.id, names)
				}
				continue
			}
			if (node.type === 'ExportNamedDeclaration' && node.declaration) {
				const declaration = node.declaration
				if (
					declaration.type === 'FunctionDeclaration' ||
					declaration.type === 'ClassDeclaration'
				) {
					const name = getBindingIdentifierName(
						(declaration as { id?: unknown }).id,
					)
					if (name) names.add(name)
					continue
				}
				if (declaration.type === 'VariableDeclaration') {
					for (const declarator of (
						declaration as { declarations?: Array<{ id?: unknown }> }
					).declarations ?? []) {
						collectPatternBoundNames(declarator.id, names)
					}
				}
				continue
			}
			if (node.type === 'ExportDefaultDeclaration' && node.declaration) {
				const declaration = node.declaration
				if (
					declaration.type === 'FunctionDeclaration' ||
					declaration.type === 'ClassDeclaration'
				) {
					const name = getBindingIdentifierName(
						(declaration as { id?: unknown }).id,
					)
					if (name) names.add(name)
				}
			}
		}
		return names
	} catch {
		return null
	}
}

function emitCanonicalAlias(
	canonical: string,
	actual: string,
	authorBindings: ReadonlySet<string>,
) {
	if (actual === canonical) return ''
	// Author code may already bind the canonical name (e.g. a local helper
	// named `packageStorage`). Emitting `var packageStorage = packageStorage2`
	// would then SyntaxError or shadow incorrectly — skip the alias.
	if (authorBindings.has(canonical)) return ''
	return `var ${canonical} = ${actual};`
}

type ShimImportBinding =
	| string
	| {
			name: string
			as: string
	  }

/**
 * Named imports from the CapabilityProxy shim. Skip any local binding that
 * retained author source already declares — npm-backed published bundles often
 * keep `import { kody, … }` from nested package runtimes (esbuild aliases the
 * later ones to `kody2`), and a second `import { kody }` is a SyntaxError under
 * workerd. Hosted execute never injects this shim import.
 */
function collectShimImportSpecifiers(
	bindings: ReadonlyArray<ShimImportBinding>,
	authorBindings: ReadonlySet<string>,
) {
	const specifiers: Array<string> = []
	for (const binding of bindings) {
		if (typeof binding === 'string') {
			if (authorBindings.has(binding)) continue
			specifiers.push(binding)
			continue
		}
		if (authorBindings.has(binding.as)) continue
		specifiers.push(`${binding.name} as ${binding.as}`)
	}
	return specifiers
}

/**
 * Private local name for a shim import used only to feed renamed shared-export
 * aliases (`packageContext6 = __kodyShimPackageContext`). Avoids binding the
 * renamed export to a colliding author `packageContext` when the bare
 * canonical import is skipped.
 */
function pickCollisionFreeShimLocalName(
	canonical: SharedRuntimeExportCanonical,
	authorBindings: ReadonlySet<string>,
) {
	return pickCollisionFreeLocalName(
		`__kodyShim${canonical.charAt(0).toUpperCase()}${canonical.slice(1)}`,
		authorBindings,
	)
}

const shimPackageBoundFactoryNames = [
	'__kodyCreatePackageBoundAuthenticatedFetch',
	'__kodyCreatePackageBoundStorage',
	'__kodyCreatePackageBoundSecrets',
	'__kodyCreatePackageBoundOauthClientCredentials',
	'__kodyCreatePackageBoundGatewayFetch',
] as const

type ShimPackageBoundFactoryName = (typeof shimPackageBoundFactoryNames)[number]

/**
 * Local names for the shim's package-bound factories. Published artifacts
 * from before the shared runtime was externalized inline a cloud runtime copy
 * that declares `__kodyCreatePackageBoundStorage` (and siblings) at top level.
 * Composed into a later consumer, that copy is retained author source; the
 * replacement bindings must still reach the shim's CapabilityProxy factories,
 * so a colliding name is imported under a private alias instead of skipped.
 */
function pickShimPackageBoundFactoryLocals(
	authorBindings: ReadonlySet<string>,
) {
	return Object.fromEntries(
		shimPackageBoundFactoryNames.map((name) => [
			name,
			authorBindings.has(name)
				? pickCollisionFreeLocalName(
						`__kodyShim${name.slice('__kody'.length)}`,
						authorBindings,
					)
				: name,
		]),
	) as Record<ShimPackageBoundFactoryName, string>
}

function pickCollisionFreeLocalName(
	preferred: string,
	authorBindings: ReadonlySet<string>,
) {
	if (!authorBindings.has(preferred)) return preferred
	let suffix = 2
	while (authorBindings.has(`${preferred}${suffix}`)) suffix += 1
	return `${preferred}${suffix}`
}

function formatShimImportBlock(
	relativeShimSpecifier: string,
	specifiers: ReadonlyArray<string>,
) {
	if (specifiers.length === 0) return ''
	return `import {\n\t${specifiers.join(',\n\t')},\n} from ${JSON.stringify(
		relativeShimSpecifier,
	)};`
}

function createInlinedRuntimeReplacementPreamble(input: {
	relativeShimSpecifier: string
	packageId: string | null
	packageBoundBindings: ReadonlyArray<PackageBoundBinding>
	bindingNames: ReturnType<typeof readInlinedBindingNames>
	authorBindings: ReadonlySet<string>
	removableInitNames?: ReadonlyArray<string>
	sharedRuntimeExportAliases?: ReadonlyArray<SharedRuntimeExportAlias>
}) {
	const {
		packageStorage,
		packageSecrets,
		createAuthenticatedFetch,
		oauthClientCredentials,
		packageRuntimeDefault,
		kodyRuntime,
	} = input.bindingNames

	const facadeDefaultObject = `{
	createAuthenticatedFetch: ${createAuthenticatedFetch},
	oauthClientCredentials: ${oauthClientCredentials},
	packageStorage: ${packageStorage},
	packageSecrets: ${packageSecrets},
	secretHeaders,
	kody,
	packageContext,
	email,
	workflows,
	packages,
	events,
}`
	const facadeLines: Array<string> = []
	if (packageRuntimeDefault) {
		if (!input.authorBindings.has(packageRuntimeDefault)) {
			facadeLines.push(`var ${packageRuntimeDefault} = ${facadeDefaultObject};`)
		}
		if (
			packageRuntimeDefault !== '__kodyPackageRuntimeDefault' &&
			!input.authorBindings.has('__kodyPackageRuntimeDefault')
		) {
			facadeLines.push(
				`var __kodyPackageRuntimeDefault = ${packageRuntimeDefault};`,
			)
		}
	}
	if (kodyRuntime) {
		const defaultValueExpr = packageRuntimeDefault ?? facadeDefaultObject
		if (!input.authorBindings.has(kodyRuntime)) {
			facadeLines.push(
				`var ${kodyRuntime} = Object.freeze({ defaultValue: ${defaultValueExpr} });`,
			)
		}
		if (
			kodyRuntime !== 'KodyRuntime' &&
			!input.authorBindings.has('KodyRuntime')
		) {
			facadeLines.push(`var KodyRuntime = ${kodyRuntime};`)
		}
	}
	const initStubLines = (input.removableInitNames ?? [])
		.filter((name) => !input.authorBindings.has(name))
		.map(
			// Bindings are hoisted onto the shim factories above; retained
			// author `__esm` modules only need the init symbol to exist.
			(name) => `var ${name} = () => {};`,
		)
	const packageBoundEmittedNames = new Set(
		input.packageBoundBindings.map((binding) => binding.name),
	)
	const activeSharedAliases = (input.sharedRuntimeExportAliases ?? []).filter(
		(alias) =>
			!input.authorBindings.has(alias.name) &&
			!packageBoundEmittedNames.has(alias.name),
	)
	const sharedShimLocals = new Map<SharedRuntimeExportCanonical, string>()
	for (const alias of activeSharedAliases) {
		if (sharedShimLocals.has(alias.canonical)) continue
		sharedShimLocals.set(
			alias.canonical,
			pickCollisionFreeShimLocalName(alias.canonical, input.authorBindings),
		)
	}
	const sharedAliasBlock = activeSharedAliases
		.map((alias) => {
			const local = sharedShimLocals.get(alias.canonical)
			return local ? `var ${alias.name} = ${local};` : ''
		})
		.filter(Boolean)
		.join('\n')
	const sharedShimImportBindings: Array<ShimImportBinding> = [
		...sharedShimLocals.entries(),
	].map(([canonical, local]) =>
		local === canonical ? canonical : { name: canonical, as: local },
	)
	const facadeBlock = [...facadeLines, ...initStubLines]
		.filter(Boolean)
		.join('\n')

	if (input.packageId) {
		const packageIdLiteral = JSON.stringify(input.packageId)
		const factory = pickShimPackageBoundFactoryLocals(input.authorBindings)
		const packageBoundLines: Array<string> = []
		const emittedBindingNames = new Set<string>()
		for (const binding of input.packageBoundBindings) {
			if (emittedBindingNames.has(binding.name)) continue
			if (input.authorBindings.has(binding.name)) continue
			emittedBindingNames.add(binding.name)
			const idLiteral = JSON.stringify(binding.packageId)
			switch (binding.kind) {
				case 'packageStorage':
					packageBoundLines.push(
						`var ${binding.name} = ${factory.__kodyCreatePackageBoundStorage}(${idLiteral});`,
					)
					break
				case 'packageSecrets':
					packageBoundLines.push(
						`var ${binding.name} = ${factory.__kodyCreatePackageBoundSecrets}(${idLiteral});`,
					)
					break
				case 'createAuthenticatedFetch':
					packageBoundLines.push(
						`var ${binding.name} = ${factory.__kodyCreatePackageBoundAuthenticatedFetch}(${idLiteral});`,
					)
					break
				case 'oauthClientCredentials':
					packageBoundLines.push(
						`var ${binding.name} = ${factory.__kodyCreatePackageBoundOauthClientCredentials}(${idLiteral});`,
					)
					break
				default: {
					const _exhaustive: never = binding.kind
					throw new Error(`Unexpected package-bound kind: ${_exhaustive}`)
				}
			}
		}
		// Optional-export CAF/oauth (shared runtime) and any missing host
		// bindings stamp to the root package id so author entry code still
		// resolves them under --local.
		if (
			!emittedBindingNames.has(createAuthenticatedFetch) &&
			!input.authorBindings.has(createAuthenticatedFetch)
		) {
			packageBoundLines.push(
				`var ${createAuthenticatedFetch} = ${factory.__kodyCreatePackageBoundAuthenticatedFetch}(${packageIdLiteral});`,
			)
			emittedBindingNames.add(createAuthenticatedFetch)
		}
		if (
			!emittedBindingNames.has(packageStorage) &&
			!input.authorBindings.has(packageStorage)
		) {
			packageBoundLines.push(
				`var ${packageStorage} = ${factory.__kodyCreatePackageBoundStorage}(${packageIdLiteral});`,
			)
			emittedBindingNames.add(packageStorage)
		}
		if (
			!emittedBindingNames.has(packageSecrets) &&
			!input.authorBindings.has(packageSecrets)
		) {
			packageBoundLines.push(
				`var ${packageSecrets} = ${factory.__kodyCreatePackageBoundSecrets}(${packageIdLiteral});`,
			)
			emittedBindingNames.add(packageSecrets)
		}
		if (
			!emittedBindingNames.has(oauthClientCredentials) &&
			!input.authorBindings.has(oauthClientCredentials)
		) {
			packageBoundLines.push(
				`var ${oauthClientCredentials} = ${factory.__kodyCreatePackageBoundOauthClientCredentials}(${packageIdLiteral});`,
			)
			emittedBindingNames.add(oauthClientCredentials)
		}
		const aliases = [
			emitCanonicalAlias(
				'packageStorage',
				packageStorage,
				input.authorBindings,
			),
			emitCanonicalAlias(
				'packageSecrets',
				packageSecrets,
				input.authorBindings,
			),
			emitCanonicalAlias(
				'createAuthenticatedFetch',
				createAuthenticatedFetch,
				input.authorBindings,
			),
			emitCanonicalAlias(
				'oauthClientCredentials',
				oauthClientCredentials,
				input.authorBindings,
			),
		]
			.filter(Boolean)
			.join('\n')
		const emitFetchBinding = !input.authorBindings.has('fetch')
		const needsPackageBoundFactories = packageBoundLines.length > 0
		const shimImport = formatShimImportBlock(
			input.relativeShimSpecifier,
			collectShimImportSpecifiers(
				[
					'kody',
					'secretHeaders',
					'packageContext',
					'email',
					'workflows',
					'packages',
					'events',
					...sharedShimImportBindings,
					...(needsPackageBoundFactories || emitFetchBinding
						? (['__kodySecretRef'] as const)
						: []),
					...shimPackageBoundFactoryNames
						.filter((name) =>
							name === '__kodyCreatePackageBoundGatewayFetch'
								? emitFetchBinding
								: needsPackageBoundFactories,
						)
						.map((name): ShimImportBinding =>
							factory[name] === name ? name : { name, as: factory[name] },
						),
				],
				input.authorBindings,
			),
		)
		return `
${shimImport}

${packageBoundLines.join('\n')}
${
	emitFetchBinding
		? `var fetch = ${factory.__kodyCreatePackageBoundGatewayFetch}(${packageIdLiteral});`
		: ''
}
${aliases}
${sharedAliasBlock}
${facadeBlock}
`.trim()
	}

	// Unstamped inlined runtime (rare): import shim helpers under stable local
	// aliases, then expose whatever esbuild names the author body still uses.
	// Nested npm-backed graphs often already import `kody` / CAF from an
	// external package runtime — do not redeclare those locals.
	const bindCreateAuthenticatedFetch = !input.authorBindings.has(
		createAuthenticatedFetch,
	)
	const bindOauthClientCredentials = !input.authorBindings.has(
		oauthClientCredentials,
	)
	const bindPackageStorage = !input.authorBindings.has(packageStorage)
	const bindPackageSecrets = !input.authorBindings.has(packageSecrets)
	const shimImport = formatShimImportBlock(
		input.relativeShimSpecifier,
		collectShimImportSpecifiers(
			[
				'kody',
				...(bindCreateAuthenticatedFetch
					? [
							{
								name: 'createAuthenticatedFetch',
								as: '__kodyShimCreateAuthenticatedFetch',
							},
						]
					: []),
				'secretHeaders',
				...(bindOauthClientCredentials
					? [
							{
								name: 'oauthClientCredentials',
								as: '__kodyShimOauthClientCredentials',
							},
						]
					: []),
				'packageContext',
				...(bindPackageStorage
					? [{ name: 'packageStorage', as: '__kodyShimPackageStorage' }]
					: []),
				...(bindPackageSecrets
					? [{ name: 'packageSecrets', as: '__kodyShimPackageSecrets' }]
					: []),
				'email',
				'workflows',
				'packages',
				'events',
				...sharedShimImportBindings,
			],
			input.authorBindings,
		),
	)
	const assignmentLines = [
		bindCreateAuthenticatedFetch
			? `var ${createAuthenticatedFetch} = __kodyShimCreateAuthenticatedFetch;`
			: '',
		bindOauthClientCredentials
			? `var ${oauthClientCredentials} = __kodyShimOauthClientCredentials;`
			: '',
		bindPackageStorage
			? `var ${packageStorage} = __kodyShimPackageStorage;`
			: '',
		bindPackageSecrets
			? `var ${packageSecrets} = __kodyShimPackageSecrets;`
			: '',
		emitCanonicalAlias(
			'createAuthenticatedFetch',
			createAuthenticatedFetch,
			input.authorBindings,
		),
		emitCanonicalAlias(
			'oauthClientCredentials',
			oauthClientCredentials,
			input.authorBindings,
		),
		emitCanonicalAlias('packageStorage', packageStorage, input.authorBindings),
		emitCanonicalAlias('packageSecrets', packageSecrets, input.authorBindings),
		sharedAliasBlock,
	]
		.filter(Boolean)
		.join('\n')
	return `
${shimImport}

${assignmentLines}
${facadeBlock}
`.trim()
}
