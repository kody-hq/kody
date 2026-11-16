/**
 * Resolves the identifiers of a parsed module to their declarations, so a
 * caller can tell a local named `self` from the global of that name.
 */
import type { ModuleAstNode } from '#worker/module-source.ts'

/** One declared variable. Identifiers that refer to it share the object. */
export type ModuleBinding = { name: string }
type Node = ModuleAstNode
type Scope = {
	bindings: Map<string, ModuleBinding>
	parent: Scope | null
	isFunction: boolean
}

const functionTypes = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression',
	'ObjectMethod',
	'ClassMethod',
	'ClassPrivateMethod',
])
const scopeTypes = new Set([
	'BlockStatement',
	'ForStatement',
	'ForInStatement',
	'ForOfStatement',
	'SwitchStatement',
	'CatchClause',
	'StaticBlock',
	'ClassBody',
])

function nameOf(node: unknown) {
	const typed = node as { type?: string; name?: unknown } | null | undefined
	return typed?.type === 'Identifier' && typeof typed.name === 'string'
		? typed.name
		: null
}

function patternIdentifiers(pattern: unknown, into: Array<Node>) {
	const node = pattern as Node | null | undefined
	if (!node) return
	switch (node.type) {
		case 'Identifier':
			into.push(node)
			return
		case 'AssignmentPattern':
			patternIdentifiers(node.left, into)
			return
		case 'RestElement':
			patternIdentifiers(node.argument, into)
			return
		case 'TSParameterProperty':
			patternIdentifiers(node.parameter, into)
			return
		case 'ArrayPattern':
			for (const element of node.elements as Array<unknown>) {
				patternIdentifiers(element, into)
			}
			return
		case 'ObjectPattern':
			for (const property of node.properties as Array<Node>) {
				patternIdentifiers(
					property.type === 'RestElement' ? property : property.value,
					into,
				)
			}
			return
		default:
			return
	}
}

/**
 * Maps each identifier node that refers to a declared variable to that
 * variable. An identifier missing from the map is a free name: a global.
 */
export function resolveModuleBindings(program: ModuleAstNode) {
	const scopes = new Map<Node, Scope>()
	const declare = (scope: Scope, pattern: unknown) => {
		const identifiers: Array<Node> = []
		patternIdentifiers(pattern, identifiers)
		for (const identifier of identifiers) {
			const name = nameOf(identifier) as string
			if (!scope.bindings.has(name)) scope.bindings.set(name, { name })
		}
	}
	const functionScopeOf = (scope: Scope) => {
		let current = scope
		while (!current.isFunction && current.parent) current = current.parent
		return current
	}
	const newScope = (parent: Scope, isFunction: boolean): Scope => ({
		bindings: new Map(),
		parent,
		isFunction,
	})
	const build = (input: unknown, scope: Scope) => {
		if (!input || typeof input !== 'object') return
		if (Array.isArray(input)) {
			for (const entry of input) build(entry, scope)
			return
		}
		const node = input as Node
		let inner = scope
		if (typeof node.type === 'string') {
			if (functionTypes.has(node.type)) {
				if (node.type === 'FunctionDeclaration') declare(scope, node.id)
				inner = newScope(scope, true)
				if (node.type === 'FunctionExpression') declare(inner, node.id)
				for (const parameter of (node.params ?? []) as Array<unknown>) {
					declare(inner, parameter)
				}
			} else if (scopeTypes.has(node.type)) {
				inner = newScope(scope, false)
				if (node.type === 'CatchClause') declare(inner, node.param)
			} else if (node.type === 'ClassDeclaration') {
				declare(scope, node.id)
			} else if (node.type === 'ClassExpression' && node.id) {
				inner = newScope(scope, false)
				declare(inner, node.id)
			} else if (node.type === 'VariableDeclaration') {
				const target = node.kind === 'var' ? functionScopeOf(scope) : scope
				for (const declarator of node.declarations as Array<Node>) {
					declare(target, declarator.id)
				}
			} else if (
				node.type === 'ImportSpecifier' ||
				node.type === 'ImportDefaultSpecifier' ||
				node.type === 'ImportNamespaceSpecifier'
			) {
				declare(scope, node.local)
			}
			scopes.set(node, inner)
		}
		for (const value of Object.values(node)) build(value, inner)
	}
	const root: Scope = { bindings: new Map(), parent: null, isFunction: true }
	build(program, root)
	const resolved = new Map<Node, ModuleBinding>()
	const resolve = (input: unknown, scope: Scope) => {
		if (!input || typeof input !== 'object') return
		if (Array.isArray(input)) {
			for (const entry of input) resolve(entry, scope)
			return
		}
		const node = input as Node
		const name = nameOf(node)
		if (name) {
			for (
				let current: Scope | null = scope;
				current;
				current = current.parent
			) {
				const binding = current.bindings.get(name)
				if (!binding) continue
				resolved.set(node, binding)
				break
			}
		}
		const inner = scopes.get(node) ?? scope
		for (const [key, value] of Object.entries(node)) {
			// A declared function's or class's own name lives outside it.
			const declaredName =
				key === 'id' &&
				(node.type === 'FunctionDeclaration' ||
					node.type === 'ClassDeclaration')
			resolve(value, declaredName ? scope : inner)
		}
	}
	resolve(program, root)
	return resolved
}
