import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
import {
	resolveRelativeModulePath,
	resolveWorkspaceSourceFilePath,
} from './module-graph-paths.ts'

/**
 * Best-effort static discovery of a module's runtime export names, used by
 * the metered static-import proxy to know which named exports to wrap.
 * Missing a name is safe: the proxy keeps `export * from` as a passthrough,
 * so an undiscovered export remains available — it is just not metered. Because of
 * that, this collector prefers precision over completeness: type-only
 * exports are skipped and anything unparseable is simply omitted.
 */

const identifierNamePattern = /^[A-Za-z$_][A-Za-z0-9$_]*$/

function getModuleExportName(node: unknown): string | null {
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
			const name = getModuleExportName(typedNode)
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

function isRuntimeExportDeclaration(declaration: ModuleAstNode) {
	if ((declaration as { declare?: unknown }).declare === true) return false
	return (
		declaration.type !== 'TSInterfaceDeclaration' &&
		declaration.type !== 'TSTypeAliasDeclaration' &&
		declaration.type !== 'TSDeclareFunction'
	)
}

/**
 * Top-level names bound only as types (interfaces, type aliases, ambient
 * declarations, type imports). TypeScript erases local re-exports of them, so
 * `export { Shape as default }` of an interface is not a runtime export.
 */
function collectTypeOnlyLocalNames(body: Array<unknown>) {
	const typeNames = new Set<string>()
	const valueNames = new Set<string>()
	for (const statement of body) {
		if (!statement || typeof statement !== 'object') continue
		const node = statement as ModuleAstNode & {
			declaration?: ModuleAstNode | null
			specifiers?: Array<ModuleAstNode>
			importKind?: unknown
		}
		if (node.type === 'ImportDeclaration') {
			for (const specifier of node.specifiers ?? []) {
				const name = getModuleExportName(
					(specifier as { local?: unknown }).local,
				)
				if (!name) continue
				const isTypeImport =
					node.importKind === 'type' ||
					(specifier as { importKind?: unknown }).importKind === 'type'
				;(isTypeImport ? typeNames : valueNames).add(name)
			}
			continue
		}
		const declaration =
			node.type === 'ExportNamedDeclaration' ||
			node.type === 'ExportDefaultDeclaration'
				? node.declaration
				: node
		if (!declaration || typeof declaration !== 'object') continue
		const bindings = isRuntimeExportDeclaration(declaration)
			? valueNames
			: typeNames
		if (declaration.type === 'VariableDeclaration') {
			const declarators = (declaration as { declarations?: unknown })
				.declarations
			if (!Array.isArray(declarators)) continue
			for (const declarator of declarators) {
				collectPatternBoundNames((declarator as { id?: unknown })?.id, bindings)
			}
			continue
		}
		const declaredName = getModuleExportName(
			(declaration as { id?: unknown }).id,
		)
		if (declaredName) bindings.add(declaredName)
	}
	for (const name of valueNames) typeNames.delete(name)
	return typeNames
}

async function collectOwnExports(source: string): Promise<{
	names: Set<string>
	starSpecifiers: Array<string>
} | null> {
	let program: unknown
	try {
		program = await parseModuleSource(source)
	} catch {
		return null
	}
	const names = new Set<string>()
	const starSpecifiers: Array<string> = []
	const programNode = (program as { program?: { body?: unknown } }).program
	const body = programNode?.body
	if (!Array.isArray(body)) return { names, starSpecifiers }
	const typeOnlyLocalNames = collectTypeOnlyLocalNames(body)
	for (const statement of body) {
		if (!statement || typeof statement !== 'object') continue
		const typedStatement = statement as ModuleAstNode & {
			declaration?: ModuleAstNode
			specifiers?: Array<ModuleAstNode>
			source?: { value?: unknown }
			exportKind?: unknown
		}
		if (typedStatement.type === 'ExportAllDeclaration') {
			if (typedStatement.exportKind === 'type') continue
			// `export * as ns from ...` re-exports a single namespace binding,
			// not the target's names (Babel usually models it as an
			// ExportNamespaceSpecifier, but guard the ExportAllDeclaration
			// shape too).
			const namespaceName = getModuleExportName(
				(typedStatement as { exported?: unknown }).exported,
			)
			if (namespaceName) {
				names.add(namespaceName)
				continue
			}
			const starSource = typedStatement.source?.value
			if (typeof starSource === 'string') starSpecifiers.push(starSource)
			continue
		}
		if (typedStatement.type === 'ExportDefaultDeclaration') {
			const declaration = typedStatement.declaration
			if (!declaration || isRuntimeExportDeclaration(declaration)) {
				names.add('default')
			}
			continue
		}
		if (typedStatement.type !== 'ExportNamedDeclaration') continue
		if (typedStatement.exportKind === 'type') continue
		const declaration = typedStatement.declaration
		if (declaration && isRuntimeExportDeclaration(declaration)) {
			if (declaration.type === 'VariableDeclaration') {
				const declarators = (declaration as { declarations?: unknown })
					.declarations
				if (Array.isArray(declarators)) {
					for (const declarator of declarators) {
						collectPatternBoundNames(
							(declarator as { id?: unknown })?.id,
							names,
						)
					}
				}
			} else {
				const declaredName = getModuleExportName(
					(declaration as { id?: unknown }).id,
				)
				if (declaredName) names.add(declaredName)
			}
		}
		if (Array.isArray(typedStatement.specifiers)) {
			for (const specifier of typedStatement.specifiers) {
				if (!specifier || typeof specifier !== 'object') continue
				if ((specifier as { exportKind?: unknown }).exportKind === 'type') {
					continue
				}
				const localName = getModuleExportName(
					(specifier as { local?: unknown }).local,
				)
				if (
					!typedStatement.source &&
					localName &&
					typeOnlyLocalNames.has(localName)
				) {
					continue
				}
				const exportedName = getModuleExportName(
					(specifier as { exported?: unknown }).exported,
				)
				if (exportedName) names.add(exportedName)
			}
		}
	}
	return { names, starSpecifiers }
}

/**
 * Whether `source` declares its own runtime `default` export (`export *`
 * never forwards one). Returns `null` when the source does not parse so
 * callers can leave the verdict to the bundler.
 */
export async function moduleSourceDeclaresDefaultExport(
	source: string,
): Promise<boolean | null> {
	const collected = await collectOwnExports(source)
	return collected ? collected.names.has('default') : null
}

/**
 * Collects the runtime export names of `modulePath` within `files`, following
 * relative `export * from` chains that resolve inside the same file map.
 * Star re-exports that leave the map (bare npm specifiers, unresolved paths)
 * are ignored — their names remain reachable through the proxy's own
 * `export * from` passthrough. Returns names excluding `default` and any
 * name that is not a plain ASCII identifier (those also fall back to the
 * unmetered passthrough).
 */
export async function collectModuleExportNames(input: {
	files: Record<string, string>
	modulePath: string
}): Promise<Array<string>> {
	const names = new Set<string>()
	const visited = new Set<string>()
	const queue: Array<string> = [input.modulePath]
	while (queue.length > 0) {
		const modulePath = queue.shift()
		if (!modulePath || visited.has(modulePath)) continue
		visited.add(modulePath)
		const source = input.files[modulePath]
		if (typeof source !== 'string') continue
		const collected = await collectOwnExports(source)
		if (!collected) continue
		for (const name of collected.names) names.add(name)
		for (const starSpecifier of collected.starSpecifiers) {
			const resolvedPath = resolveRelativeModulePath(modulePath, starSpecifier)
			if (!resolvedPath) continue
			const resolvedFilePath = resolveWorkspaceSourceFilePath({
				files: input.files,
				path: resolvedPath,
			})
			if (resolvedFilePath) queue.push(resolvedFilePath)
		}
	}
	names.delete('default')
	// Codepoint sort keeps generated proxy content (and therefore bundle
	// cache digests) deterministic across ICU locale data.
	return [...names].filter((name) => identifierNamePattern.test(name)).sort()
}
