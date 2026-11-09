import type { ModuleAstNode } from '#worker/module-source.ts'

/**
 * A top-level `const` an export's types reach through `typeof Name`, such as
 * a schema behind `type Params = Infer<typeof ParamsSchema>`.
 */
export type LocalValueDeclaration = {
	name: string
	source: string
	/** Package path of the module that declares it, for resolving its imports. */
	modulePath: string | null
	/** Verbatim declaration source, used when the initializer is not a schema. */
	definition: string
	declarator: ModuleAstNode
	init: ModuleAstNode | null
}

const maxSchemaDepth = 6
const maxSchemaFields = 200
const maxValueDefinitionChars = 4_000
const maxUnknownSnippetChars = 120

function getNodeType(node: unknown) {
	if (!node || typeof node !== 'object') return null
	const type = (node as { type?: unknown }).type
	return typeof type === 'string' ? type : null
}

function getNodeRange(node: unknown) {
	const { start, end } = (node ?? {}) as { start?: unknown; end?: unknown }
	return typeof start === 'number' && typeof end === 'number'
		? { start, end }
		: null
}

function sliceNode(source: string, node: unknown) {
	const range = getNodeRange(node)
	return range ? source.slice(range.start, range.end).trim() : null
}

function readName(node: unknown) {
	const name = (node as { name?: unknown } | null)?.name
	return typeof name === 'string' && name ? name : null
}

function readStringLiteral(node: unknown) {
	if (getNodeType(node) === 'StringLiteral') {
		const value = (node as { value?: unknown }).value
		return typeof value === 'string' ? value : null
	}
	if (getNodeType(node) === 'TemplateLiteral') {
		const quasis = (
			node as { quasis?: Array<{ value?: { cooked?: unknown } }> }
		).quasis
		if (quasis?.length === 1) {
			const cooked = quasis[0]?.value?.cooked
			return typeof cooked === 'string' ? cooked : null
		}
	}
	return null
}

function isFunctionLikeInit(init: unknown) {
	const type = getNodeType(init)
	return (
		type === 'ArrowFunctionExpression' ||
		type === 'FunctionExpression' ||
		type === 'ClassExpression'
	)
}

/** Finds the const `name` refers to in the module at `fromPath`, following package-relative imports. */
export type ResolveLocalValue = (
	fromPath: string | null,
	name: string,
) => LocalValueDeclaration | undefined

export function collectLocalValueDeclarations(
	source: string,
	body: Array<ModuleAstNode>,
	modulePath: string | null = null,
) {
	const declarations = new Map<string, LocalValueDeclaration>()
	for (const statement of body) {
		const isExport = statement.type === 'ExportNamedDeclaration'
		const declaration = isExport
			? ((statement as { declaration?: unknown }).declaration as
					| ModuleAstNode
					| undefined)
			: statement
		if (getNodeType(declaration) !== 'VariableDeclaration') continue
		const declarators = (declaration as { declarations?: unknown }).declarations
		if (!Array.isArray(declarators)) continue
		for (const declarator of declarators as Array<ModuleAstNode>) {
			const id = (declarator as { id?: unknown }).id
			if (getNodeType(id) !== 'Identifier') continue
			const name = readName(id)
			const init = ((declarator as { init?: unknown }).init ??
				null) as ModuleAstNode | null
			const hasTypeAnnotation =
				(id as { typeAnnotation?: unknown }).typeAnnotation != null
			if (!name || declarations.has(name)) continue
			if (init ? isFunctionLikeInit(init) : !hasTypeAnnotation) continue
			const definition =
				declarators.length === 1
					? sliceNode(source, isExport ? statement : declaration)
					: `${String((declaration as { kind?: unknown }).kind ?? 'const')} ${sliceNode(source, declarator) ?? ''}`
			if (!definition) continue
			declarations.set(name, {
				name,
				source,
				modulePath,
				definition: definition.replace(/\s*;\s*$/, ''),
				declarator,
				init,
			})
		}
	}
	return declarations
}

/** Local `const` names an initializer reads (excluding property keys). */
export function collectValueReferenceNames(
	node: unknown,
	localValues: Map<string, LocalValueDeclaration>,
) {
	const names: Array<string> = []
	const seen = new Set<object>()
	function visit(current: unknown, parentKey: string | null, parent: unknown) {
		if (!current || typeof current !== 'object' || seen.has(current)) return
		seen.add(current)
		if (getNodeType(current) === 'Identifier') {
			const isPropertyKey =
				(parentKey === 'key' &&
					getNodeType(parent) === 'ObjectProperty' &&
					(parent as { computed?: unknown }).computed !== true) ||
				(parentKey === 'property' &&
					getNodeType(parent) === 'MemberExpression' &&
					(parent as { computed?: unknown }).computed !== true)
			const name = readName(current)
			if (!isPropertyKey && name && localValues.has(name)) {
				if (!names.includes(name)) names.push(name)
			}
			return
		}
		for (const [key, value] of Object.entries(current)) {
			if (
				key === 'loc' ||
				key === 'leadingComments' ||
				key === 'trailingComments' ||
				key === 'innerComments' ||
				key === 'extra' ||
				key === 'typeAnnotation'
			) {
				continue
			}
			if (Array.isArray(value)) {
				for (const item of value) visit(item, key, current)
			} else {
				visit(value, key, current)
			}
		}
	}
	visit(node, null, null)
	return names
}

type SchemaShape = {
	type: string
	optional: boolean
	description: string | null
	strict: boolean
}

type SchemaContext = {
	resolveValue: ResolveLocalValue
	modulePath: string | null
	visiting: Set<string>
	fields: number
}

const primitiveSchemaTypes: Record<string, string> = {
	any: 'any',
	bigint: 'bigint',
	boolean: 'boolean',
	date: 'Date',
	email: 'string',
	int: 'number',
	integer: 'number',
	never: 'never',
	null: 'null',
	number: 'number',
	string: 'string',
	symbol: 'symbol',
	undefined: 'undefined',
	unknown: 'unknown',
	url: 'string',
	uuid: 'string',
	void: 'void',
}

/** Chained methods that change the accepted input shape; any other chained method keeps it (`.pipe`, `.refine`, `.transform`, `.min`, …). */
const shapeChangingChainMethods = new Set([
	'and',
	'catchall',
	'deepPartial',
	'element',
	'extend',
	'keyof',
	'merge',
	'omit',
	'partial',
	'pick',
	'promise',
	'removeDefault',
	'required',
	'safeExtend',
	'unwrap',
])

function shape(
	type: string,
	overrides: Partial<SchemaShape> = {},
): SchemaShape {
	return {
		type,
		optional: false,
		description: null,
		strict: false,
		...overrides,
	}
}

function wrapUnionMember(type: string) {
	return /[|&]/.test(type) && !type.startsWith('{') ? `(${type})` : type
}

function unknownSnippet(source: string, node: unknown) {
	const text = (sliceNode(source, node) ?? '')
		.replace(/\s+/g, ' ')
		.replace(/\*\//g, '* /')
	const snippet =
		text.length > maxUnknownSnippetChars
			? `${text.slice(0, maxUnknownSnippetChars)}…`
			: text
	return snippet ? `unknown /* ${snippet} */` : 'unknown'
}

function readCallee(node: unknown) {
	const callee = (node as { callee?: unknown }).callee
	if (getNodeType(callee) === 'Identifier') {
		return { name: readName(callee), receiver: null }
	}
	if (
		getNodeType(callee) === 'MemberExpression' &&
		(callee as { computed?: unknown }).computed !== true
	) {
		return {
			name: readName((callee as { property?: unknown }).property),
			receiver: (callee as { object?: unknown }).object ?? null,
		}
	}
	return { name: null, receiver: null }
}

function isSchemaReceiver(receiver: unknown, context: SchemaContext) {
	const type = getNodeType(receiver)
	if (type === 'CallExpression') return true
	return (
		type === 'Identifier' &&
		context.resolveValue(context.modulePath, readName(receiver) ?? '') != null
	)
}

function unwrapExpression(node: unknown): unknown {
	const type = getNodeType(node)
	if (
		type === 'TSAsExpression' ||
		type === 'TSSatisfiesExpression' ||
		type === 'TSTypeAssertion' ||
		type === 'TSNonNullExpression' ||
		type === 'ParenthesizedExpression'
	) {
		return unwrapExpression((node as { expression?: unknown }).expression)
	}
	return node
}

/** Array literal elements, through `as const` and through a const holding the array. */
function readArrayElements(
	node: unknown,
	context?: SchemaContext,
): { elements: Array<unknown>; source: string | null } | null {
	const unwrapped = unwrapExpression(node)
	if (getNodeType(unwrapped) === 'ArrayExpression') {
		return {
			elements: (unwrapped as { elements?: Array<unknown> }).elements ?? [],
			source: null,
		}
	}
	if (getNodeType(unwrapped) !== 'Identifier' || !context) return null
	const declaration = context.resolveValue(
		context.modulePath,
		readName(unwrapped) ?? '',
	)
	const init = unwrapExpression(declaration?.init)
	if (!declaration || getNodeType(init) !== 'ArrayExpression') return null
	return {
		elements: (init as { elements?: Array<unknown> }).elements ?? [],
		source: declaration.source,
	}
}

function readObjectOptionString(node: unknown, key: string) {
	if (getNodeType(node) !== 'ObjectExpression') return null
	for (const property of (node as { properties?: Array<unknown> }).properties ??
		[]) {
		if (getNodeType(property) !== 'ObjectProperty') continue
		const propertyKey = (property as { key?: unknown }).key
		const name = readName(propertyKey) ?? readStringLiteral(propertyKey)
		if (name === key) {
			return readStringLiteral((property as { value?: unknown }).value)
		}
	}
	return null
}

function readPropertyJsDoc(property: unknown) {
	const comments = (property as { leadingComments?: Array<unknown> })
		.leadingComments
	if (!Array.isArray(comments)) return null
	for (const comment of [...comments].reverse()) {
		const { type, value } = comment as { type?: unknown; value?: unknown }
		if (type !== 'CommentBlock' || typeof value !== 'string') continue
		if (!value.startsWith('*')) continue
		const text = value
			.replace(/^\*/, '')
			.split('\n')
			.map((line) => line.replace(/^\s*\*\s?/, '').trim())
			.filter(Boolean)
			.join(' ')
		return text || null
	}
	return null
}

function formatPropertyKey(key: unknown) {
	const name =
		getNodeType(key) === 'Identifier' ? readName(key) : readStringLiteral(key)
	if (name == null) {
		if (getNodeType(key) === 'NumericLiteral') {
			return String((key as { value?: unknown }).value)
		}
		return null
	}
	return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)
}

function renderObjectShape(
	node: unknown,
	source: string,
	depth: number,
	context: SchemaContext,
) {
	const properties = (node as { properties?: Array<unknown> }).properties ?? []
	const lines: Array<string> = []
	for (const [index, property] of properties.entries()) {
		if (context.fields >= maxSchemaFields) {
			lines.push(`// … ${properties.length - index} more field(s)`)
			break
		}
		context.fields += 1
		if (getNodeType(property) !== 'ObjectProperty') {
			lines.push(`// ${unknownSnippet(source, property)}`)
			continue
		}
		const key =
			(property as { computed?: unknown }).computed === true
				? null
				: formatPropertyKey((property as { key?: unknown }).key)
		if (!key) {
			lines.push(`// ${unknownSnippet(source, property)}`)
			continue
		}
		const value = (property as { value?: unknown }).value
		const resolved =
			resolveSchemaShape(value, source, depth + 1, context) ??
			shape(unknownSnippet(source, value))
		const description = readPropertyJsDoc(property) ?? resolved.description
		if (description) {
			lines.push(`/** ${description.replace(/\*\//g, '* /')} */`)
		}
		lines.push(`${key}${resolved.optional ? '?' : ''}: ${resolved.type}`)
	}
	if (lines.length === 0) return '{}'
	return `{\n${lines.map((line) => `\t${line.replace(/\n/g, '\n\t')}`).join('\n')}\n}`
}

function resolveSchemaList(
	nodes: Array<unknown>,
	source: string,
	depth: number,
	context: SchemaContext,
) {
	return nodes.map(
		(member) =>
			(
				resolveSchemaShape(member, source, depth + 1, context) ??
				shape(unknownSnippet(source, member))
			).type,
	)
}

function resolveChainCall(input: {
	name: string
	args: Array<unknown>
	base: SchemaShape
	source: string
	depth: number
	context: SchemaContext
}): SchemaShape | null {
	const { name, args, base } = input
	switch (name) {
		case 'optional':
		case 'default':
		case 'catch':
		case 'prefault':
			return { ...base, optional: true }
		case 'nullable':
			return { ...base, type: `${wrapUnionMember(base.type)} | null` }
		case 'nullish':
			return {
				...base,
				optional: true,
				type: `${wrapUnionMember(base.type)} | null`,
			}
		case 'array':
			return { ...base, type: `Array<${base.type}>`, strict: false }
		case 'describe':
			return { ...base, description: readStringLiteral(args[0]) }
		case 'strict':
			return { ...base, strict: true }
		case 'or': {
			const [other] = resolveSchemaList(
				args.slice(0, 1),
				input.source,
				input.depth,
				input.context,
			)
			return other ? { ...base, type: `${base.type} | ${other}` } : base
		}
		default:
			return shapeChangingChainMethods.has(name) ? null : base
	}
}

function resolveBuilderCall(input: {
	name: string
	args: Array<unknown>
	source: string
	depth: number
	context: SchemaContext
}): SchemaShape | null {
	const { args, source, depth, context } = input
	const name = input.name.replace(/_$/, '')
	const primitive = primitiveSchemaTypes[name]
	if (primitive) return shape(primitive)
	const resolveArg = (node: unknown) =>
		resolveSchemaShape(node, source, depth + 1, context)
	const resolveArgOrUnknown = (node: unknown) =>
		resolveArg(node) ?? shape(unknownSnippet(source, node))
	switch (name) {
		case 'literal':
			return shape(sliceNode(source, args[0]) ?? 'unknown')
		case 'object':
		case 'strictObject':
		case 'looseObject':
		case 'Object': {
			if (getNodeType(args[0]) !== 'ObjectExpression') return null
			return shape(renderObjectShape(args[0], source, depth, context), {
				strict:
					name === 'strictObject' ||
					readObjectOptionString(args[1], 'unknownKeys') === 'error' ||
					(getNodeType(args[1]) === 'ObjectExpression' &&
						sliceNode(source, args[1])?.includes(
							'additionalProperties: false',
						) === true),
			})
		}
		case 'array':
		case 'Array': {
			const item = resolveArg(args[0])
			return item ? shape(`Array<${item.type}>`) : null
		}
		case 'optional':
		case 'Optional':
		case 'defaulted':
		case 'exactOptional':
			return { ...resolveArgOrUnknown(args[0]), optional: true }
		case 'nullable':
		case 'Nullable': {
			const inner = resolveArgOrUnknown(args[0])
			return { ...inner, type: `${wrapUnionMember(inner.type)} | null` }
		}
		case 'nullish': {
			const inner = resolveArgOrUnknown(args[0])
			return {
				...inner,
				optional: true,
				type: `${wrapUnionMember(inner.type)} | null`,
			}
		}
		case 'lazy': {
			const getter = unwrapExpression(args[0])
			const type = getNodeType(getter)
			if (type !== 'ArrowFunctionExpression') return null
			const body = (getter as { body?: unknown }).body
			return getNodeType(body) === 'BlockStatement' ? null : resolveArg(body)
		}
		case 'union':
		case 'Union':
		case 'variant':
		case 'discriminatedUnion': {
			const list = args
				.map((arg) => readArrayElements(arg, context))
				.find((elements) => elements != null)
			if (list?.source && list.source !== source) return null
			const members = list?.elements ?? args
			if (members.length === 0) return null
			return shape(
				resolveSchemaList(members, source, depth, context)
					.map(wrapUnionMember)
					.join(' | '),
			)
		}
		case 'enum':
		case 'picklist': {
			const list = readArrayElements(args[0], context)
			if (!list || list.elements.length === 0) return null
			const literals = list.elements.map((element) =>
				sliceNode(list.source ?? source, element),
			)
			if (literals.some((literal) => !literal)) return null
			return shape(literals.join(' | '))
		}
		case 'tuple':
		case 'Tuple': {
			const list = readArrayElements(args[0])
			if (!list) return null
			return shape(
				`[${resolveSchemaList(list.elements, source, depth, context).join(', ')}]`,
			)
		}
		case 'record':
		case 'Record': {
			const [keyNode, valueNode] = args.length >= 2 ? args : [null, args[0]]
			const key = keyNode ? resolveArg(keyNode)?.type : 'string'
			const value = resolveArg(valueNode)
			return value ? shape(`Record<${key ?? 'string'}, ${value.type}>`) : null
		}
		case 'pipe': {
			const base = resolveArg(args[0])
			if (!base) return null
			const descriptionAction = args
				.slice(1)
				.find((action) => readCallee(action).name === 'description')
			const description = descriptionAction
				? readStringLiteral(
						(descriptionAction as { arguments?: Array<unknown> })
							.arguments?.[0],
					)
				: null
			return description ? { ...base, description } : base
		}
		default:
			return null
	}
}

function resolveSchemaShape(
	node: unknown,
	source: string,
	depth: number,
	context: SchemaContext,
): SchemaShape | null {
	if (depth > maxSchemaDepth) return shape('unknown /* nested too deep */')
	const type = getNodeType(node)
	if (
		type === 'TSAsExpression' ||
		type === 'TSSatisfiesExpression' ||
		type === 'TSNonNullExpression' ||
		type === 'ParenthesizedExpression'
	) {
		return resolveSchemaShape(
			(node as { expression?: unknown }).expression,
			source,
			depth,
			context,
		)
	}
	if (type === 'Identifier') {
		const name = readName(node)
		const declaration = name
			? context.resolveValue(context.modulePath, name)
			: undefined
		if (!name || !declaration?.init) return null
		const key = `${declaration.modulePath ?? ''}#${declaration.name}`
		if (context.visiting.has(key)) {
			return shape(`unknown /* recursive: ${name} */`)
		}
		const outerModulePath = context.modulePath
		context.visiting.add(key)
		context.modulePath = declaration.modulePath
		try {
			return resolveSchemaShape(
				declaration.init,
				declaration.source,
				depth + 1,
				context,
			)
		} finally {
			context.visiting.delete(key)
			context.modulePath = outerModulePath
		}
	}
	if (type !== 'CallExpression') return null
	const { name, receiver } = readCallee(node)
	if (!name) return null
	const args = (node as { arguments?: Array<unknown> }).arguments ?? []
	if (receiver && isSchemaReceiver(receiver, context)) {
		const base = resolveSchemaShape(receiver, source, depth, context)
		if (!base) return null
		return resolveChainCall({ name, args, base, source, depth, context })
	}
	return resolveBuilderCall({ name, args, source, depth, context })
}

function capDefinition(definition: string) {
	if (definition.length <= maxValueDefinitionChars) return definition
	const cut = definition.lastIndexOf('\n', maxValueDefinitionChars)
	const kept = definition.slice(0, cut > 0 ? cut : maxValueDefinitionChars)
	return `${kept}\n// … truncated (${definition.length - kept.length} more characters)`
}

/**
 * Renders a `typeof Name` const for export detail. Schema builder
 * initializers (`object({...})`, `z.object({...}).strict()`, valibot-style
 * `pipe(...)`) expand to the field shape callers pass; anything else is the
 * verbatim declaration. Schema consts imported from other package files are
 * followed; unreadable parts render as `unknown`. Both are bounded for huge or recursive schemas.
 */
export function describeReferencedValue(input: {
	declaration: LocalValueDeclaration
	resolveValue: ResolveLocalValue
}) {
	const { declaration } = input
	const context: SchemaContext = {
		resolveValue: input.resolveValue,
		modulePath: declaration.modulePath,
		visiting: new Set([`${declaration.modulePath ?? ''}#${declaration.name}`]),
		fields: 0,
	}
	const resolved = declaration.init
		? resolveSchemaShape(declaration.init, declaration.source, 0, context)
		: null
	if (!resolved) {
		return {
			resolved: false,
			definition: capDefinition(declaration.definition),
		}
	}
	const notes = [
		resolved.optional ? 'may be undefined' : null,
		resolved.strict ? 'unknown keys rejected' : null,
	].filter(Boolean)
	const header = `// typeof ${declaration.name} resolves to this schema input${notes.length > 0 ? ` (${notes.join('; ')})` : ''}:`
	const description = resolved.description
		? `\n/** ${resolved.description.replace(/\*\//g, '* /')} */`
		: ''
	return {
		resolved: true,
		definition: capDefinition(`${header}${description}\n${resolved.type}`),
	}
}
