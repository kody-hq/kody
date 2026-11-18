/**
 * Resolves, for one module, whether each read of `.fetch` comes from the
 * global object. Variables are resolved to their declarations, so a local
 * named `self` is not the global object and a local that was assigned the
 * global object is. Properties and methods are tracked by name for the whole
 * module, which only ever reports more reads, never fewer.
 */
import type { ModuleAstNode } from '#worker/module-source.ts'
import {
	resolveModuleBindings,
	type ModuleBinding,
} from '#worker/package-runtime/module-scope-bindings.ts'
import { collectMemberWriteStarts } from '#worker/package-runtime/rewrite-local-execute-secret-fetch.ts'

/** Names the on-load bind handles. */
const boundGlobalNames = new Set(['globalThis', 'self'])
/** Not defined in the package runtime, so a read through them throws. */
const undefinedGlobalNames = new Set(['window', 'global'])
const functionConstructorNames = new Set(['Function'])
const evalNames = new Set(['eval'])
const shapeLengthMax = 48

export type GlobalObjectFetchReadAnalysis = {
	/** `globalThis.fetch` / `self.fetch` reads, bound on load or not. */
	directReads: number
	/** Reads shown to come from the global object under another name. */
	aliasReadShapes: Array<string>
	/** Reads that could not be shown to come from somewhere else. */
	unresolvedReadShapes: Array<string>
	/** `window.fetch` / `global.fetch` reads. */
	undefinedGlobalReads: number
}

type Node = ModuleAstNode & { start?: number; end?: number }
type Link = { parent: Node; key: string }
const functionTypes = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression',
	'ObjectMethod',
	'ClassMethod',
	'ClassPrivateMethod',
])
const memberTypes = new Set(['MemberExpression', 'OptionalMemberExpression'])
const callTypes = new Set([
	'CallExpression',
	'OptionalCallExpression',
	'NewExpression',
])
const wrapperTypes = new Set([
	'ParenthesizedExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSNonNullExpression',
	'TSTypeAssertion',
	'AwaitExpression',
])
/** A global object passed here is not handed on to code that reads from it. */
const harmlessCallees = new Set([
	'Object.defineProperty',
	'Object.defineProperties',
	'Object.keys',
	'Object.getOwnPropertyNames',
	'Object.getOwnPropertySymbols',
	'Object.hasOwn',
	'Object.getPrototypeOf',
	'Object.isFrozen',
	'Object.isExtensible',
	'Object.prototype.hasOwnProperty.call',
	'Object.prototype.propertyIsEnumerable.call',
	'Object.prototype.toString.call',
	'Reflect.has',
	'Reflect.ownKeys',
	'Reflect.defineProperty',
	'Reflect.set',
	'Reflect.deleteProperty',
])
const propertyReadCallees = new Set([
	'Reflect.get',
	'Object.getOwnPropertyDescriptor',
	'Reflect.getOwnPropertyDescriptor',
])
/** Parents where a value is compared or discarded, not passed on. */
const harmlessParentTypes = new Set([
	'UnaryExpression',
	'BinaryExpression',
	'ExpressionStatement',
	'IfStatement',
	'WhileStatement',
	'DoWhileStatement',
	'TemplateLiteral',
	'ThrowStatement',
	'LogicalExpression',
	'ConditionalExpression',
	'SequenceExpression',
	'MemberExpression',
	'OptionalMemberExpression',
])

function nameOf(node: unknown) {
	const typed = node as { type?: string; name?: unknown } | null | undefined
	return typed?.type === 'Identifier' && typeof typed.name === 'string'
		? typed.name
		: null
}

function stringValueOf(node: unknown) {
	const typed = node as { type?: string; value?: unknown } | null | undefined
	return (typed?.type === 'StringLiteral' || typed?.type === 'Literal') &&
		typeof typed.value === 'string'
		? typed.value
		: null
}

/** The static name a member, property or method is keyed by, if it has one. */
function keyNameOf(node: Node, keyField: 'property' | 'key') {
	const key = node[keyField]
	if (node.computed === true) return stringValueOf(key)
	return nameOf(key) ?? stringValueOf(key)
}

function unwrap(node: unknown): Node | null {
	let current = node as Node | null | undefined
	while (current && wrapperTypes.has(current.type)) {
		current = (current.expression ?? current.argument) as Node | undefined
	}
	return current ?? null
}

export function analyzeGlobalObjectFetchReads(
	parsed: ModuleAstNode,
	source: string,
): GlobalObjectFetchReadAnalysis {
	const links = new Map<Node, Link>()
	const nodes: Array<Node> = []
	const collect = (input: unknown, parent: Node | null, key: string) => {
		if (!input || typeof input !== 'object') return
		if (Array.isArray(input)) {
			for (const entry of input) collect(entry, parent, key)
			return
		}
		const node = input as Node
		const isNode = typeof node.type === 'string'
		if (isNode) {
			nodes.push(node)
			if (parent) links.set(node, { parent, key })
		}
		for (const [childKey, value] of Object.entries(node)) {
			collect(value, isNode ? node : parent, isNode ? childKey : key)
		}
	}
	collect(parsed, null, '')
	const bindings = resolveModuleBindings(parsed)
	const bindingOf = (node: unknown) =>
		nameOf(node) ? (bindings.get(node as Node) ?? null) : null
	const isFreeName = (node: unknown, names: Set<string>) => {
		const name = nameOf(node)
		return name != null && names.has(name) && !bindingOf(node)
	}
	const text = (node: Node | null | undefined) =>
		node && typeof node.start === 'number' && typeof node.end === 'number'
			? source
					.slice(node.start, node.end)
					.replace(/\s+/g, ' ')
					.slice(0, shapeLengthMax)
			: '?'
	const calleeText = (node: unknown) => text(unwrap(node)).replace(/\s+/g, '')

	const aliasBindings = new Set<ModuleBinding>()
	/** Undeclared names assigned the global object. */
	const aliasFreeNames = new Set<string>()
	const aliasProperties = new Set<string>()
	const bindingsReturningGlobal = new Set<ModuleBinding>()
	const keysReturningGlobal = new Set<string>()
	const functionNodesReturningGlobal = new Set<Node>()
	/** Calls that hand the global object to code this module cannot follow. */
	const callsGivenGlobal = new Set<Node>()
	const bindingsFromCallsGivenGlobal = new Set<ModuleBinding>()
	/** Variables assigned `this`. */
	const thisAliasBindings = new Set<ModuleBinding>()
	/** The global object stored somewhere this analysis does not follow. */
	const escapes = new Set<string>()
	const aliasReads = new Set<string>()
	const unresolved = new Set<string>()
	let thisMayBeGlobal = false
	let changed = true
	const add = <Value>(set: Set<Value>, value: Value) => {
		if (set.has(value)) return
		set.add(value)
		changed = true
	}

	const functionsByBinding = new Map<ModuleBinding, Array<Node>>()
	const functionsByKey = new Map<string, Array<Node>>()
	const nameFunction = (id: unknown, fn: unknown) => {
		const binding = bindingOf(id)
		const node = unwrap(fn)
		if (!binding || !node || !functionTypes.has(node.type)) return
		functionsByBinding.set(binding, [
			...(functionsByBinding.get(binding) ?? []),
			node,
		])
	}
	const keyFunction = (key: string | null, value: unknown) => {
		const node = unwrap(value)
		if (!key || !node) return
		const binding = bindingOf(node)
		const functions = functionTypes.has(node.type)
			? [node]
			: binding
				? (functionsByBinding.get(binding) ?? [])
				: []
		if (functions.length === 0) return
		functionsByKey.set(key, [...(functionsByKey.get(key) ?? []), ...functions])
	}
	for (const node of nodes) {
		if (node.type === 'FunctionDeclaration') nameFunction(node.id, node)
		if (node.type === 'VariableDeclarator') nameFunction(node.id, node.init)
		if (node.type === 'AssignmentExpression') {
			nameFunction(node.left, node.right)
		}
	}
	// `const run = load` makes `run` every function `load` can be.
	for (let pass = 0, grew = true; grew && pass < 10; pass += 1) {
		grew = false
		for (const node of nodes) {
			const [id, value] =
				node.type === 'VariableDeclarator'
					? [node.id, node.init]
					: node.type === 'AssignmentExpression'
						? [node.left, node.right]
						: [null, null]
			const target = bindingOf(id)
			const source = bindingOf(unwrap(value))
			if (!target || !source || target === source) continue
			const known = functionsByBinding.get(target) ?? []
			const added = (functionsByBinding.get(source) ?? []).filter(
				(fn) => !known.includes(fn),
			)
			if (added.length === 0) continue
			functionsByBinding.set(target, [...known, ...added])
			grew = true
		}
	}
	/** Variables that can also hold something other than a known function. */
	const openBindings = new Set<ModuleBinding>()
	for (const node of nodes) {
		const [id, value] =
			node.type === 'VariableDeclarator'
				? [node.id, unwrap(node.init)]
				: node.type === 'AssignmentExpression'
					? [node.left, unwrap(node.right)]
					: [null, null]
		const target = bindingOf(id)
		if (!target || !value || functionTypes.has(value.type)) continue
		const source = bindingOf(value)
		if (!source || !functionsByBinding.get(source)?.length) {
			openBindings.add(target)
		}
	}
	for (const node of nodes) {
		if (node.type === 'ObjectProperty' || node.type === 'Property') {
			keyFunction(keyNameOf(node, 'key'), node.value)
		} else if (node.type === 'ObjectMethod' || node.type === 'ClassMethod') {
			keyFunction(keyNameOf(node, 'key'), node)
		} else if (node.type === 'AssignmentExpression') {
			const left = unwrap(node.left)
			if (left && memberTypes.has(left.type)) {
				keyFunction(keyNameOf(left, 'property'), node.right)
			}
		}
	}

	function isGlobal(input: unknown): boolean {
		const node = unwrap(input)
		if (!node) return false
		switch (node.type) {
			case 'Identifier': {
				const binding = bindingOf(node)
				if (binding) return aliasBindings.has(binding)
				const name = nameOf(node) as string
				return (
					boundGlobalNames.has(name) ||
					undefinedGlobalNames.has(name) ||
					aliasFreeNames.has(name)
				)
			}
			case 'LogicalExpression':
				return isGlobal(node.left) || isGlobal(node.right)
			case 'ConditionalExpression':
				return isGlobal(node.consequent) || isGlobal(node.alternate)
			case 'SequenceExpression':
				return isGlobal((node.expressions as Array<unknown>).at(-1))
			case 'AssignmentExpression':
				return isGlobal(node.right)
			case 'MemberExpression':
			case 'OptionalMemberExpression': {
				const key = keyNameOf(node, 'property')
				if (key == null) return false
				if (aliasProperties.has(key)) return true
				return (
					isGlobal(node.object) &&
					(boundGlobalNames.has(key) || undefinedGlobalNames.has(key))
				)
			}
			case 'CallExpression':
			case 'OptionalCallExpression':
			case 'NewExpression': {
				const callee = unwrap(node.callee)
				if (!callee) return false
				if (functionNodesReturningGlobal.has(callee)) return true
				const calleeBinding = bindingOf(callee)
				if (calleeBinding && bindingsReturningGlobal.has(calleeBinding)) {
					return true
				}
				if (memberTypes.has(callee.type)) {
					const key = keyNameOf(callee, 'property')
					if (key && keysReturningGlobal.has(key)) return true
				}
				// `Function('return this')()` and `(0, eval)('this')`.
				if (callTypes.has(callee.type)) {
					return isFreeName(unwrap(callee.callee), functionConstructorNames)
				}
				const evaluated = unwrap(
					callee.type === 'SequenceExpression'
						? (callee.expressions as Array<unknown>).at(-1)
						: callee,
				)
				return (
					isFreeName(evaluated, evalNames) &&
					stringValueOf((node.arguments as Array<unknown>)[0])?.trim() ===
						'this'
				)
			}
			default:
				return false
		}
	}

	/** Came back from a call that was handed the global object. */
	function mayBeGlobal(input: unknown): boolean {
		const node = unwrap(input)
		if (!node) return false
		if (callsGivenGlobal.has(node)) return true
		const binding = bindingOf(node)
		if (binding) return bindingsFromCallsGivenGlobal.has(binding)
		if (memberTypes.has(node.type)) return mayBeGlobal(node.object)
		if (node.type === 'LogicalExpression') {
			return mayBeGlobal(node.left) || mayBeGlobal(node.right)
		}
		if (node.type === 'ConditionalExpression') {
			return mayBeGlobal(node.consequent) || mayBeGlobal(node.alternate)
		}
		return false
	}

	/** A pattern that takes its values from the global object. */
	function bindPatternFromGlobal(pattern: unknown) {
		const node = pattern as Node | null | undefined
		if (!node) return
		if (node.type === 'AssignmentPattern') {
			bindPatternFromGlobal(node.left)
			return
		}
		const name = nameOf(node)
		if (name) {
			const binding = bindingOf(node)
			if (binding) add(aliasBindings, binding)
			else add(aliasFreeNames, name)
			return
		}
		if (node.type !== 'ObjectPattern') {
			add(escapes, `${node.type} = <global>`)
			return
		}
		for (const property of (node.properties ?? []) as Array<Node>) {
			if (property.type === 'RestElement') {
				bindPatternFromGlobal(property.argument)
				continue
			}
			const key = keyNameOf(property, 'key')
			if (key == null) {
				add(unresolved, '{ [computed] } = <global>')
			} else if (key === 'fetch') {
				add(aliasReads, '{ fetch } = <global>')
			} else if (boundGlobalNames.has(key) || undefinedGlobalNames.has(key)) {
				bindPatternFromGlobal(property.value)
			}
		}
	}

	function enclosingFunction(node: Node) {
		let current = links.get(node)?.parent
		while (current && !functionTypes.has(current.type)) {
			current = links.get(current)?.parent
		}
		return current ?? null
	}

	function markReturnsGlobal(fn: Node | null) {
		if (!fn) return
		add(functionNodesReturningGlobal, fn)
		const ownBinding = bindingOf(fn.id)
		if (ownBinding) add(bindingsReturningGlobal, ownBinding)
		if (
			fn.type !== 'FunctionExpression' &&
			fn.type !== 'ArrowFunctionExpression' &&
			fn.type !== 'FunctionDeclaration'
		) {
			const key = keyNameOf(fn, 'key')
			if (key == null)
				add(escapes, 'method with computed name returns <global>')
			else if (fn.kind === 'get') add(aliasProperties, key)
			else add(keysReturningGlobal, key)
			return
		}
		let node = fn
		let link = links.get(node)
		while (link && wrapperTypes.has(link.parent.type)) {
			node = link.parent
			link = links.get(node)
		}
		if (!link) return
		const { parent, key } = link
		if (callTypes.has(parent.type) && key === 'callee') return
		if (parent.type === 'VariableDeclarator' && key === 'init') {
			const binding = bindingOf(parent.id)
			if (binding) return add(bindingsReturningGlobal, binding)
		}
		if (parent.type === 'AssignmentExpression' && key === 'right') {
			const left = unwrap(parent.left)
			const binding = bindingOf(left)
			if (binding) return add(bindingsReturningGlobal, binding)
			const name =
				left && memberTypes.has(left.type) ? keyNameOf(left, 'property') : null
			if (name) return add(keysReturningGlobal, name)
		}
		if (
			(parent.type === 'ObjectProperty' ||
				parent.type === 'Property' ||
				parent.type === 'ClassProperty' ||
				parent.type === 'PropertyDefinition') &&
			key === 'value'
		) {
			const name = keyNameOf(parent, 'key')
			if (name) return add(keysReturningGlobal, name)
		}
		if (ownBinding) return
		add(escapes, 'unnamed function returns <global>')
	}

	function passToParameter(call: Node, callee: unknown, index: number) {
		const target = unwrap(callee)
		const binding = bindingOf(target)
		const key =
			target && memberTypes.has(target.type)
				? keyNameOf(target, 'property')
				: null
		const functions =
			target && functionTypes.has(target.type)
				? [target]
				: binding
					? functionsByBinding.get(binding)
					: key
						? functionsByKey.get(key)
						: undefined
		if (!functions?.length) {
			add(callsGivenGlobal, call)
			return
		}
		// A method name does not say which object it is called on, so every
		// function of that name may run, and so may one from outside the module.
		if (!binding && key) add(callsGivenGlobal, call)
		if (binding && openBindings.has(binding)) add(callsGivenGlobal, call)
		for (const fn of functions) {
			const parameter = (fn.params as Array<Node> | undefined)?.[index]
			if (!parameter) continue
			if (parameter.type === 'RestElement') add(callsGivenGlobal, call)
			else bindPatternFromGlobal(parameter)
		}
	}

	function visitGlobalArgument(call: Node, index: number) {
		const callee = unwrap(call.callee)
		const name = calleeText(callee)
		const args = call.arguments as Array<unknown>
		if (harmlessCallees.has(name)) return
		if (name === 'Object.assign' && index === 0) return
		if (propertyReadCallees.has(name) && index === 0) {
			const key = stringValueOf(unwrap(args[1]))
			if (key === 'fetch') add(aliasReads, `${name}(<global>, 'fetch')`)
			else if (key == null) add(unresolved, `${name}(<global>, <computed>)`)
			return
		}
		if (callee && memberTypes.has(callee.type)) {
			const method = keyNameOf(callee, 'property')
			if (method === 'call' || method === 'apply' || method === 'bind') {
				const receiver = unwrap(callee.object)
				if (index === 0) {
					const receiverIsFetch =
						nameOf(receiver) === 'fetch' ||
						(receiver != null &&
							memberTypes.has(receiver.type) &&
							keyNameOf(receiver, 'property') === 'fetch')
					if (!receiverIsFetch && !thisMayBeGlobal) {
						thisMayBeGlobal = true
						changed = true
					}
					return
				}
				if (method === 'call' || method === 'bind') {
					passToParameter(call, receiver, index - 1)
					return
				}
			}
		}
		passToParameter(call, callee, index)
	}

	function isBindingPosition(parent: Node, key: string) {
		if (parent.type === 'VariableDeclarator') return key === 'id'
		if (functionTypes.has(parent.type)) return key === 'id' || key === 'params'
		if (parent.type === 'CatchClause') return key === 'param'
		if (parent.type === 'AssignmentPattern') return key === 'left'
		if (parent.type === 'RestElement') return key === 'argument'
		if (parent.type === 'ArrayPattern') return key === 'elements'
		if (parent.type === 'AssignmentExpression') return key === 'left'
		if (parent.type === 'UpdateExpression') return true
		if (parent.type.startsWith('Import')) return key === 'local'
		if (parent.type.startsWith('Class')) return key === 'id'
		if (parent.type === 'ObjectProperty' || parent.type === 'Property') {
			return (
				key === 'value' && links.get(parent)?.parent.type === 'ObjectPattern'
			)
		}
		return false
	}

	function isReferencePosition(node: Node, parent: Node, key: string) {
		if (node.type !== 'Identifier') return true
		if (memberTypes.has(parent.type)) {
			return key === 'object' || parent.computed === true
		}
		if (key === 'key') return parent.computed === true
		if (isBindingPosition(parent, key)) return false
		if (parent.type.startsWith('Import') || parent.type.startsWith('Export')) {
			return parent.type === 'ExportDefaultDeclaration'
		}
		if (parent.type === 'LabeledStatement') return false
		if (parent.type === 'BreakStatement') return false
		if (parent.type === 'ContinueStatement') return false
		return !parent.type.startsWith('TS') || wrapperTypes.has(parent.type)
	}

	function visitGlobalValue(node: Node) {
		const link = links.get(node)
		if (!link) return
		const { parent, key } = link
		if (!isReferencePosition(node, parent, key)) return
		if (wrapperTypes.has(parent.type)) return
		if (harmlessParentTypes.has(parent.type)) return
		switch (parent.type) {
			case 'VariableDeclarator':
				if (key === 'init') bindPatternFromGlobal(parent.id)
				return
			case 'AssignmentPattern':
				if (key === 'right') bindPatternFromGlobal(parent.left)
				return
			case 'AssignmentExpression': {
				if (key !== 'right') return
				const left = unwrap(parent.left)
				if (left && memberTypes.has(left.type)) {
					const property = keyNameOf(left, 'property')
					if (property == null) add(escapes, '<object>[computed] = <global>')
					else add(aliasProperties, property)
					return
				}
				bindPatternFromGlobal(left)
				return
			}
			case 'ObjectProperty':
			case 'Property':
			case 'ClassProperty':
			case 'PropertyDefinition': {
				if (key !== 'value') return
				const property = keyNameOf(parent, 'key')
				if (property == null) add(escapes, '{ [computed]: <global> }')
				else add(aliasProperties, property)
				return
			}
			case 'ReturnStatement':
				markReturnsGlobal(enclosingFunction(parent))
				return
			case 'ArrowFunctionExpression':
				if (key === 'body') markReturnsGlobal(parent)
				return
			case 'CallExpression':
			case 'OptionalCallExpression':
			case 'NewExpression': {
				if (key !== 'arguments') return
				visitGlobalArgument(
					parent,
					(parent.arguments as Array<unknown>).indexOf(node),
				)
				return
			}
			default:
				add(escapes, `${parent.type} holds <global>`)
		}
	}

	for (let pass = 0; changed && pass < 20; pass += 1) {
		changed = false
		for (const node of nodes) {
			if (isGlobal(node)) visitGlobalValue(node)
			const target =
				node.type === 'VariableDeclarator'
					? { id: node.id, value: node.init }
					: node.type === 'AssignmentExpression'
						? { id: node.left, value: node.right }
						: null
			const binding = bindingOf(target?.id)
			const value = unwrap(target?.value)
			if (binding && mayBeGlobal(value)) {
				add(bindingsFromCallsGivenGlobal, binding)
			}
			if (binding && value?.type === 'ThisExpression') {
				add(thisAliasBindings, binding)
			}
			// `const alias = getGlobal` and `{ get: getGlobal }`.
			const returnsGlobal =
				value != null &&
				(bindingsReturningGlobal.has(bindingOf(value) as ModuleBinding) ||
					(memberTypes.has(value.type) &&
						keysReturningGlobal.has(keyNameOf(value, 'property') ?? '')))
			if (binding && returnsGlobal) add(bindingsReturningGlobal, binding)
			if (node.type === 'ObjectPattern') {
				// Reading a property that holds the global object, from any object.
				for (const property of (node.properties ?? []) as Array<Node>) {
					if (property.type === 'RestElement') continue
					const key = keyNameOf(property, 'key')
					if (key && aliasProperties.has(key)) {
						bindPatternFromGlobal(property.value)
					}
				}
			}
			if (node.type === 'ObjectProperty' || node.type === 'Property') {
				const held = bindingOf(unwrap(node.value))
				const key = keyNameOf(node, 'key')
				if (held && key && bindingsReturningGlobal.has(held)) {
					add(keysReturningGlobal, key)
				}
			}
		}
	}
	if (changed) escapes.add('alias chain too deep to follow')

	const bindingCounts = new Map<ModuleBinding, number>()
	const initializers = new Map<ModuleBinding, unknown>()
	for (const node of nodes) {
		const binding = bindingOf(node)
		const link = links.get(node)
		if (!binding || !link || !isBindingPosition(link.parent, link.key)) continue
		bindingCounts.set(binding, (bindingCounts.get(binding) ?? 0) + 1)
		if (link.parent.type === 'VariableDeclarator') {
			initializers.set(binding, link.parent.init)
		}
	}
	/** A computed key that is a symbol, a number or a known other string. */
	function keyIsNotFetch(input: unknown, depth = 0): boolean {
		const key = unwrap(input)
		if (!key || depth > 4) return false
		if (key.type === 'NumericLiteral') return true
		const value = stringValueOf(key)
		if (value != null) return value !== 'fetch'
		if (calleeText(key).startsWith('Symbol')) return true
		const prefix =
			key.type === 'TemplateLiteral'
				? ((key.quasis as Array<{ value?: { cooked?: string } }>)[0]?.value
						?.cooked ?? '')
				: key.type === 'BinaryExpression' && key.operator === '+'
					? (stringValueOf(unwrap(key.left)) ?? '')
					: ''
		if (prefix && !'fetch'.startsWith(prefix)) return true
		// A variable declared once and never assigned again is its initializer.
		const binding = bindingOf(key)
		if (!binding || bindingCounts.get(binding) !== 1) return false
		return keyIsNotFetch(initializers.get(binding), depth + 1)
	}

	const writes = collectMemberWriteStarts(parsed)
	let directReads = 0
	let undefinedGlobalReads = 0
	for (const node of nodes) {
		if (!memberTypes.has(node.type)) continue
		if (typeof node.start === 'number' && writes.has(node.start)) continue
		const object = unwrap(node.object)
		const key = keyNameOf(node, 'property')
		if (key == null) {
			if (node.computed !== true || !isGlobal(object)) continue
			const parent = links.get(node)?.parent
			if (parent?.type === 'UnaryExpression' && parent.operator === 'typeof') {
				continue
			}
			if (keyIsNotFetch(node.property)) continue
			if (isFreeName(object, undefinedGlobalNames)) continue
			unresolved.add(`${text(object)}[<computed>]`)
			continue
		}
		if (key !== 'fetch') continue
		if (isFreeName(object, boundGlobalNames)) {
			directReads += 1
		} else if (isFreeName(object, undefinedGlobalNames)) {
			undefinedGlobalReads += 1
		} else if (isGlobal(object)) {
			aliasReads.add(`${text(object)}.fetch`)
		} else if (
			thisMayBeGlobal &&
			(object?.type === 'ThisExpression' ||
				thisAliasBindings.has(bindingOf(object) as ModuleBinding))
		) {
			unresolved.add('this.fetch, this set to <global>')
		} else if (object?.type === 'ThisExpression') {
			continue
		} else if (mayBeGlobal(object)) {
			unresolved.add(`${text(object)}.fetch, from a call given <global>`)
		} else if (escapes.size > 0) {
			unresolved.add(`${text(object)}.fetch`)
		}
	}
	if (unresolved.size > 0) {
		for (const escape of escapes) unresolved.add(escape)
	}
	return {
		directReads,
		aliasReadShapes: [...aliasReads],
		unresolvedReadShapes: [...unresolved],
		undefinedGlobalReads,
	}
}
