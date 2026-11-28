/**
 * Name inference for `0013-declare-credential-needs`: what a credential name
 * built at run time can be, read from the package's own source.
 *
 * Each module is reduced to a small summary (never its AST), and a name is
 * traced through variables, parameters and their call sites, returned values,
 * and object fields, by name. The result is the literal names it can be and
 * the `<literal>-<suffix>` conventions it follows. Anything else is `unknown`.
 * Nothing is guessed: a prefix comes only from a literal followed by a
 * hyphen in the traced value.
 */
import {
	type AstNode,
	constantsWithoutShadows,
	getCalleeName,
	getNodeName,
	type NameKind,
	resolveStringExpression,
	templateElementText,
	unwrapExpression,
	walkAst,
} from '#worker/credentials/module-placeholder-scan.ts'

/** A value a name expression can take, as far as source says. */
type Value =
	| { t: 'lit'; value: string }
	| { t: 'any'; of: Array<Value> }
	/** `head`, a hyphen, then anything. */
	| { t: 'prefix'; head: Value }
	| { t: 'lower'; of: Value }
	| { t: 'ref'; name: string }
	| { t: 'field'; name: string }
	| { t: 'call'; name: string }
	| { t: 'unknown' }

type FunctionSummary = { exported: boolean; returns: Array<Value> }
type ParameterSummary = { fn: string | null; index: number }

export type CredentialNameSite = { kind: NameKind; value: Value }

export type ModuleNameSummary = {
	bindings: Map<string, Array<Value>>
	fields: Map<string, Array<Value>>
	functions: Map<string, Array<FunctionSummary>>
	parameters: Map<string, Array<ParameterSummary>>
	calls: Map<string, Array<Array<Value>>>
	/**
	 * `name.startsWith(prefix)` checks, by the name checked: the package tests
	 * the name against a convention before it uses it.
	 */
	guards: Map<string, Array<Value>>
	/** Too many calls to keep: parameters of this package are unknown. */
	callsTruncated: boolean
	sites: Array<CredentialNameSite>
}

export type InferredCredentialNames = {
	exact: Set<string>
	prefix: Set<string>
	unknown: boolean
}

const unknownValue: Value = { t: 'unknown' }
const maxValueDepth = 8
const maxCallsPerModule = 2000
const maxResolveSteps = 20_000

const functionTypes = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression',
	'ObjectMethod',
	'ClassMethod',
	'ClassPrivateMethod',
])
const callTypes = new Set(['CallExpression', 'OptionalCallExpression'])
const memberTypes = new Set(['MemberExpression', 'OptionalMemberExpression'])
/** String methods that return the same name. */
const sameStringMethods = new Set(['trim', 'toString', 'valueOf', 'normalize'])
/** Array methods whose callback takes one element first. */
const elementCallbackMethods = new Set([
	'some',
	'every',
	'find',
	'filter',
	'map',
	'flatMap',
	'forEach',
])
const placeholderOpenerAtEndPattern =
	/\{\{(?:(secret)|integration-token):([^{}|]*)$/
const prefixHeadPattern = /^([A-Za-z][A-Za-z0-9._-]*)-$/

function push<Key, Item>(map: Map<Key, Array<Item>>, key: Key, item: Item) {
	const items = map.get(key)
	if (items) items.push(item)
	else map.set(key, [item])
}

type Part = string | AstNode

/** The literal and computed pieces of a template or `+` chain, in order. */
function stringParts(
	node: AstNode,
	constants: ReadonlyMap<string, string>,
): Array<Part> {
	const inner = unwrapExpression(node) ?? node
	const resolved = resolveStringExpression(inner, constants)
	if (resolved != null) return [resolved]
	if (inner.type === 'TemplateLiteral') {
		const parts: Array<Part> = []
		const expressions = inner.expressions ?? []
		for (const [index, quasi] of (inner.quasis ?? []).entries()) {
			parts.push(templateElementText(quasi))
			const expression = expressions[index]
			if (expression) parts.push(...stringParts(expression, constants))
		}
		return mergeParts(parts)
	}
	if (
		inner.type === 'BinaryExpression' &&
		inner.operator === '+' &&
		inner.left &&
		inner.right
	) {
		return mergeParts([
			...stringParts(inner.left, constants),
			...stringParts(inner.right, constants),
		])
	}
	return [inner]
}

function mergeParts(parts: Array<Part>) {
	const merged: Array<Part> = []
	for (const part of parts) {
		const last = merged.at(-1)
		if (typeof part === 'string' && typeof last === 'string') {
			merged[merged.length - 1] = last + part
		} else if (part !== '') {
			merged.push(part)
		}
	}
	return merged
}

function isComposite(node: AstNode) {
	if (node.type === 'TemplateLiteral') {
		return (node.expressions ?? []).length > 0
	}
	return node.type === 'BinaryExpression' && node.operator === '+'
}

function toValue(
	node: AstNode | null | undefined,
	constants: ReadonlyMap<string, string>,
	depth = 0,
): Value {
	const inner = unwrapExpression(node ?? undefined)
	if (!inner || depth > maxValueDepth) return unknownValue
	const next = (child: AstNode | null | undefined) =>
		toValue(child, constants, depth + 1)
	const literal = resolveStringExpression(inner, constants)
	if (literal != null) return { t: 'lit', value: literal }
	switch (inner.type) {
		case 'Identifier': {
			const name = getNodeName(inner)
			return name ? { t: 'ref', name } : unknownValue
		}
		case 'TemplateLiteral':
		case 'BinaryExpression': {
			if (!isComposite(inner)) return unknownValue
			const [first, second] = stringParts(inner, constants)
			if (typeof first === 'string') {
				const head = first.match(prefixHeadPattern)?.[1]
				return head && second !== undefined
					? { t: 'prefix', head: { t: 'lit', value: head } }
					: unknownValue
			}
			return first && typeof second === 'string' && second.startsWith('-')
				? { t: 'prefix', head: next(first) }
				: unknownValue
		}
		case 'ConditionalExpression':
			return {
				t: 'any',
				of: [
					next(inner.consequent as unknown as AstNode),
					next((inner as { alternate?: AstNode }).alternate),
				],
			}
		case 'LogicalExpression':
			return inner.operator === '&&'
				? next(inner.right)
				: { t: 'any', of: [next(inner.left), next(inner.right)] }
		case 'AwaitExpression':
			return next(inner.argument)
		case 'ArrayExpression':
			return { t: 'any', of: (inner.elements ?? []).map(next) }
		case 'MemberExpression':
		case 'OptionalMemberExpression': {
			const name = inner.computed === true ? null : getNodeName(inner.property)
			return name ? { t: 'field', name } : unknownValue
		}
		case 'CallExpression':
		case 'OptionalCallExpression': {
			const callee = inner.callee
			const name = getCalleeName(callee)
			if (!name) return unknownValue
			if (callee && memberTypes.has(callee.type)) {
				if (sameStringMethods.has(name)) return next(callee.object)
				if (name === 'toLowerCase') {
					return { t: 'lower', of: next(callee.object) }
				}
				if (name === 'replace' || name === 'replaceAll') {
					return { t: 'any', of: [next(callee.object), unknownValue] }
				}
			}
			if (name === 'String' && callee?.type === 'Identifier') {
				return next(inner.arguments?.[0])
			}
			return { t: 'call', name }
		}
		default:
			return unknownValue
	}
}

function functionName(node: AstNode, parent: AstNode | undefined) {
	if (node.type === 'FunctionDeclaration') return getNodeName(node.id)
	if (node.type === 'ObjectMethod' || node.type === 'ClassMethod') {
		return node.computed === true ? null : getNodeName(node.key)
	}
	if (parent?.type === 'VariableDeclarator' && parent.init === node) {
		return getNodeName(parent.id)
	}
	if (
		parent?.type === 'ObjectProperty' &&
		parent.computed !== true &&
		(parent as { value?: unknown }).value === node
	) {
		return getNodeName(parent.key)
	}
	return null
}

function returnedValues(
	fn: AstNode,
	moduleConstants: ReadonlyMap<string, string>,
	outer: ReadonlyArray<AstNode>,
) {
	const body = fn.body
	if (!body || Array.isArray(body)) return []
	// The function's own parameters and locals shadow module constants.
	const scope = [...outer, fn]
	if (body.type !== 'BlockStatement') {
		return [toValue(body, constantsWithoutShadows(moduleConstants, scope))]
	}
	const returns: Array<Value> = []
	walkAst(
		body,
		(node, ancestors) => {
			if (node.type !== 'ReturnStatement') return
			if (
				ancestors
					.slice(scope.length)
					.some((ancestor) => functionTypes.has(ancestor.type))
			) {
				return
			}
			returns.push(
				node.argument
					? toValue(
							node.argument,
							constantsWithoutShadows(moduleConstants, ancestors),
						)
					: unknownValue,
			)
		},
		scope,
	)
	return returns
}

/** Binds each name a pattern declares to the value it takes from `value`. */
function bindPattern(
	pattern: AstNode | null | undefined,
	value: Value,
	constants: ReadonlyMap<string, string>,
	bind: (name: string, value: Value) => void,
) {
	if (!pattern) return
	switch (pattern.type) {
		case 'Identifier': {
			const name = getNodeName(pattern)
			if (name) bind(name, value)
			return
		}
		case 'AssignmentPattern':
			bindPattern(
				pattern.left,
				{ t: 'any', of: [value, toValue(pattern.right, constants)] },
				constants,
				bind,
			)
			return
		case 'ObjectPattern':
			for (const property of pattern.properties ?? []) {
				if (property.type !== 'ObjectProperty' || property.computed === true) {
					bindPattern(property.argument, unknownValue, constants, bind)
					continue
				}
				const key = getNodeName(property.key)
				bindPattern(
					(property as { value?: AstNode }).value,
					key ? { t: 'field', name: key } : unknownValue,
					constants,
					bind,
				)
			}
			return
		case 'ArrayPattern':
			for (const element of pattern.elements ?? []) {
				bindPattern(element, unknownValue, constants, bind)
			}
			return
		case 'RestElement':
			bindPattern(pattern.argument, unknownValue, constants, bind)
			return
		case 'TSParameterProperty':
			bindPattern(pattern.parameter, value, constants, bind)
			return
		default:
			return
	}
}

/** Fetch-gateway helpers that take name fields, as `0010` reads them. */
const nameFieldsByCallee: Record<string, ReadonlyArray<string>> = {
	basic: ['usernameSecret', 'passwordSecret'],
	oauthClientCredentials: ['clientIdSecret', 'clientSecretSecret'],
}

/**
 * The name sites of one composite string: each `{{secret:` or
 * `{{integration-token:` opener that a computed piece follows.
 */
function placeholderSites(
	node: AstNode,
	constants: ReadonlyMap<string, string>,
): Array<CredentialNameSite> {
	const parts = stringParts(node, constants)
	const sites: Array<CredentialNameSite> = []
	for (const [index, part] of parts.entries()) {
		if (typeof part !== 'string') continue
		const opener = part.match(placeholderOpenerAtEndPattern)
		const expression = parts[index + 1]
		if (!opener || expression === undefined) continue
		if (typeof expression === 'string') continue
		const kind: NameKind = opener[1] ? 'secret' : 'integration'
		const head = opener[2] ?? ''
		const after = parts[index + 2]
		let value: Value = unknownValue
		if (head !== '') {
			const literal = head.match(prefixHeadPattern)?.[1]
			if (literal) value = { t: 'prefix', head: { t: 'lit', value: literal } }
		} else if (typeof after === 'string' && /^(?:\}\}|\|)/.test(after)) {
			value = toValue(expression, constants)
		} else if (typeof after === 'string' && after.startsWith('-')) {
			value = { t: 'prefix', head: toValue(expression, constants) }
		}
		sites.push({ kind, value })
	}
	return sites
}

/** The prefix a `startsWith` argument names: a head, then a hyphen. */
function guardValue(
	node: AstNode | undefined,
	constants: ReadonlyMap<string, string>,
): Value | null {
	const literal = resolveStringExpression(node, constants)
	if (literal != null) {
		const head = literal.match(prefixHeadPattern)?.[1]
		return head ? { t: 'prefix', head: { t: 'lit', value: head } } : null
	}
	const inner = unwrapExpression(node)
	if (!inner || !isComposite(inner)) return null
	const parts = stringParts(inner, constants)
	const [first, second] = parts
	return parts.length === 2 &&
		first !== undefined &&
		typeof first !== 'string' &&
		second === '-'
		? { t: 'prefix', head: toValue(first, constants) }
		: null
}

export function summarizeModuleNames(
	parsed: AstNode,
	moduleConstants: ReadonlyMap<string, string>,
): ModuleNameSummary {
	const summary: ModuleNameSummary = {
		bindings: new Map(),
		fields: new Map(),
		functions: new Map(),
		parameters: new Map(),
		calls: new Map(),
		guards: new Map(),
		callsTruncated: false,
		sites: [],
	}
	const exportedNames = new Set<string>()
	let callCount = 0
	const bind = (name: string, value: Value) =>
		push(summary.bindings, name, value)
	walkAst(parsed, (node, ancestors) => {
		const parent = ancestors.at(-1)
		const constants = () => constantsWithoutShadows(moduleConstants, ancestors)
		if (functionTypes.has(node.type)) {
			const name = functionName(node, parent)
			const exported = ancestors.some(
				(ancestor) =>
					ancestor.type === 'ExportNamedDeclaration' ||
					ancestor.type === 'ExportDefaultDeclaration',
			)
			if (name) {
				push(summary.functions, name, {
					exported,
					returns: returnedValues(node, moduleConstants, ancestors),
				})
			}
			// An array method callback takes one element of the array.
			const isElementCallback =
				parent &&
				callTypes.has(parent.type) &&
				parent.arguments?.[0] === node &&
				parent.callee &&
				memberTypes.has(parent.callee.type) &&
				elementCallbackMethods.has(getCalleeName(parent.callee) ?? '')
			for (const [index, parameter] of (node.params ?? []).entries()) {
				if (isElementCallback) {
					bindPattern(
						parameter,
						index === 0
							? toValue(parent.callee?.object, constants())
							: unknownValue,
						constants(),
						bind,
					)
					continue
				}
				const target =
					parameter.type === 'AssignmentPattern' ? parameter.left : parameter
				if (target?.type === 'Identifier') {
					const local = getNodeName(target)
					if (local) push(summary.parameters, local, { fn: name, index })
					if (parameter.type === 'AssignmentPattern' && local) {
						bind(local, toValue(parameter.right, constants()))
					}
					continue
				}
				bindPattern(parameter, unknownValue, constants(), bind)
			}
			return
		}
		switch (node.type) {
			case 'ExportSpecifier': {
				const local = getNodeName(node.local)
				if (local) exportedNames.add(local)
				return
			}
			case 'ExportDefaultDeclaration': {
				const local = getNodeName(node.declaration)
				if (local) exportedNames.add(local)
				return
			}
			case 'VariableDeclarator': {
				if (!node.init) {
					// `for (const item of items)` binds one element.
					const loop = ancestors.at(-2)
					if (loop?.type === 'ForOfStatement' && loop.left === parent) {
						bindPattern(
							node.id,
							toValue(loop.right, constants()),
							constants(),
							bind,
						)
					}
					return
				}
				if (functionTypes.has(node.init.type)) return
				bindPattern(node.id, toValue(node.init, constants()), constants(), bind)
				return
			}
			case 'AssignmentExpression': {
				const value = toValue(node.right, constants())
				if (node.left?.type === 'Identifier') {
					const name = getNodeName(node.left)
					if (name) bind(name, value)
				} else if (
					node.left &&
					memberTypes.has(node.left.type) &&
					node.left.computed !== true
				) {
					const name = getNodeName(node.left.property)
					if (name) push(summary.fields, name, value)
				}
				return
			}
			case 'ObjectProperty': {
				if (parent?.type !== 'ObjectExpression' || node.computed === true) {
					return
				}
				const name = getNodeName(node.key)
				const value = (node as { value?: AstNode }).value
				if (!name || !value || functionTypes.has(value.type)) return
				push(summary.fields, name, toValue(value, constants()))
				return
			}
			case 'CallExpression':
			case 'OptionalCallExpression': {
				const name = getCalleeName(node.callee)
				if (!name) return
				if (name === 'createAuthenticatedFetch') {
					const argument = node.arguments?.[0]
					if (
						argument &&
						resolveStringExpression(argument, constants()) == null
					) {
						summary.sites.push({
							kind: 'integration',
							value: toValue(argument, constants()),
						})
					}
				}
				if (
					name === 'startsWith' &&
					node.callee &&
					memberTypes.has(node.callee.type) &&
					node.callee.object?.type === 'Identifier'
				) {
					const checked = getNodeName(node.callee.object)
					const guard = guardValue(node.arguments?.[0], constants())
					if (checked && guard) push(summary.guards, checked, guard)
				}
				const nameFields = Object.hasOwn(nameFieldsByCallee, name)
					? nameFieldsByCallee[name]
					: undefined
				const options = unwrapExpression(node.arguments?.[0])
				if (nameFields && options?.type === 'ObjectExpression') {
					for (const property of options.properties ?? []) {
						if (property.type !== 'ObjectProperty') continue
						if (property.computed === true) continue
						if (!nameFields.includes(getNodeName(property.key) ?? '')) continue
						const value = (property as { value?: AstNode }).value
						if (resolveStringExpression(value, constants()) != null) continue
						summary.sites.push({
							kind: 'secret',
							value: toValue(value, constants()),
						})
					}
				}
				if (callCount >= maxCallsPerModule) {
					summary.callsTruncated = true
					return
				}
				callCount += 1
				push(
					summary.calls,
					name,
					(node.arguments ?? []).map((argument) =>
						toValue(argument, constants()),
					),
				)
				return
			}
			case 'TemplateLiteral':
			case 'BinaryExpression': {
				if (!isComposite(node)) return
				// The outermost string of a chain owns its pieces.
				if (
					parent &&
					(parent.type === 'TemplateLiteral' ||
						(parent.type === 'BinaryExpression' && parent.operator === '+'))
				) {
					return
				}
				summary.sites.push(...placeholderSites(node, constants()))
				return
			}
			default:
				return
		}
	})
	for (const name of exportedNames) {
		for (const fn of summary.functions.get(name) ?? []) fn.exported = true
	}
	return summary
}

/**
 * What `value`, read in module `path`, can be across the package's modules.
 * Names are matched by spelling: the module's own first, then any module's
 * (an import keeps its name).
 */
export function inferCredentialNames(
	value: Value,
	path: string,
	modules: ReadonlyMap<string, ModuleNameSummary>,
): InferredCredentialNames {
	let steps = 0
	const callsTruncated = [...modules.values()].some(
		(summary) => summary.callsTruncated,
	)
	/** Names being resolved: a cycle adds nothing. */
	const active = new Set<string>()
	const everywhere = <Item>(
		home: string,
		read: (summary: ModuleNameSummary) => Array<Item> | undefined,
	) => {
		const own = read(modules.get(home)!)
		if (own && own.length > 0) {
			return own.map((item) => ({ item, path: home }))
		}
		return [...modules].flatMap(([modulePath, summary]) =>
			(read(summary) ?? []).map((item) => ({ item, path: modulePath })),
		)
	}
	const resolve = (
		current: Value,
		home: string,
		into: InferredCredentialNames,
	) => {
		steps += 1
		if (steps > maxResolveSteps) {
			into.unknown = true
			return
		}
		switch (current.t) {
			case 'lit':
				into.exact.add(current.value)
				return
			case 'unknown':
				into.unknown = true
				return
			case 'any':
				for (const option of current.of) resolve(option, home, into)
				return
			case 'lower':
			case 'prefix': {
				const inner: InferredCredentialNames = {
					exact: new Set(),
					prefix: new Set(),
					unknown: false,
				}
				resolve(current.t === 'lower' ? current.of : current.head, home, inner)
				if (current.t === 'lower') {
					for (const name of inner.exact) into.exact.add(name.toLowerCase())
					for (const name of inner.prefix) into.prefix.add(name.toLowerCase())
					if (inner.unknown) into.unknown = true
					return
				}
				// `<head>-<suffix>` is under every prefix the head is, or is under.
				for (const name of [...inner.exact, ...inner.prefix]) {
					into.prefix.add(name)
				}
				if (inner.unknown || inner.exact.size + inner.prefix.size === 0) {
					into.unknown = true
				}
				return
			}
			case 'field': {
				// An object can come from outside the package, so a field is
				// never fully known.
				into.unknown = true
				const key = `field:${current.name}`
				if (active.has(key)) return
				active.add(key)
				for (const [modulePath, summary] of modules) {
					for (const option of summary.fields.get(current.name) ?? []) {
						resolve(option, modulePath, into)
					}
				}
				active.delete(key)
				return
			}
			case 'call': {
				const key = `call:${current.name}`
				if (active.has(key)) return
				active.add(key)
				const functions = everywhere(home, (summary) =>
					summary.functions.get(current.name),
				)
				if (functions.length === 0) into.unknown = true
				for (const fn of functions) {
					if (fn.item.returns.length === 0) into.unknown = true
					for (const returned of fn.item.returns) {
						resolve(returned, fn.path, into)
					}
				}
				active.delete(key)
				return
			}
			case 'ref': {
				const key = `ref:${home}:${current.name}`
				if (active.has(key)) return
				active.add(key)
				const bindings = everywhere(home, (summary) =>
					summary.bindings.get(current.name),
				)
				const parameters = everywhere(home, (summary) =>
					summary.parameters.get(current.name),
				)
				// A name the package checks against a prefix is bounded by that
				// prefix and by the literals it can also be, whatever passes it.
				const guards = modules.get(home)?.guards.get(current.name) ?? []
				for (const guard of guards) resolve(guard, home, into)
				const target: InferredCredentialNames =
					guards.length > 0
						? { exact: into.exact, prefix: into.prefix, unknown: false }
						: into
				if (bindings.length === 0 && parameters.length === 0) {
					target.unknown = true
				}
				for (const binding of bindings) {
					resolve(binding.item, binding.path, target)
				}
				for (const parameter of parameters) {
					const fn = parameter.item.fn
					const declared = fn
						? [...modules.values()].flatMap(
								(summary) => summary.functions.get(fn) ?? [],
							)
						: []
					const calls = fn
						? [...modules].flatMap(([modulePath, summary]) =>
								(summary.calls.get(fn) ?? []).map((args) => ({
									args,
									path: modulePath,
								})),
							)
						: []
					// A caller outside the package can pass anything.
					if (
						callsTruncated ||
						calls.length === 0 ||
						declared.some((candidate) => candidate.exported)
					) {
						target.unknown = true
					}
					for (const call of calls) {
						const argument = call.args[parameter.item.index]
						if (argument) resolve(argument, call.path, target)
					}
				}
				active.delete(key)
				return
			}
			default: {
				const exhaustive: never = current
				throw new Error(`Unhandled value: ${String(exhaustive)}`)
			}
		}
	}
	const inferred: InferredCredentialNames = {
		exact: new Set(),
		prefix: new Set(),
		unknown: false,
	}
	resolve(value, path, inferred)
	return inferred
}
