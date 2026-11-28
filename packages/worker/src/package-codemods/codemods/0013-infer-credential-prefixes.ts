/**
 * Name conventions codemod `0013` reads from a package that builds a
 * credential name at run time, so it can declare a `prefix: true` slot
 * instead of leaving the package for its owner.
 *
 * A prefix `P` is inferred only from source that states it:
 * - a string built as `P-` plus a run-time part (`'google-' + purpose`),
 *   when `P` is also a whole string somewhere in the package;
 * - `.startsWith('P-')`, with the same condition;
 * - `X + '-'` where `X` walks a module-level array of string literals
 *   (`PREFIXES.some((item) => name.startsWith(item + '-'))`);
 * - a literal default behind the name a gateway helper is called with
 *   (`createAuthenticatedFetch(name ?? 'slack')`).
 * Anything else stays a manual finding. No rule yields a bare wildcard.
 */
import {
	type AstNode,
	constantsWithoutShadows,
	forEachScannableModule,
	getCalleeName,
	getNodeName,
	resolveStringExpression,
	templateElementText,
	unwrapExpression,
	walkAst,
} from '#worker/credentials/module-placeholder-scan.ts'
import {
	packageCredentialSlotNamePattern,
	packageCredentialSlotPrefixMinLength,
} from '#worker/package-registry/types.ts'

type Part = { text: string } | { node: AstNode }

const placeholderOpeningPattern = /\{\{(?:secret|integration-token):([^{}|]*)$/
const placeholderOpeningOnlyPattern = /\{\{(?:secret|integration-token):$/
const maxTraceDepth = 4

function isPrefixKey(value: string) {
	return (
		value.length >= packageCredentialSlotPrefixMinLength &&
		packageCredentialSlotNamePattern.test(value)
	)
}

function isStringChain(node: AstNode) {
	return (
		node.type === 'TemplateLiteral' ||
		(node.type === 'BinaryExpression' && node.operator === '+')
	)
}

/** A template or `+` chain as text and run-time parts, in order. */
function flattenParts(
	node: AstNode | undefined,
	constants: ReadonlyMap<string, string>,
	parts: Array<Part> = [],
) {
	const inner = unwrapExpression(node)
	if (!inner) return parts
	const push = (part: Part) => {
		const last = parts.at(-1)
		if ('text' in part && last && 'text' in last) last.text += part.text
		else parts.push(part)
	}
	const resolved = resolveStringExpression(inner, constants)
	if (resolved != null) {
		push({ text: resolved })
		return parts
	}
	if (inner.type === 'TemplateLiteral') {
		const expressions = inner.expressions ?? []
		for (const [index, quasi] of (inner.quasis ?? []).entries()) {
			push({ text: templateElementText(quasi) })
			if (index < expressions.length) {
				flattenParts(expressions[index], constants, parts)
			}
		}
		return parts
	}
	if (inner.type === 'BinaryExpression' && inner.operator === '+') {
		flattenParts(inner.left, constants, parts)
		flattenParts(inner.right, constants, parts)
		return parts
	}
	parts.push({ node: inner })
	return parts
}

/** Module-level `const NAME = ['a', 'b']` arrays of string literals. */
function collectStringArrays(body: ReadonlyArray<AstNode>) {
	const arrays = new Map<string, Array<string>>()
	for (const statement of body) {
		const declaration =
			statement.type === 'ExportNamedDeclaration'
				? statement.declaration
				: statement
		if (
			declaration?.type !== 'VariableDeclaration' ||
			declaration.kind !== 'const'
		) {
			continue
		}
		for (const declarator of declaration.declarations ?? []) {
			const name =
				declarator.id?.type === 'Identifier' ? getNodeName(declarator.id) : null
			const init = unwrapExpression(declarator.init)
			if (!name || init?.type !== 'ArrayExpression') continue
			const values: Array<string> = []
			let literalOnly = (init.elements ?? []).length > 0
			for (const element of init.elements ?? []) {
				const value =
					element?.type === 'StringLiteral' ? getNodeName(element) : null
				if (value == null) {
					literalOnly = false
					break
				}
				values.push(value)
			}
			if (literalOnly) arrays.set(name, values)
		}
	}
	return arrays
}

function isFunctionNode(node: AstNode) {
	return (
		node.type === 'ArrowFunctionExpression' ||
		node.type === 'FunctionExpression' ||
		node.type === 'FunctionDeclaration'
	)
}

/**
 * The string array `name` walks: the parameter of a callback passed to a
 * method of that array, or a `for...of` variable over it.
 */
function iteratedArray(
	name: string,
	ancestors: ReadonlyArray<AstNode>,
	arrays: ReadonlyMap<string, Array<string>>,
) {
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const ancestor = ancestors[index]!
		if (ancestor.type === 'ForOfStatement') {
			const declared = ancestor.left?.declarations?.[0]?.id
			if (declared?.type === 'Identifier' && getNodeName(declared) === name) {
				const source = unwrapExpression(ancestor.right)
				return source?.type === 'Identifier'
					? (arrays.get(getNodeName(source) ?? '') ?? null)
					: null
			}
			continue
		}
		if (!isFunctionNode(ancestor)) continue
		const binds = (ancestor.params ?? []).some(
			(param) => param.type === 'Identifier' && getNodeName(param) === name,
		)
		if (!binds) continue
		const call = ancestors[index - 1]
		const receiver = unwrapExpression(call?.callee?.object)
		if (
			(call?.type !== 'CallExpression' &&
				call?.type !== 'OptionalCallExpression') ||
			call.arguments?.[0] !== ancestor ||
			receiver?.type !== 'Identifier'
		) {
			return null
		}
		return arrays.get(getNodeName(receiver) ?? '') ?? null
	}
	return null
}

type Trace = {
	program: AstNode
	constants: ReadonlyMap<string, string>
	defaults: Set<string>
}

function bindingDefault(
	pattern: AstNode | undefined,
	name: string,
): AstNode | null {
	if (
		pattern?.type === 'AssignmentPattern' &&
		pattern.left?.type === 'Identifier' &&
		getNodeName(pattern.left) === name
	) {
		return pattern.right ?? null
	}
	if (pattern?.type !== 'ObjectPattern') return null
	for (const property of pattern.properties ?? []) {
		const found = bindingDefault(property.value as AstNode | undefined, name)
		if (found) return found
	}
	return null
}

/** What `name` is initialized or defaulted to in the scopes around a use. */
function bindingSource(name: string, ancestors: ReadonlyArray<AstNode>) {
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const ancestor = ancestors[index]!
		if (isFunctionNode(ancestor)) {
			for (const param of ancestor.params ?? []) {
				const found = bindingDefault(param, name)
				if (found) return { node: found, ancestors: ancestors.slice(0, index) }
				if (param.type === 'Identifier' && getNodeName(param) === name) {
					return null
				}
			}
			continue
		}
		const statements =
			ancestor.type === 'Program' || ancestor.type === 'BlockStatement'
				? ancestor.body
				: ancestor.type === 'File'
					? ancestor.program?.body
					: null
		if (!Array.isArray(statements)) continue
		for (const statement of statements) {
			if (statement.type !== 'VariableDeclaration') continue
			for (const declarator of statement.declarations ?? []) {
				const scope = ancestors.slice(0, index + 1)
				if (
					declarator.id?.type === 'Identifier' &&
					getNodeName(declarator.id) === name
				) {
					return declarator.init
						? { node: declarator.init, ancestors: scope }
						: null
				}
				const found = bindingDefault(declarator.id, name)
				if (found) return { node: found, ancestors: scope }
			}
		}
	}
	return null
}

function topLevelFunction(program: AstNode, name: string) {
	for (const statement of program.program?.body ?? []) {
		const declaration =
			statement.type === 'ExportNamedDeclaration' ||
			statement.type === 'ExportDefaultDeclaration'
				? statement.declaration
				: statement
		if (
			declaration?.type === 'FunctionDeclaration' &&
			getNodeName(declaration.id) === name
		) {
			return declaration
		}
	}
	return null
}

/** Literal names a run-time name expression falls back to. */
function traceDefaults(
	node: AstNode | undefined,
	ancestors: ReadonlyArray<AstNode>,
	trace: Trace,
	depth = 0,
) {
	const inner = unwrapExpression(node)
	if (!inner || depth > maxTraceDepth) return
	const literal = resolveStringExpression(
		inner,
		constantsWithoutShadows(trace.constants, ancestors),
	)
	if (literal != null) {
		trace.defaults.add(literal)
		return
	}
	switch (inner.type) {
		case 'LogicalExpression':
			if (inner.operator === '??' || inner.operator === '||') {
				traceDefaults(inner.right, ancestors, trace, depth + 1)
			}
			return
		case 'ConditionalExpression': {
			const branches = inner as unknown as {
				consequent?: AstNode
				alternate?: AstNode
			}
			traceDefaults(branches.consequent, ancestors, trace, depth + 1)
			traceDefaults(branches.alternate, ancestors, trace, depth + 1)
			return
		}
		case 'Identifier': {
			const source = bindingSource(getNodeName(inner) ?? '', ancestors)
			if (source) {
				traceDefaults(source.node, source.ancestors, trace, depth + 1)
			}
			return
		}
		case 'CallExpression':
		case 'OptionalCallExpression': {
			if (inner.callee?.type !== 'Identifier') return
			const declared = topLevelFunction(
				trace.program,
				getNodeName(inner.callee) ?? '',
			)
			if (!declared) return
			walkAst(
				declared,
				(child, childAncestors) => {
					if (child.type !== 'ReturnStatement') return
					// A nested function's return is not this function's.
					const owner = [...childAncestors].reverse().find(isFunctionNode)
					if (owner !== declared) return
					traceDefaults(
						child.argument,
						[...childAncestors, child],
						trace,
						depth + 1,
					)
				},
				[trace.program],
			)
			return
		}
		default:
			return
	}
}

/**
 * Prefix keys the package's source states for names it builds at run time,
 * sorted. Empty when the source states none.
 */
export async function inferCredentialPrefixes(files: Record<string, string>) {
	/** Stated as `P-` plus a run-time part; needs `P` as a whole string too. */
	const built = new Set<string>()
	const wholeStrings = new Set<string>()
	const prefixes = new Set<string>()
	await forEachScannableModule(files, (_path, parsed, constants) => {
		if (!parsed) return
		for (const value of constants.values()) wholeStrings.add(value)
		const arrays = collectStringArrays(parsed.program?.body ?? [])
		const trace: Trace = { program: parsed, constants, defaults: new Set() }
		const dynamicPrefix = (
			node: AstNode,
			ancestors: ReadonlyArray<AstNode>,
		) => {
			if (node.type !== 'Identifier') return
			const values = iteratedArray(getNodeName(node) ?? '', ancestors, arrays)
			for (const value of values ?? []) {
				if (isPrefixKey(value)) prefixes.add(value)
			}
		}
		const readChain = (node: AstNode, ancestors: ReadonlyArray<AstNode>) => {
			const scoped = constantsWithoutShadows(constants, ancestors)
			const parts = flattenParts(node, scoped)
			for (const [index, part] of parts.entries()) {
				const next = parts[index + 1]
				if ('node' in part) {
					// `X + '-'`, with or without a run-time part after it.
					const after = index === 0 ? null : parts[index - 1]
					const opensName =
						index === 0 ||
						(after != null &&
							'text' in after &&
							placeholderOpeningOnlyPattern.test(after.text))
					if (
						opensName &&
						next &&
						'text' in next &&
						next.text.startsWith('-')
					) {
						dynamicPrefix(part.node, ancestors)
					}
					if (
						after != null &&
						'text' in after &&
						placeholderOpeningOnlyPattern.test(after.text)
					) {
						traceDefaults(part.node, ancestors, trace)
					}
					continue
				}
				if (!next) continue
				const tail =
					part.text.match(placeholderOpeningPattern)?.[1] ??
					(index === 0 ? part.text : null)
				if (tail?.endsWith('-') && isPrefixKey(tail.slice(0, -1))) {
					built.add(tail.slice(0, -1))
				}
			}
		}
		walkAst(parsed, (node, ancestors) => {
			if (node.type === 'StringLiteral') {
				const value = getNodeName(node)
				if (value != null) wholeStrings.add(value)
				return
			}
			if (isStringChain(node)) {
				const parent = ancestors.at(-1)
				// The outermost chain reads all of its parts.
				if (!parent || !isStringChain(parent)) readChain(node, ancestors)
				return
			}
			if (
				node.type !== 'CallExpression' &&
				node.type !== 'OptionalCallExpression'
			) {
				return
			}
			const callee = getCalleeName(node.callee)
			const argument = node.arguments?.[0]
			if (callee === 'createAuthenticatedFetch' && argument) {
				const scoped = constantsWithoutShadows(constants, ancestors)
				if (resolveStringExpression(argument, scoped) == null) {
					traceDefaults(argument, [...ancestors, node], trace)
				}
				return
			}
			if (callee === 'startsWith' && argument) {
				const stated = resolveStringExpression(
					argument,
					constantsWithoutShadows(constants, ancestors),
				)
				if (stated?.endsWith('-') && isPrefixKey(stated.slice(0, -1))) {
					built.add(stated.slice(0, -1))
				}
			}
		})
		for (const value of trace.defaults) {
			if (isPrefixKey(value)) prefixes.add(value)
		}
	})
	for (const prefix of built) {
		if (wholeStrings.has(prefix)) prefixes.add(prefix)
	}
	// A prefix another inferred prefix already covers adds nothing.
	const sorted = [...prefixes].sort()
	return sorted.filter(
		(prefix) =>
			!sorted.some(
				(other) => other !== prefix && prefix.startsWith(`${other}-`),
			),
	)
}
