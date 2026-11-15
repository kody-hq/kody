import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
import {
	createRelativeImportSpecifier,
	normalizeWorkspaceModulePath,
} from './module-graph-path-basics.ts'

/**
 * Local package-graph rewrite for secret-bearing ambient `fetch`.
 *
 * Cloud execute expands `{{secret:…}}` placeholders at the fetch gateway.
 * Local workerd ambient fetch does not. Package-graph therefore:
 * 1. Replaces whole-string secret placeholder literals with
 *    `__kodySecretRef(...)` (AST-scoped — never rewrites template text,
 *    comments, or regexes).
 * 2. Shadows free `fetch` with a CapabilityProxy `gatewayFetch` hop when the
 *    name is not already bound. The hop expands placeholders on origin and
 *    falls through to ambient fetch for non-secret requests.
 */

const secretPlaceholderExactPattern =
	/^\{\{secret:([a-zA-Z0-9._-]+)(?:\|scope=(session|package|user))?\}\}$/

const gatewayFetchBindingMarker = '__kodyCreatePackageBoundGatewayFetch'
const unboundGatewayFetchMarker = '__kodyGatewayFetch as fetch'
const secretRefMarker = '__kodySecretRef('
const meterStaticPackageExportName = '__kodyMeterStaticPackageExport'
const meterStaticPackageExportCallPattern =
	/\b__kodyMeterStaticPackageExport\s*\(/

export function moduleSourceHasSecretPlaceholderLiterals(source: string) {
	try {
		const literals = collectExactSecretPlaceholderStringLiterals(source)
		return literals.length > 0
	} catch {
		return secretPlaceholderExactPattern.test(source)
	}
}

/**
 * Replace whole-module string literals that are exactly
 * `{{secret:name}}` / `{{secret:name|scope=…}}` with `__kodySecretRef(...)`.
 * Template literal text, comments, and regexes are left alone.
 */
export function rewriteLocalExecuteSecretPlaceholderLiterals(source: string) {
	let literals: Array<SecretPlaceholderLiteral>
	try {
		literals = collectExactSecretPlaceholderStringLiterals(source)
	} catch {
		return { source, rewritten: false }
	}
	if (literals.length === 0) return { source, rewritten: false }

	let next = source
	for (const literal of [...literals].sort((a, b) => b.start - a.start)) {
		const replacement = `__kodySecretRef(${JSON.stringify(literal.name)}, ${
			literal.scope == null ? 'null' : JSON.stringify(literal.scope)
		})`
		next = `${next.slice(0, literal.start)}${replacement}${next.slice(literal.end)}`
	}
	return {
		source: next,
		rewritten: next !== source,
	}
}

export function moduleSourceHasLocalExecuteGatewayFetchBinding(source: string) {
	return (
		source.includes(gatewayFetchBindingMarker) ||
		source.includes(unboundGatewayFetchMarker)
	)
}

/**
 * Top-level bindings that would collide with an injected `fetch` name.
 * Returns null when the source cannot be parsed (caller skips injection).
 */
export function collectTopLevelFetchCollisionNames(
	source: string,
): Set<string> | null {
	if (!source.trim()) return new Set()
	try {
		const parsed = parseModuleSource(source) as unknown as ModuleAstNode
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
			}
		}
		return names
	} catch {
		return null
	}
}

/**
 * Shadow module-local `fetch` with a CapabilityProxy gateway hop when the
 * name is free. No-op when the hop is already present or `fetch` is already
 * bound (avoids duplicate-declaration SyntaxError under --local).
 */
const globalObjectNames = new Set(['globalThis', 'self'])

/**
 * Replace reads of `globalThis.fetch` / `self.fetch` with `replacement`, so
 * a package module that reaches fetch through the global object still uses
 * its own package-bound fetch. Writes (`globalThis.fetch = ...`) are left
 * alone. A global-object name is only rewritten when every use of that name
 * in the module is a plain member access, so a local binding or an alias of
 * the same name is never mistaken for the global object. Returns the source
 * unchanged when it does not parse.
 */
/** Cheap text check that runs before parsing. */
export function sourceMayReadFetchThroughGlobalObject(source: string) {
	return /\b(?:globalThis|self)\b/.test(source) && source.includes('fetch')
}

export function rewriteGlobalObjectFetchReads(
	source: string,
	replacement: string,
): string {
	if (!sourceMayReadFetchThroughGlobalObject(source)) return source
	let parsed: ModuleAstNode
	try {
		parsed = parseModuleSource(source) as unknown as ModuleAstNode
	} catch {
		return source
	}
	const unsafeNames = new Set<string>()
	const reads: Array<{ start: number; end: number; name: string }> = []
	walkAst(parsed, (node, parent) => {
		if (node.type !== 'Identifier') return
		const name = (node as { name?: unknown }).name
		if (typeof name !== 'string' || !globalObjectNames.has(name)) return
		const member = parent as
			| (ModuleAstNode & {
					object?: unknown
					property?: unknown
					computed?: boolean
			  })
			| undefined
		const isMember =
			member?.type === 'MemberExpression' ||
			member?.type === 'OptionalMemberExpression' ||
			member?.type === 'StaticMemberExpression' ||
			member?.type === 'ComputedMemberExpression'
		if (isMember && member.property === node && member.computed !== true) {
			return
		}
		if (
			parent &&
			(parent as { key?: unknown }).key === node &&
			(parent as { computed?: boolean }).computed !== true &&
			(parent as { shorthand?: boolean }).shorthand !== true
		) {
			return
		}
		if (!isMember || member.object !== node) {
			unsafeNames.add(name)
			return
		}
		const property = member.property as
			| { type?: string; name?: unknown; value?: unknown }
			| undefined
		const propertyName =
			member.computed === true
				? typeof property?.value === 'string'
					? property.value
					: null
				: typeof property?.name === 'string'
					? property.name
					: null
		if (propertyName !== 'fetch') return
		if (typeof member.start !== 'number' || typeof member.end !== 'number') {
			unsafeNames.add(name)
			return
		}
		reads.push({ start: member.start, end: member.end, name })
	})
	const writes = collectMemberWriteStarts(parsed)
	let next = source
	for (const read of reads.sort((a, b) => b.start - a.start)) {
		if (unsafeNames.has(read.name) || writes.has(read.start)) continue
		next = `${next.slice(0, read.start)}${replacement}${next.slice(read.end)}`
	}
	return next
}

/**
 * Starts of every node inside an assignment target: the left side of an
 * assignment (destructuring patterns included), the operand of `++`, `--`
 * and `delete`, and the target of a `for (x in/of ...)` loop. Covering the
 * whole target subtree also covers computed keys and defaults inside a
 * pattern; leaving those unrewritten is the safe direction.
 */
function collectMemberWriteStarts(parsed: ModuleAstNode) {
	const starts = new Set<number>()
	const addTarget = (target: unknown) => {
		walkAst(target, (inner) => {
			if (typeof inner.start === 'number') starts.add(inner.start)
		})
	}
	walkAst(parsed, (node) => {
		if (node.type === 'AssignmentExpression') {
			addTarget((node as { left?: unknown }).left)
		} else if (
			node.type === 'UpdateExpression' ||
			(node.type === 'UnaryExpression' &&
				(node as { operator?: unknown }).operator === 'delete')
		) {
			addTarget((node as { argument?: unknown }).argument)
		} else if (
			node.type === 'ForInStatement' ||
			node.type === 'ForOfStatement'
		) {
			addTarget((node as { left?: unknown }).left)
		}
	})
	return starts
}

export function injectLocalExecuteGatewayFetchBinding(input: {
	modulePath: string
	source: string
	primaryRuntimePath: string
	packageId: string | null
	/** Optional precomputed author bindings (inlined rewrite already has them). */
	authorBindings?: ReadonlySet<string> | null
}): { source: string; rewritten: boolean } {
	const needsSecretRef = input.source.includes(secretRefMarker)
	const hasFetchBinding = moduleSourceHasLocalExecuteGatewayFetchBinding(
		input.source,
	)
	const hasSecretRefImport = /\bimport\s*\{[^}]*\b__kodySecretRef\b/.test(
		input.source,
	)

	if (hasFetchBinding) {
		if (!needsSecretRef || hasSecretRefImport) {
			return { source: input.source, rewritten: false }
		}
		const relativeShim = createRelativeImportSpecifier(
			normalizeWorkspaceModulePath(input.modulePath),
			normalizeWorkspaceModulePath(input.primaryRuntimePath),
		)
		return {
			source: `import { __kodySecretRef } from ${JSON.stringify(relativeShim)};
${input.source}`,
			rewritten: true,
		}
	}

	const authorBindings =
		input.authorBindings === undefined
			? collectTopLevelFetchCollisionNames(input.source)
			: input.authorBindings
	if (authorBindings == null) {
		// Unparseable module — refuse to inject a colliding binding.
		if (!needsSecretRef || hasSecretRefImport) {
			return { source: input.source, rewritten: false }
		}
		const relativeShim = createRelativeImportSpecifier(
			normalizeWorkspaceModulePath(input.modulePath),
			normalizeWorkspaceModulePath(input.primaryRuntimePath),
		)
		return {
			source: `import { __kodySecretRef } from ${JSON.stringify(relativeShim)};
${input.source}`,
			rewritten: true,
		}
	}
	if (authorBindings.has('fetch')) {
		if (!needsSecretRef || hasSecretRefImport) {
			return { source: input.source, rewritten: false }
		}
		const relativeShim = createRelativeImportSpecifier(
			normalizeWorkspaceModulePath(input.modulePath),
			normalizeWorkspaceModulePath(input.primaryRuntimePath),
		)
		return {
			source: `import { __kodySecretRef } from ${JSON.stringify(relativeShim)};
${input.source}`,
			rewritten: true,
		}
	}

	const relativeShim = createRelativeImportSpecifier(
		normalizeWorkspaceModulePath(input.modulePath),
		normalizeWorkspaceModulePath(input.primaryRuntimePath),
	)
	const shimLiteral = JSON.stringify(relativeShim)
	const preamble = input.packageId
		? needsSecretRef
			? `import { __kodyCreatePackageBoundGatewayFetch, __kodySecretRef } from ${shimLiteral};
const fetch = __kodyCreatePackageBoundGatewayFetch(${JSON.stringify(input.packageId)});
`
			: `import { __kodyCreatePackageBoundGatewayFetch } from ${shimLiteral};
const fetch = __kodyCreatePackageBoundGatewayFetch(${JSON.stringify(input.packageId)});
`
		: needsSecretRef
			? `import { __kodyGatewayFetch as fetch, __kodySecretRef } from ${shimLiteral};
`
			: `import { __kodyGatewayFetch as fetch } from ${shimLiteral};
`
	return {
		source: `${preamble}${input.source}`,
		rewritten: true,
	}
}

/**
 * Cloud execute exposes `__kodyMeterStaticPackageExport` as a free binding via
 * the runtime preload. Published bundles therefore call it without an import
 * when they inline nested `kody:@…` callees. Local package-graph replaces the
 * virtual runtime with an ESM shim that only exports the helper — so inlined
 * free calls throw `… is not defined` under `--local` unless we import it.
 *
 * Prefer merging into an existing named import from the primary runtime shim
 * (secret-aware fetch / inlined-runtime rewrites often already added one).
 */
export function ensureLocalExecuteMeterStaticPackageExportImport(input: {
	modulePath: string
	source: string
	primaryRuntimePath: string
}): { source: string; rewritten: boolean } {
	if (!meterStaticPackageExportCallPattern.test(input.source)) {
		return { source: input.source, rewritten: false }
	}
	// Require a local binding named exactly `__kodyMeterStaticPackageExport`.
	// An aliased import (`… as meter`) does not bind the free call site.
	const localBindings = collectTopLevelFetchCollisionNames(input.source)
	if (localBindings?.has(meterStaticPackageExportName)) {
		return { source: input.source, rewritten: false }
	}

	const relativeShim = createRelativeImportSpecifier(
		normalizeWorkspaceModulePath(input.modulePath),
		normalizeWorkspaceModulePath(input.primaryRuntimePath),
	)
	const shimLiteral = JSON.stringify(relativeShim)
	const existingImport = new RegExp(
		`import\\s*\\{([^}]*)\\}\\s*from\\s*${escapeRegExp(shimLiteral)};?`,
	).exec(input.source)
	if (existingImport && typeof existingImport.index === 'number') {
		const names = existingImport[1] ?? ''
		const trimmedNames = names.trim()
		const nextNames = trimmedNames
			? `${meterStaticPackageExportName}, ${trimmedNames}`
			: meterStaticPackageExportName
		const replacement = `import { ${nextNames} } from ${shimLiteral};`
		const start = existingImport.index
		const end = start + existingImport[0].length
		return {
			source: `${input.source.slice(0, start)}${replacement}${input.source.slice(end)}`,
			rewritten: true,
		}
	}

	return {
		source: `import { ${meterStaticPackageExportName} } from ${shimLiteral};
${input.source}`,
		rewritten: true,
	}
}

/**
 * Apply placeholder literal rewrite + gateway fetch binding for one
 * published package module returned by package-graph.
 */
export function rewriteLocalExecuteModuleForSecretAwareFetch(input: {
	modulePath: string
	source: string
	primaryRuntimePath: string
	packageId: string | null
}): { source: string; rewritten: boolean } {
	const placeholders = rewriteLocalExecuteSecretPlaceholderLiterals(
		input.source,
	)
	const withFetch = injectLocalExecuteGatewayFetchBinding({
		modulePath: input.modulePath,
		source: placeholders.source,
		primaryRuntimePath: input.primaryRuntimePath,
		packageId: input.packageId,
	})
	const withMeter = ensureLocalExecuteMeterStaticPackageExportImport({
		modulePath: input.modulePath,
		source: withFetch.source,
		primaryRuntimePath: input.primaryRuntimePath,
	})
	return {
		source: withMeter.source,
		rewritten:
			placeholders.rewritten || withFetch.rewritten || withMeter.rewritten,
	}
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

type SecretPlaceholderLiteral = {
	start: number
	end: number
	name: string
	scope: 'session' | 'package' | 'user' | null
}

function collectExactSecretPlaceholderStringLiterals(source: string) {
	const parsed = parseModuleSource(source) as unknown as ModuleAstNode
	const literals: Array<SecretPlaceholderLiteral> = []
	walkAst(parsed, (node, parent) => {
		if (
			parent &&
			parent.key === node &&
			(parent as { computed?: boolean }).computed === false
		) {
			return
		}
		if (node.type !== 'StringLiteral' && node.type !== 'Literal') return
		const value = node.value
		if (typeof value !== 'string') return
		const match = secretPlaceholderExactPattern.exec(value)
		if (!match) return
		const start = typeof node.start === 'number' ? node.start : null
		const end = typeof node.end === 'number' ? node.end : null
		if (start == null || end == null) return
		const scope = match[2]
		literals.push({
			start,
			end,
			name: match[1] ?? '',
			scope:
				scope === 'package' || scope === 'session' || scope === 'user'
					? scope
					: null,
		})
	})
	return literals.filter((literal) => literal.name.length > 0)
}

function walkAst(
	node: unknown,
	visit: (node: ModuleAstNode, parent?: ModuleAstNode) => void,
	parent?: ModuleAstNode,
) {
	if (!node || typeof node !== 'object') return
	const typed = node as ModuleAstNode
	if (typeof typed.type === 'string') visit(typed, parent)
	for (const value of Object.values(typed)) {
		if (Array.isArray(value)) {
			for (const entry of value) walkAst(entry, visit, typed)
			continue
		}
		walkAst(value, visit, typed)
	}
}

function getBindingIdentifierName(node: unknown) {
	if (!node || typeof node !== 'object') return null
	const typed = node as { type?: string; name?: unknown }
	if (typed.type !== 'Identifier' || typeof typed.name !== 'string') return null
	return typed.name
}

function collectPatternBoundNames(node: unknown, names: Set<string>) {
	if (!node || typeof node !== 'object') return
	const typed = node as ModuleAstNode & {
		elements?: Array<unknown>
		properties?: Array<unknown>
		argument?: unknown
	}
	switch (typed.type) {
		case 'Identifier': {
			const name = getBindingIdentifierName(typed)
			if (name) names.add(name)
			return
		}
		case 'ObjectPattern': {
			for (const property of typed.properties ?? []) {
				if (!property || typeof property !== 'object') continue
				const prop = property as ModuleAstNode & {
					value?: unknown
					argument?: unknown
				}
				if (prop.type === 'RestElement') {
					collectPatternBoundNames(prop.argument, names)
					continue
				}
				if (prop.type === 'ObjectProperty' || prop.type === 'Property') {
					collectPatternBoundNames(prop.value, names)
				}
			}
			return
		}
		case 'ArrayPattern': {
			for (const element of typed.elements ?? []) {
				collectPatternBoundNames(element, names)
			}
			return
		}
		case 'AssignmentPattern': {
			collectPatternBoundNames((typed as { left?: unknown }).left, names)
			return
		}
		case 'RestElement': {
			collectPatternBoundNames(typed.argument, names)
			return
		}
		default:
			return
	}
}
