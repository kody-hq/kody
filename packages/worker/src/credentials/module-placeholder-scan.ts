/**
 * Reads credential placeholders and names out of package module source: the
 * placeholder shapes, an AST walk, and the string constants a name can be
 * built from.
 */
import { isInertExamplePlaceholder } from '#mcp/secrets/placeholders.ts'
import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
import { collectBundlerResolvedSpecifiers } from '#worker/package-runtime/import-specifiers.ts'

export const scannableModuleFilePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/
/**
 * Package tests are not runtime code: their fixtures name credentials the
 * package never resolves.
 */
export const testFilePattern =
	/(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?[jt]sx?$/

export type NameKind = 'secret' | 'integration'

const placeholderOpenerPattern =
	/\{\{(secret-basic:|secret:|secret\/|integration-token:)/g
/** Capture groups are the names; a vault ref (`kind: null`) names no slot. */
const completePlaceholderPatterns: Record<
	string,
	{ pattern: RegExp; kind: NameKind | null }
> = {
	'secret:': {
		pattern: /\{\{secret:([a-zA-Z0-9._-]+)(?:\|scope=[a-z]+)?\}\}/y,
		kind: 'secret',
	},
	'secret-basic:': {
		pattern:
			/\{\{secret-basic:username=([a-zA-Z0-9._-]+),password=([a-zA-Z0-9._-]+)(?:\|scope=[a-z]+)?\}\}/y,
		kind: 'secret',
	},
	'secret/': { pattern: /\{\{secret\/[a-zA-Z0-9._-]+:[^}]+\}\}/y, kind: null },
	'integration-token:': {
		pattern: /\{\{integration-token:([a-zA-Z0-9._-]+)\}\}/y,
		kind: 'integration',
	},
}
/**
 * Placeholder-shaped text that closes in the same string piece but names
 * nothing, such as help or redaction text (`{{secret:<name>}}`). The gateway
 * never substitutes it. `$`, quotes, and `+` stay out so the text fallback
 * still sees `${name}` and concatenation as computed. Complete tokens that
 * still hold `<...>` example markers or grammar metavariables only
 * (`{{secret/provider:ref}}`) are also inert (same rule as
 * {@link isInertExamplePlaceholder}).
 */
const prosePlaceholderPattern =
	/\{\{(?:secret-basic:|secret:|secret\/|integration-token:)[^}$'"`+]*\}\}/y

type Placeholder =
	| { kind: NameKind; names: Array<string> }
	| { kind: 'vault' }
	| { kind: 'computed'; nameKind: NameKind }

export function findPlaceholders(text: string) {
	const placeholders: Array<Placeholder> = []
	for (const match of text.matchAll(placeholderOpenerPattern)) {
		const opener = match[1]!
		const complete = completePlaceholderPatterns[opener]!
		complete.pattern.lastIndex = match.index
		const found = complete.pattern.exec(text)
		if (found) {
			if (isInertExamplePlaceholder(found[0]!)) continue
			placeholders.push(
				complete.kind
					? { kind: complete.kind, names: found.slice(1) }
					: { kind: 'vault' },
			)
			continue
		}
		prosePlaceholderPattern.lastIndex = match.index
		if (prosePlaceholderPattern.test(text)) continue
		placeholders.push({
			kind: 'computed',
			nameKind: opener === 'integration-token:' ? 'integration' : 'secret',
		})
	}
	return placeholders
}

export type PlaceholderMatchKind =
	| 'secret'
	| 'secret-basic'
	| 'integration-token'
	| 'vault'
	| 'computed'

const placeholderMatchKindByOpener: Record<
	string,
	Exclude<PlaceholderMatchKind, 'computed'>
> = {
	'secret:': 'secret',
	'secret-basic:': 'secret-basic',
	'secret/': 'vault',
	'integration-token:': 'integration-token',
}

export type PlaceholderMatch = {
	kind: PlaceholderMatchKind
	/** Names the placeholder reads; empty for vault and computed. */
	names: Array<string>
	/** Literal `|scope=` suffix, or null when it has none. */
	scope: string | null
	/** The literal provider id of a vault placeholder; null for other kinds. */
	provider: string | null
	start: number
	end: number
}

const vaultProviderPattern = /^\{\{secret\/([a-zA-Z0-9._-]+):/

/**
 * Every placeholder in `text` with its position. Prose that names nothing is
 * skipped; anything else that opens a placeholder but does not complete one
 * is `computed`.
 */
export function findPlaceholderMatches(text: string) {
	const matches: Array<PlaceholderMatch> = []
	for (const match of text.matchAll(placeholderOpenerPattern)) {
		const opener = match[1]!
		const complete = completePlaceholderPatterns[opener]!
		complete.pattern.lastIndex = match.index
		const found = complete.pattern.exec(text)
		if (found) {
			if (isInertExamplePlaceholder(found[0]!)) continue
			matches.push({
				kind: placeholderMatchKindByOpener[opener]!,
				names: complete.kind ? found.slice(1) : [],
				scope: /\|scope=([a-z]+)\}\}$/.exec(found[0])?.[1] ?? null,
				provider:
					opener === 'secret/'
						? (vaultProviderPattern.exec(found[0])?.[1] ?? null)
						: null,
				start: match.index,
				end: match.index + found[0].length,
			})
			continue
		}
		prosePlaceholderPattern.lastIndex = match.index
		if (prosePlaceholderPattern.test(text)) continue
		matches.push({
			kind: 'computed',
			names: [],
			scope: null,
			provider: null,
			start: match.index,
			end: match.index + opener.length + 2,
		})
	}
	return matches
}

export type AstNode = ModuleAstNode & {
	computed?: boolean
	name?: unknown
	value?: unknown
	object?: AstNode
	property?: AstNode
	callee?: AstNode
	arguments?: Array<AstNode>
	properties?: Array<AstNode>
	key?: AstNode
	id?: AstNode
	init?: AstNode
	expressions?: Array<AstNode>
	quasis?: Array<AstNode>
	source?: AstNode
	specifiers?: Array<AstNode>
	local?: AstNode
	imported?: AstNode
	exported?: AstNode
	expression?: AstNode
	left?: AstNode
	right?: AstNode
	operator?: unknown
	declaration?: AstNode
	declarations?: Array<AstNode>
	params?: Array<AstNode>
	body?: AstNode | Array<AstNode>
	elements?: Array<AstNode | null | undefined>
	argument?: AstNode
	param?: AstNode
	parameter?: AstNode
	consequent?: Array<AstNode>
	kind?: unknown
	program?: { body?: Array<AstNode> }
}

export const transparentExpressionTypes = new Set([
	'ParenthesizedExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSNonNullExpression',
	'TSTypeAssertion',
])

export function unwrapExpression(node: AstNode | undefined) {
	let current = node
	while (current && transparentExpressionTypes.has(current.type)) {
		current = current.expression
	}
	return current
}

export function templateElementText(node: AstNode) {
	const value = node.value as { cooked?: string | null; raw?: string }
	return value.cooked ?? value.raw ?? ''
}

/** The string an expression always evaluates to, or null when computed. */
export function resolveStringExpression(
	node: AstNode | undefined,
	constants: ReadonlyMap<string, string>,
): string | null {
	const inner = unwrapExpression(node)
	switch (inner?.type) {
		case 'StringLiteral':
			return typeof inner.value === 'string' ? inner.value : null
		case 'Identifier':
			return constants.get(getNodeName(inner) ?? '') ?? null
		case 'TemplateLiteral': {
			const quasis = inner.quasis ?? []
			const expressions = inner.expressions ?? []
			let text = ''
			for (const [index, quasi] of quasis.entries()) {
				text += templateElementText(quasi)
				if (index >= expressions.length) continue
				const value = resolveStringExpression(expressions[index], constants)
				if (value == null) return null
				text += value
			}
			return text
		}
		case 'BinaryExpression': {
			if (inner.operator !== '+') return null
			const left = resolveStringExpression(inner.left, constants)
			if (left == null) return null
			const right = resolveStringExpression(inner.right, constants)
			return right == null ? null : left + right
		}
		default:
			return null
	}
}

/**
 * Names bound in an enclosing function, catch, loop, switch case, or block
 * that shadow a module-level constant for `node`'s ancestors.
 */
export function shadowedConstantNames(ancestors: ReadonlyArray<AstNode>) {
	const names = new Set<string>()
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const ancestor = ancestors[index]!
		if (ancestor.type === 'Program') break
		if (
			ancestor.type === 'FunctionDeclaration' ||
			ancestor.type === 'FunctionExpression' ||
			ancestor.type === 'ArrowFunctionExpression' ||
			ancestor.type === 'ClassMethod' ||
			ancestor.type === 'ClassPrivateMethod' ||
			ancestor.type === 'ObjectMethod'
		) {
			if (
				ancestor.type === 'FunctionDeclaration' ||
				ancestor.type === 'FunctionExpression'
			) {
				collectBoundNames(ancestor.id, names)
			}
			for (const param of ancestor.params ?? []) {
				collectBoundNames(param, names)
			}
		}
		if (ancestor.type === 'ClassExpression') {
			collectBoundNames(ancestor.id, names)
		}
		if (ancestor.type === 'CatchClause' && ancestor.param) {
			collectBoundNames(ancestor.param, names)
		}
		if (
			ancestor.type === 'ForOfStatement' ||
			ancestor.type === 'ForInStatement'
		) {
			collectLoopBindingNames(ancestor.left, names)
		}
		if (ancestor.type === 'ForStatement' && ancestor.init) {
			collectLoopBindingNames(ancestor.init, names)
		}
		if (ancestor.type === 'SwitchCase' && Array.isArray(ancestor.consequent)) {
			for (const statement of ancestor.consequent) {
				collectStatementBindingNames(statement, names)
			}
		}
		if (ancestor.type === 'BlockStatement' && Array.isArray(ancestor.body)) {
			for (const statement of ancestor.body) {
				collectStatementBindingNames(statement, names)
			}
		}
	}
	return names
}

function collectLoopBindingNames(
	binding: AstNode | null | undefined,
	names: Set<string>,
) {
	if (!binding) return
	if (binding.type === 'VariableDeclaration') {
		for (const declarator of binding.declarations ?? []) {
			collectBoundNames(declarator.id, names)
		}
		return
	}
	collectBoundNames(binding, names)
}

function collectStatementBindingNames(statement: AstNode, names: Set<string>) {
	if (statement.type === 'VariableDeclaration') {
		for (const declarator of statement.declarations ?? []) {
			collectBoundNames(declarator.id, names)
		}
		return
	}
	if (statement.type === 'FunctionDeclaration') {
		collectBoundNames(statement.id, names)
		return
	}
	if (statement.type === 'ClassDeclaration') {
		collectBoundNames(statement.id, names)
	}
}

function collectBoundNames(
	pattern: AstNode | null | undefined,
	names: Set<string>,
) {
	if (!pattern) return
	switch (pattern.type) {
		case 'Identifier': {
			const name = getNodeName(pattern)
			if (name) names.add(name)
			return
		}
		case 'AssignmentPattern':
			collectBoundNames(pattern.left, names)
			return
		case 'RestElement':
			collectBoundNames(pattern.argument, names)
			return
		case 'TSParameterProperty':
			collectBoundNames(pattern.parameter, names)
			return
		case 'ObjectPattern':
			for (const property of pattern.properties ?? []) {
				if (property.type === 'RestElement') {
					collectBoundNames(property.argument, names)
				} else if (property.type === 'ObjectProperty') {
					collectBoundNames(property.value as AstNode, names)
				}
			}
			return
		case 'ArrayPattern':
			for (const element of pattern.elements ?? []) {
				collectBoundNames(element, names)
			}
			return
		default:
			return
	}
}

/** Module constants with locally shadowed names removed. */
export function constantsWithoutShadows(
	constants: ReadonlyMap<string, string>,
	ancestors: ReadonlyArray<AstNode>,
) {
	const shadowed = shadowedConstantNames(ancestors)
	if (shadowed.size === 0) return constants
	const filtered = new Map<string, string>()
	for (const [name, value] of constants) {
		if (!shadowed.has(name)) filtered.set(name, value)
	}
	return filtered
}

/** `src/a.ts` + `../lib/names.js` → `lib/names.ts` when that file exists. */
export function resolveRelativeModulePath(
	importer: string,
	specifier: string,
	modulePaths: ReadonlySet<string>,
) {
	if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null
	const segments = importer.split('/').slice(0, -1)
	for (const part of specifier.split('/')) {
		if (part === '' || part === '.') continue
		if (part !== '..') segments.push(part)
		else if (segments.pop() === undefined) return null
	}
	const base = segments.join('/')
	const candidates = [
		base,
		base.replace(/\.([cm]?)js(x?)$/, '.$1ts$2'),
		...['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'].map(
			(suffix) => `${base}${suffix}`,
		),
	]
	return candidates.find((candidate) => modulePaths.has(candidate)) ?? null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function normalizePackageEntryPath(value: string) {
	return value.replace(/^\.\//, '')
}

/**
 * Runtime entry paths from the package manifest: the same roots published
 * artifact builds use (`exports` import/default, main/module/browser, app,
 * jobs, subscriptions). `types`-only export conditions are omitted.
 */
function collectManifestEntryPaths(manifestSource: string | undefined) {
	if (manifestSource == null) return [] as Array<string>
	let parsed: unknown
	try {
		parsed = JSON.parse(manifestSource)
	} catch {
		return []
	}
	if (!isPlainObject(parsed)) return []
	const entries: Array<string> = []
	const addPath = (value: unknown) => {
		if (typeof value === 'string' && value.length > 0) {
			entries.push(normalizePackageEntryPath(value))
		}
	}
	/** Condition maps and nested targets; skip type-only conditions. */
	const addRuntimeExportTarget = (target: unknown) => {
		if (typeof target === 'string') {
			addPath(target)
			return
		}
		if (!isPlainObject(target)) return
		for (const [condition, nested] of Object.entries(target)) {
			if (condition === 'types') continue
			addRuntimeExportTarget(nested)
		}
	}
	const isRootExportConditionMap = (exportsMap: Record<string, unknown>) => {
		const keys = Object.keys(exportsMap)
		return keys.length > 0 && keys.every((key) => !key.startsWith('.'))
	}
	if (typeof parsed.exports === 'string') {
		addPath(parsed.exports)
	} else if (isPlainObject(parsed.exports)) {
		if (isRootExportConditionMap(parsed.exports)) {
			addRuntimeExportTarget(parsed.exports)
		} else {
			for (const target of Object.values(parsed.exports)) {
				addRuntimeExportTarget(target)
			}
		}
	}
	addPath(parsed.main)
	addPath(parsed.module)
	addPath(parsed.browser)
	const kody = parsed.kody
	if (isPlainObject(kody)) {
		if (isPlainObject(kody.app)) {
			addPath(kody.app.entry)
			const client = kody.app.client
			if (typeof client === 'string') addPath(client)
			else if (isPlainObject(client)) addPath(client.entry)
		}
		if (isPlainObject(kody.jobs)) {
			for (const job of Object.values(kody.jobs)) {
				if (isPlainObject(job)) addPath(job.entry)
			}
		}
		if (isPlainObject(kody.subscriptions)) {
			for (const subscription of Object.values(kody.subscriptions)) {
				if (isPlainObject(subscription)) addPath(subscription.handler)
			}
		}
	}
	return entries
}

/**
 * Declared `kody.app.assets` directory from package.json, or null. Static
 * files under that directory are served as-is and are not package runtime
 * modules, so credential / stamp / eval AST walks skip them (multi-MB
 * prebuilt client bundles must not burn Durable Object CPU at publish).
 */
export function readPackageAppAssetsDirectory(
	manifestSource: string | undefined,
): string | null {
	if (manifestSource == null) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(manifestSource)
	} catch {
		return null
	}
	if (!isPlainObject(parsed) || !isPlainObject(parsed.kody)) return null
	if (!isPlainObject(parsed.kody.app)) return null
	const assets = parsed.kody.app.assets
	if (typeof assets !== 'string' || assets.trim().length === 0) return null
	const normalized = normalizePackageEntryPath(assets.trim()).replace(
		/\/+$/,
		'',
	)
	return normalized.length > 0 ? normalized : null
}

/** True when `path` is inside the declared assets directory. */
export function isPackageAppAssetPath(
	path: string,
	assetsDirectory: string | null,
) {
	if (assetsDirectory == null) return false
	return path === assetsDirectory || path.startsWith(`${assetsDirectory}/`)
}

/**
 * Modules the package can run: every scannable file except test-named ones
 * and unreferenced files under `kody.app.assets`, plus test-named or asset
 * files reachable from package.json runtime entries (including app, job, and
 * subscription handlers) via static or bundler-resolved imports.
 *
 * Static prebuilt client bundles under assets are skipped for CPU (they are
 * never imported). An asset that a server/runtime entry actually imports
 * stays scannable so credential stamps and server_eval still cover it.
 */
export function listScannableModulePaths(files: Record<string, string>) {
	const assetsDirectory = readPackageAppAssetsDirectory(
		files[packageManifestPath],
	)
	const modulePaths = Object.keys(files).filter(
		(path) =>
			typeof files[path] === 'string' && scannableModuleFilePattern.test(path),
	)
	const modulePathSet = new Set(modulePaths)
	const resolveEntry = (entry: string) => {
		if (modulePathSet.has(entry)) return entry
		return (
			resolveRelativeModulePath('package.json', `./${entry}`, modulePathSet) ??
			null
		)
	}
	const runtime = new Set<string>()
	const queue = collectManifestEntryPaths(files[packageManifestPath]).flatMap(
		(entry) => {
			const resolved = resolveEntry(entry)
			return resolved ? [resolved] : []
		},
	)
	while (queue.length > 0) {
		const path = queue.pop()!
		if (runtime.has(path)) continue
		runtime.add(path)
		const specifiers = collectBundlerResolvedSpecifiers(files[path]!)
		if (specifiers == null) continue
		for (const specifier of specifiers) {
			const target = resolveRelativeModulePath(path, specifier, modulePathSet)
			if (target) queue.push(target)
		}
	}
	return modulePaths.filter((path) => {
		if (runtime.has(path)) return true
		if (testFilePattern.test(path)) return false
		if (isPackageAppAssetPath(path, assetsDirectory)) return false
		return true
	})
}

const packageManifestPath = 'package.json'

type ModuleImport = {
	local: string
	imported: string
	target: string
}

/**
 * A top-level `const` string initializer with every AST node dropped, so a
 * module's constants can be resolved after its AST is released.
 */
type StringExpression =
	| { kind: 'literal'; value: string }
	| { kind: 'ref'; name: string }
	| { kind: 'concat'; parts: Array<StringExpression> }

type ModuleConstantStatement =
	| { kind: 'const'; name: string; value: StringExpression; exported: boolean }
	| { kind: 'export'; local: string; exported: string }

/** What constant resolution needs from one module, without its AST. */
export type ModuleConstantsSummary = {
	statements: Array<ModuleConstantStatement>
	imports: Array<ModuleImport>
}

/** Mirrors {@link resolveStringExpression}; null when it can never resolve. */
function toStringExpression(
	node: AstNode | undefined,
): StringExpression | null {
	const inner = unwrapExpression(node)
	switch (inner?.type) {
		case 'StringLiteral':
			return typeof inner.value === 'string'
				? { kind: 'literal', value: inner.value }
				: null
		case 'Identifier': {
			const name = getNodeName(inner)
			return name ? { kind: 'ref', name } : null
		}
		case 'TemplateLiteral': {
			const quasis = inner.quasis ?? []
			const expressions = inner.expressions ?? []
			const parts: Array<StringExpression> = []
			for (const [index, quasi] of quasis.entries()) {
				parts.push({ kind: 'literal', value: templateElementText(quasi) })
				if (index >= expressions.length) continue
				const part = toStringExpression(expressions[index])
				if (part == null) return null
				parts.push(part)
			}
			return { kind: 'concat', parts }
		}
		case 'BinaryExpression': {
			if (inner.operator !== '+') return null
			const left = toStringExpression(inner.left)
			if (left == null) return null
			const right = toStringExpression(inner.right)
			return right == null ? null : { kind: 'concat', parts: [left, right] }
		}
		default:
			return null
	}
}

function evaluateStringExpression(
	expression: StringExpression,
	constants: ReadonlyMap<string, string>,
): string | null {
	switch (expression.kind) {
		case 'literal':
			return expression.value
		case 'ref':
			return constants.get(expression.name) ?? null
		case 'concat': {
			let text = ''
			for (const part of expression.parts) {
				const value = evaluateStringExpression(part, constants)
				if (value == null) return null
				text += value
			}
			return text
		}
	}
}

export function readModuleConstantsSummary(
	path: string,
	parsed: AstNode | null | undefined,
	modulePaths: ReadonlySet<string>,
): ModuleConstantsSummary {
	const body = parsed?.program?.body ?? []
	const imports: Array<ModuleImport> = []
	const statements: Array<ModuleConstantStatement> = []
	for (const node of body) {
		if (node.type === 'ImportDeclaration') {
			const source = getNodeName(node.source)
			const target = source
				? resolveRelativeModulePath(path, source, modulePaths)
				: null
			if (!target) continue
			for (const specifier of node.specifiers ?? []) {
				if (specifier.type !== 'ImportSpecifier') continue
				const imported = getNodeName(specifier.imported)
				const local = getNodeName(specifier.local)
				if (imported && local) imports.push({ local, imported, target })
			}
			continue
		}
		const declaration =
			node.type === 'ExportNamedDeclaration' ? node.declaration : node
		if (
			declaration?.type === 'VariableDeclaration' &&
			declaration.kind === 'const'
		) {
			for (const declarator of declaration.declarations ?? []) {
				if (declarator.id?.type !== 'Identifier') continue
				const name = getNodeName(declarator.id)
				const value = toStringExpression(declarator.init)
				if (!name || value == null) continue
				statements.push({
					kind: 'const',
					name,
					value,
					exported: declaration !== node,
				})
			}
		}
		if (node.type === 'ExportNamedDeclaration' && !node.source) {
			for (const specifier of node.specifiers ?? []) {
				const local = getNodeName(specifier.local)
				const exported = getNodeName(specifier.exported)
				if (local && exported) {
					statements.push({ kind: 'export', local, exported })
				}
			}
		}
	}
	return { statements, imports }
}

function resolveModuleBindings(
	summary: ModuleConstantsSummary,
	importedConstants: ReadonlyMap<string, string>,
) {
	const constants = new Map(importedConstants)
	const exportedNames = new Map<string, string>()
	for (const statement of summary.statements) {
		if (statement.kind === 'export') {
			exportedNames.set(statement.exported, statement.local)
			continue
		}
		const value = evaluateStringExpression(statement.value, constants)
		if (value == null) continue
		constants.set(statement.name, value)
		if (statement.exported) exportedNames.set(statement.name, statement.name)
	}
	const exported = new Map<string, string>()
	for (const [exportedName, local] of exportedNames) {
		const value = constants.get(local)
		if (value != null) exported.set(exportedName, value)
	}
	return { constants, exported }
}

/**
 * Top-level `const NAME = <string>` bindings of each module, plus names
 * imported from relative modules that export one. Import cycles iterate to a
 * fixed point so order does not change the result. Inner scopes that shadow a
 * constant are filtered at each use via {@link constantsWithoutShadows}.
 */
export function createModuleConstantsReader(
	summaries: ReadonlyMap<string, ModuleConstantsSummary>,
) {
	const constantsByPath = new Map<string, Map<string, string>>()
	const exportedByPath = new Map<string, Map<string, string>>()
	for (const [path, summary] of summaries) {
		const resolved = resolveModuleBindings(summary, new Map())
		constantsByPath.set(path, resolved.constants)
		exportedByPath.set(path, resolved.exported)
	}
	let changed = true
	while (changed) {
		changed = false
		for (const [path, summary] of summaries) {
			const importedConstants = new Map<string, string>()
			for (const { local, imported, target } of summary.imports) {
				const value = exportedByPath.get(target)?.get(imported)
				if (value != null) importedConstants.set(local, value)
			}
			const resolved = resolveModuleBindings(summary, importedConstants)
			const previousConstants = constantsByPath.get(path)!
			const previousExported = exportedByPath.get(path)!
			if (
				!mapsEqual(previousConstants, resolved.constants) ||
				!mapsEqual(previousExported, resolved.exported)
			) {
				changed = true
			}
			constantsByPath.set(path, resolved.constants)
			exportedByPath.set(path, resolved.exported)
		}
	}
	return (path: string) => constantsByPath.get(path) ?? new Map()
}

type ScannableModuleIndex = {
	sources: ReadonlyMap<string, string>
	modulePaths: ReadonlyArray<string>
	readConstants: (path: string) => ReadonlyMap<string, string>
}

const scannableModuleIndexes = new WeakMap<
	Record<string, string>,
	ScannableModuleIndex
>()

function indexStillMatches(
	index: ScannableModuleIndex,
	files: Record<string, string>,
) {
	if (Object.keys(files).length !== index.sources.size) return false
	for (const [path, source] of index.sources) {
		if (files[path] !== source) return false
	}
	return true
}

/**
 * The scannable module paths of `files` and their resolved constants. Builds
 * the constants from one parse per module, keeping only a small summary of
 * each, never the ASTs: a package with megabytes of source would otherwise
 * hold every AST at once and exceed the isolate memory limit. The result is
 * reused for the same unchanged file map, so the several credential scans of
 * one publish check parse each module for constants only once.
 */
export function scannableModuleIndex(
	files: Record<string, string>,
): ScannableModuleIndex {
	const cached = scannableModuleIndexes.get(files)
	if (cached && indexStillMatches(cached, files)) return cached
	const modulePaths = listScannableModulePaths(files)
	const modulePathSet = new Set(modulePaths)
	const summaries = new Map<string, ModuleConstantsSummary>()
	for (const path of modulePaths) {
		summaries.set(
			path,
			readModuleConstantsSummary(
				path,
				parseModule(files[path]!),
				modulePathSet,
			),
		)
	}
	const index: ScannableModuleIndex = {
		sources: new Map(Object.entries(files)),
		modulePaths,
		readConstants: createModuleConstantsReader(summaries),
	}
	scannableModuleIndexes.set(files, index)
	return index
}

/**
 * Visit every scannable module (in {@link listScannableModulePaths} order, or
 * sorted) with its AST, or null when it does not parse, and its resolved
 * module constants. Only one AST is alive at a time; keep only small results
 * from each visit, never the AST.
 */
export function forEachScannableModule(
	files: Record<string, string>,
	visit: (
		path: string,
		parsed: AstNode | null,
		constants: ReadonlyMap<string, string>,
	) => void,
	options: { sorted?: boolean } = {},
) {
	const index = scannableModuleIndex(files)
	const paths = options.sorted
		? [...index.modulePaths].sort()
		: index.modulePaths
	for (const path of paths) {
		visit(path, parseModule(files[path]!), index.readConstants(path))
	}
}

function mapsEqual(
	left: ReadonlyMap<string, string>,
	right: ReadonlyMap<string, string>,
) {
	if (left.size !== right.size) return false
	for (const [key, value] of left) {
		if (right.get(key) !== value) return false
	}
	return true
}

export function getNodeName(node: AstNode | null | undefined) {
	if (!node) return null
	if (typeof node.name === 'string') return node.name
	if (typeof node.value === 'string') return node.value
	return null
}

export function walkAst(
	node: AstNode,
	visit: (node: AstNode, ancestors: ReadonlyArray<AstNode>) => void,
	ancestors: Array<AstNode> = [],
) {
	visit(node, ancestors)
	ancestors.push(node)
	for (const [key, value] of Object.entries(node)) {
		if (
			key === 'loc' ||
			key === 'range' ||
			key === 'leadingComments' ||
			key === 'trailingComments' ||
			key === 'innerComments' ||
			key === 'comments'
		) {
			continue
		}
		if (Array.isArray(value)) {
			for (const child of value) {
				if (child && typeof child === 'object' && 'type' in child) {
					walkAst(child as AstNode, visit, ancestors)
				}
			}
			continue
		}
		if (value && typeof value === 'object' && 'type' in value) {
			walkAst(value as AstNode, visit, ancestors)
		}
	}
	ancestors.pop()
}

export function getCalleeName(callee: AstNode | undefined) {
	if (!callee) return null
	if (callee.type === 'Identifier') return getNodeName(callee)
	if (
		(callee.type === 'MemberExpression' ||
			callee.type === 'OptionalMemberExpression') &&
		callee.computed !== true
	) {
		return getNodeName(callee.property)
	}
	return null
}

export function getCalleeObjectName(callee: AstNode | undefined) {
	if (
		callee &&
		(callee.type === 'MemberExpression' ||
			callee.type === 'OptionalMemberExpression')
	) {
		return getNodeName(callee.object)
	}
	return null
}

export function parseModule(source: string) {
	try {
		return parseModuleSource(source) as unknown as AstNode
	} catch {
		return null
	}
}
