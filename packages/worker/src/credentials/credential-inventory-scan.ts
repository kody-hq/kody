/**
 * Reads every credential placeholder out of a package's published modules,
 * with where each one is placed on a request, plus the package's declared
 * `kody.credentials` slots. Unlike codemod 0010, a placeholder that matches a
 * declared slot still counts: rescans use these counts to certify that the
 * old placeholder lane is gone.
 *
 * A placeholder bound to a variable is followed to each place the variable is
 * used, so `const key = '{{secret:x}}'` then `headers: { 'x-api-key': key }`
 * counts as a header. The binding itself is recorded as `binding`. A name
 * resolves to its nearest declaration, so a parameter or local that shadows a
 * placeholder binding is not followed, and a binding that is reassigned is
 * not followed either. Placeholder counts are source occurrences: following a
 * binding adds references, not occurrences.
 */
import {
	type PackageCredentialSlot,
	type PackageCredentialSlotKind,
} from '#worker/package-registry/types.ts'
import {
	type AstNode,
	createModuleConstantsReader,
	findPlaceholderMatches,
	getCalleeName,
	getNodeName,
	listScannableModulePaths,
	parseModule,
	type PlaceholderMatch,
	type PlaceholderMatchKind,
	resolveStringExpression,
	templateElementText,
	walkAst,
} from './module-placeholder-scan.ts'

/**
 * Where a request a placeholder fills is sent, read from a literal fetch URL:
 * a login or token exchange path, any other path, or not known statically.
 */
export type CredentialEndpoint = 'login' | 'other' | 'unknown'

/**
 * Why a placeholder that is not on a request shape sits where it does. Keys
 * and callee names are package identifiers, never credential names or values.
 */
export type CredentialOtherContext =
	/** A property of an object passed to a call or constructor (SDK options). */
	| 'sdk-option'
	/** A property of an object that is not passed anywhere directly. */
	| 'object'
	/** Passed straight to a function. */
	| 'argument'
	| 'return'
	| 'assignment'
	| 'array'
	| 'default-param'
	| 'comparison'
	/** Bound to a variable that is never read. */
	| 'unused-binding'
	/** Bound to a variable that is reassigned, so its reads are not followed. */
	| 'reassigned-binding'
	/** A piece of a template whose other parts are computed. */
	| 'template-computed'
	/** In a URL host, which the gateway never fills. */
	| 'url-host'
	/** A module that did not parse, read as plain text. */
	| 'unparsed'
	/** Returned from a status/help/docs/usage function: package help text. */
	| 'display'
	| 'other'

/**
 * Header formats, query params, and identifiers are kept only in the safe
 * shapes a credential's `inject` can take or as plain identifiers; anything
 * else is counted by type without its text.
 */
export type CredentialPlacement =
	| { type: 'header'; name: string; format: string }
	| { type: 'query'; param: string }
	| { type: 'header-custom' }
	| { type: 'basic' }
	| { type: 'path' }
	/** The whole URL, or the URL up to its path, comes from the placeholder. */
	| { type: 'url' }
	| { type: 'body'; field: string | null; endpoint: CredentialEndpoint }
	/** Key material for a signature (HMAC, JWT, `crypto.subtle.sign`). */
	| { type: 'signing' }
	/** Bound to a variable; each read is recorded as its own reference. */
	| { type: 'binding' }
	| {
			type: 'other'
			context: CredentialOtherContext
			key: string | null
			callee: string | null
	  }

export type CredentialPlacementType = CredentialPlacement['type']

/**
 * True when a vault placeholder may reach the fetch gateway or a
 * credential-mapped call. Fails closed: only display sites (values returned
 * from status/help/docs/usage), unused bindings, and bindings (whose reads are
 * recorded separately) are false, so a placeholder parked in an object,
 * array, or helper return that later feeds a request still fails the stamp.
 */
export function isVaultCredentialUsePlacement(
	placement: CredentialPlacement,
): boolean {
	switch (placement.type) {
		case 'header':
		case 'header-custom':
		case 'query':
		case 'basic':
		case 'path':
		case 'url':
		case 'body':
		case 'signing':
			return true
		case 'binding':
			// Reads of the binding are recorded as their own placements.
			return false
		case 'other':
			switch (placement.context) {
				case 'display':
				case 'unused-binding':
					return false
				case 'sdk-option':
				case 'argument':
				case 'url-host':
				case 'unparsed':
				case 'object':
				case 'return':
				case 'assignment':
				case 'array':
				case 'default-param':
				case 'comparison':
				case 'reassigned-binding':
				case 'template-computed':
				case 'other':
					return true
				default: {
					const exhaustive: never = placement.context
					return exhaustive
				}
			}
		default: {
			const exhaustive: never = placement
			return exhaustive
		}
	}
}

export const credentialPlacementTypes = [
	'header',
	'query',
	'header-custom',
	'basic',
	'path',
	'url',
	'body',
	'signing',
	'binding',
	'other',
] as const satisfies ReadonlyArray<CredentialPlacementType>

export const credentialOtherContexts = [
	'sdk-option',
	'object',
	'argument',
	'return',
	'assignment',
	'array',
	'default-param',
	'comparison',
	'unused-binding',
	'reassigned-binding',
	'template-computed',
	'url-host',
	'unparsed',
	'display',
	'other',
] as const satisfies ReadonlyArray<CredentialOtherContext>

export type CredentialReference = {
	nameKind: 'secret' | 'integration'
	name: string
	/** Literal `|scope=` suffix, or null. */
	scope: string | null
	placement: CredentialPlacement
}

export type CredentialSlotDeclaration = {
	name: string
	kind?: PackageCredentialSlotKind
	provider: string
}

export type VaultPlaceholderUse = {
	provider: string
	placement: CredentialPlacement
}

export type PackageCredentialScan = {
	/** Every placeholder occurrence, by kind, slot or no slot. */
	placeholders: Record<PlaceholderMatchKind, number>
	references: Array<CredentialReference>
	/** Where each `{{secret/provider:ref}}` vault placeholder sits. */
	vaultPlacements: Array<CredentialPlacement>
	/**
	 * Each vault placeholder with its literal provider id (as written; not
	 * normalized), in the same order as `vaultPlacements`.
	 */
	vaultUses: Array<VaultPlaceholderUse>
	/** `secretJwtSign` calls: signatures made with a saved secret by name. */
	jwtSignCalls: number
	/**
	 * Secret names passed as `private_key_secret_name` (or aliases) to
	 * `secretJwtSign`. Used so hints can skip names already declared as slots.
	 */
	jwtSignSecretNames: Array<string>
	slots: Array<CredentialSlotDeclaration>
	/** Modules that did not parse and were read as plain text. */
	unparsedModules: number
}

const headerNamePattern = /^[A-Za-z0-9-]{1,64}$/
/** `{value}` alone or after one auth scheme word, such as `Bearer {value}`. */
const headerFormatPattern = /^(?:[A-Za-z][A-Za-z0-9._-]{0,31} )?\{value\}$/
const queryParamBeforePattern = /[?&]([A-Za-z0-9._-]{1,64})=$/
const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$-]{0,63}$/
/** Path words of a login, session, or token exchange endpoint. */
const loginPathPattern =
	/(?:^|[/_.-])(?:login|log-in|signin|sign-in|sign_in|session|sessions|auth|authenticate|authorize|token|tokens|oauth2?)(?:$|[/_.?-])/i

const signingOutputEncodings = new Set([
	'hex',
	'base64',
	'base64url',
	'latin1',
	'binary',
])

/**
 * Calls that take signing key material, with which of the call's arguments
 * holds the key. Payload and option arguments are classified like any other
 * call argument.
 */
const signingKeyArgument = new Map<
	string,
	(args: ReadonlyArray<AstNode>) => number
>([
	// crypto.subtle.importKey(format, keyData, …)
	['importKey', () => 1],
	// crypto.createHmac(algorithm, key)
	['createHmac', () => 1],
	// hmac(hash, key, message) or hmac(key, message)
	['hmac', (args) => (args.length >= 3 ? 1 : 0)],
	// CryptoJS.HmacSHA256(message, key)
	['HmacSHA1', () => 1],
	['HmacSHA256', () => 1],
	['HmacSHA512', () => 1],
	['sign', signKeyArgument],
	['signJwt', () => 1],
	['jwtSign', () => 1],
	// createSigner({ key })
	['createSigner', () => 0],
	['setSigningKey', () => 0],
])

/**
 * `signer.sign(key)`, `signer.sign(key, 'hex')`, and
 * `new SignJWT(payload).sign(key, options)` take the key first;
 * `jwt.sign(payload, key)` and `crypto.subtle.sign(algorithm, key, data)`
 * take it second.
 */
function signKeyArgument(args: ReadonlyArray<AstNode>) {
	if (args.length === 1) return 0
	if (args.length === 2 && args[0]?.type !== 'ObjectExpression') {
		const second = args[1]
		const encoding =
			second?.type === 'StringLiteral' ? getNodeName(second) : null
		if (
			second?.type === 'ObjectExpression' ||
			(encoding != null && signingOutputEncodings.has(encoding))
		) {
			return 0
		}
	}
	return 1
}

const transparentExpressionTypes = new Set([
	'ParenthesizedExpression',
	'TSAsExpression',
	'TSSatisfiesExpression',
	'TSNonNullExpression',
	'TSTypeAssertion',
])

const loopScopeTypes = new Set([
	'ForStatement',
	'ForInStatement',
	'ForOfStatement',
])

const functionTypes = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression',
	'ObjectMethod',
	'ClassMethod',
	'ClassPrivateMethod',
])

export function emptyPlaceholderCounts(): Record<PlaceholderMatchKind, number> {
	return {
		secret: 0,
		'secret-basic': 0,
		'integration-token': 0,
		vault: 0,
		computed: 0,
	}
}

export function scanPackageCredentials(input: {
	files: Record<string, string>
	slots: Record<string, PackageCredentialSlot> | undefined
}): PackageCredentialScan {
	const scan: PackageCredentialScan = {
		placeholders: emptyPlaceholderCounts(),
		references: [],
		vaultPlacements: [],
		vaultUses: [],
		jwtSignCalls: 0,
		jwtSignSecretNames: [],
		slots: Object.entries(input.slots ?? {}).map(([name, slot]) => ({
			name,
			...(slot.kind ? { kind: slot.kind } : {}),
			provider: slot.provider ?? name,
		})),
		unparsedModules: 0,
	}
	const modulePaths = listScannableModulePaths(input.files).sort()
	const parsedModules = new Map(
		modulePaths.map((path) => [path, parseModule(input.files[path]!)]),
	)
	const readConstants = createModuleConstantsReader(parsedModules)
	for (const path of modulePaths) {
		const parsed = parsedModules.get(path)
		if (parsed) {
			scanParsedModule(parsed, readConstants(path), scan)
		} else {
			scan.unparsedModules += 1
			recordPlaceholders(
				input.files[path]!,
				() => otherPlacement('unparsed'),
				scan,
			)
		}
	}
	return scan
}

function otherPlacement(
	context: CredentialOtherContext,
	key: string | null = null,
	callee: string | null = null,
): CredentialPlacement {
	return { type: 'other', context, key, callee }
}

function countPlaceholders(texts: Iterable<string>) {
	const counts = emptyPlaceholderCounts()
	for (const text of texts) {
		for (const match of findPlaceholderMatches(text)) counts[match.kind] += 1
	}
	return counts
}

/**
 * Records each placeholder in `text`. `counted` holds, by kind, how many of
 * them came from a bound variable and were counted at its declaration: they
 * add placements but are not counted again.
 */
function recordPlaceholders(
	text: string,
	placementOf: (match: PlaceholderMatch) => CredentialPlacement,
	scan: PackageCredentialScan,
	counted: Record<PlaceholderMatchKind, number> = emptyPlaceholderCounts(),
) {
	const skip = { ...counted }
	for (const match of findPlaceholderMatches(text)) {
		if (skip[match.kind] > 0) skip[match.kind] -= 1
		else scan.placeholders[match.kind] += 1
		if (match.kind === 'vault') {
			const placement = placementOf(match)
			scan.vaultPlacements.push(placement)
			if (match.provider != null) {
				scan.vaultUses.push({ provider: match.provider, placement })
			}
			continue
		}
		const nameKind =
			match.kind === 'secret' || match.kind === 'secret-basic'
				? 'secret'
				: match.kind === 'integration-token'
					? 'integration'
					: null
		if (!nameKind) continue
		const placement = withoutCredentialNames(placementOf(match), match.names)
		for (const name of match.names) {
			scan.references.push({ nameKind, name, scope: match.scope, placement })
		}
	}
}

/** A key or callee that spells a credential name is dropped, not stored. */
function withoutCredentialNames(
	placement: CredentialPlacement,
	names: ReadonlyArray<string>,
): CredentialPlacement {
	const lowered = new Set(names.map((name) => name.toLowerCase()))
	const keep = (value: string | null) =>
		value != null && lowered.has(value.toLowerCase()) ? null : value
	switch (placement.type) {
		case 'body':
			return { ...placement, field: keep(placement.field) }
		case 'other':
			return {
				...placement,
				key: keep(placement.key),
				callee: keep(placement.callee),
			}
		default:
			return placement
	}
}

type Binding = { text: string; scope: AstNode; reassigned: boolean }

/**
 * Lexical scopes and the variables bound to a placeholder string in them:
 * the module's constants (top-level and imported) plus `const`, `let`, and
 * `var` declarations at any depth. Every declared name is tracked, so lookup
 * stops at the nearest declaration even when it holds no placeholder.
 */
type ModuleScopes = {
	declared: Map<AstNode, Set<string>>
	bindings: Map<AstNode, Map<string, Binding>>
}

function collectScopes(
	parsed: AstNode,
	constants: ReadonlyMap<string, string>,
): ModuleScopes {
	const declared = new Map<AstNode, Set<string>>()
	const bindings = new Map<AstNode, Map<string, Binding>>()
	const declare = (scope: AstNode, name: string | null) => {
		if (!name) return
		const names = declared.get(scope) ?? new Set<string>()
		names.add(name)
		declared.set(scope, names)
	}
	const reassigned = new Map<AstNode, Set<string>>()
	const bind = (scope: AstNode, name: string, text: string) => {
		const scoped = bindings.get(scope) ?? new Map<string, Binding>()
		scoped.set(name, {
			text,
			scope,
			reassigned: reassigned.get(scope)?.has(name) === true,
		})
		bindings.set(scope, scoped)
	}
	const declarators: Array<{
		scope: AstNode
		name: string
		init: AstNode | undefined
		isConst: boolean
		ancestors: ReadonlyArray<AstNode>
	}> = []
	for (const statement of parsed.program?.body ?? []) {
		if (statement.type !== 'ImportDeclaration') continue
		for (const specifier of statement.specifiers ?? []) {
			declare(parsed, getNodeName(specifier.local))
		}
	}
	walkAst(parsed, (node, ancestors) => {
		if (functionTypes.has(node.type)) {
			if (node.type === 'FunctionDeclaration') {
				declare(blockScope(ancestors, parsed), getNodeName(node.id))
			} else if (node.id) {
				declare(node, getNodeName(node.id))
			}
			for (const param of node.params ?? []) {
				for (const name of boundNames(param)) declare(node, name)
			}
			return
		}
		if (node.type === 'ClassDeclaration') {
			declare(blockScope(ancestors, parsed), getNodeName(node.id))
			return
		}
		if (node.type === 'CatchClause') {
			for (const name of boundNames(node.param)) declare(node, name)
			return
		}
		if (node.type !== 'VariableDeclarator') return
		const declaration = ancestors.at(-1)
		const scope =
			declaration?.kind === 'var'
				? functionScope(ancestors, parsed)
				: blockScope(ancestors, parsed)
		for (const name of boundNames(node.id)) declare(scope, name)
		if (node.id?.type !== 'Identifier') return
		const name = getNodeName(node.id)
		if (!name) return
		declarators.push({
			scope,
			name,
			init: node.init,
			isConst: declaration?.kind === 'const',
			ancestors: [...ancestors],
		})
	})
	const scopes = { declared, bindings }
	walkAst(parsed, (node, ancestors) => {
		const target =
			node.type === 'AssignmentExpression'
				? node.left
				: node.type === 'UpdateExpression'
					? node.argument
					: null
		if (target?.type !== 'Identifier') return
		const name = getNodeName(target)
		const scope = declaringScope(scopes, name, ancestors)
		if (!scope || !name) return
		const names = reassigned.get(scope) ?? new Set<string>()
		names.add(name)
		reassigned.set(scope, names)
	})
	// In source order, so a nested initializer resolves against the bindings
	// visible where it is declared, including an alias of an earlier binding.
	for (const declarator of declarators) {
		const { scope, name, init } = declarator
		const text =
			scope === parsed
				? declarator.isConst
					? constants.get(name)
					: resolveStringExpression(init, constants)
				: init
					? resolveStringExpression(
							init,
							visibleConstants(init, declarator.ancestors),
						)
					: null
		if (text != null && findPlaceholderMatches(text).length > 0) {
			bind(scope, name, text)
		}
	}
	for (const [name, text] of constants) {
		if (declared.get(parsed)?.has(name) !== true) continue
		if (bindings.get(parsed)?.has(name)) continue
		if (findPlaceholderMatches(text).length > 0) bind(parsed, name, text)
	}
	return scopes

	function visibleConstants(init: AstNode, ancestors: ReadonlyArray<AstNode>) {
		const visible = new Map<string, string>()
		walkAst(init, (node) => {
			const name = node.type === 'Identifier' ? getNodeName(node) : null
			if (!name) return
			const scope = declaringScope(scopes, name, ancestors)
			const binding = scope ? bindings.get(scope)?.get(name) : null
			if (binding) {
				if (!binding.reassigned) visible.set(name, binding.text)
			} else if (scope === parsed && constants.has(name)) {
				visible.set(name, constants.get(name)!)
			}
		})
		return visible
	}
}

function boundNames(pattern: AstNode | null | undefined): Array<string> {
	if (!pattern) return []
	switch (pattern.type) {
		case 'Identifier': {
			const name = getNodeName(pattern)
			return name ? [name] : []
		}
		case 'AssignmentPattern':
			return boundNames(pattern.left)
		case 'RestElement':
			return boundNames(pattern.argument)
		case 'ArrayPattern':
			return (pattern.elements ?? []).flatMap((element) => boundNames(element))
		case 'ObjectPattern':
			return (pattern.properties ?? []).flatMap((property) =>
				boundNames(
					property.type === 'RestElement'
						? property
						: (property.value as AstNode | undefined),
				),
			)
		case 'TSParameterProperty':
			return boundNames(pattern.parameter)
		default:
			return []
	}
}

function isScope(node: AstNode) {
	return (
		node.type === 'Program' ||
		node.type === 'BlockStatement' ||
		node.type === 'CatchClause' ||
		node.type === 'StaticBlock' ||
		loopScopeTypes.has(node.type) ||
		functionTypes.has(node.type)
	)
}

/** The block, loop, or function a `let`, `const`, or declaration is in. */
function blockScope(ancestors: ReadonlyArray<AstNode>, parsed: AstNode) {
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const ancestor = ancestors[index]!
		if (ancestor.type === 'File') return parsed
		if (isScope(ancestor))
			return ancestor.type === 'Program' ? parsed : ancestor
	}
	return parsed
}

/** The function a `var` is hoisted to, or the module. */
function functionScope(ancestors: ReadonlyArray<AstNode>, parsed: AstNode) {
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		if (functionTypes.has(ancestors[index]!.type)) return ancestors[index]!
	}
	return parsed
}

/** The binding `name` reads at `ancestors`: its nearest declaration's. */
function bindingInScope(
	scopes: ModuleScopes,
	name: string | null,
	ancestors: ReadonlyArray<AstNode>,
) {
	const scope = declaringScope(scopes, name, ancestors)
	return scope && name ? (scopes.bindings.get(scope)?.get(name) ?? null) : null
}

function declaringScope(
	scopes: ModuleScopes,
	name: string | null,
	ancestors: ReadonlyArray<AstNode>,
) {
	if (!name) return null
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const ancestor = ancestors[index]!
		if (scopes.declared.get(ancestor)?.has(name)) return ancestor
	}
	return null
}

/** Whether an identifier node reads a variable, not names a key or member. */
function isVariableRead(node: AstNode, ancestors: ReadonlyArray<AstNode>) {
	const parent = ancestors.at(-1)
	if (!parent) return false
	switch (parent.type) {
		case 'VariableDeclarator':
			return parent.init === node
		case 'MemberExpression':
		case 'OptionalMemberExpression':
			return parent.object === node || parent.computed === true
		case 'ObjectProperty':
			return parent.value === node
		case 'ClassProperty':
		case 'ClassPrivateProperty':
			return parent.value === node
		case 'ImportSpecifier':
		case 'ImportDefaultSpecifier':
		case 'ImportNamespaceSpecifier':
		case 'ExportSpecifier':
		case 'LabeledStatement':
		case 'BreakStatement':
		case 'ContinueStatement':
		case 'TSPropertySignature':
		case 'TSTypeReference':
		case 'TSQualifiedName':
			return false
		default:
			return !functionTypes.has(parent.type) || parent.body === node
	}
}

function scanParsedModule(
	parsed: AstNode,
	constants: ReadonlyMap<string, string>,
	scan: PackageCredentialScan,
) {
	const scopes = collectScopes(parsed, constants)
	const readCount = new Map<Binding, number>()
	// Display functions the module itself reads or calls (`fetch(status())`,
	// `this.help()`) can feed a request, so their returns are not exempt.
	// Member reads count only on `this`; `client.status()` is someone else's.
	// Any other `this` use (aliases, dynamic keys, destructuring, arguments)
	// could reach any of them, so it marks every display name.
	const referencedDisplayNames = new Set<string>()
	walkAst(parsed, (node, ancestors) => {
		if (node.type === 'ThisExpression') {
			for (const name of thisMemberDisplayNames(node, ancestors)) {
				referencedDisplayNames.add(name)
			}
			return
		}
		if (node.type !== 'Identifier' || !isVariableRead(node, ancestors)) return
		const name = getNodeName(node)?.toLowerCase()
		if (name && displayReturnFunctionNames.has(name)) {
			referencedDisplayNames.add(name)
		}
		const binding = bindingInScope(scopes, getNodeName(node), ancestors)
		if (binding) readCount.set(binding, (readCount.get(binding) ?? 0) + 1)
	})
	const exportedNames = new Set<string>()
	for (const statement of parsed.program?.body ?? []) {
		if (statement.type !== 'ExportNamedDeclaration') continue
		for (const declarator of statement.declaration?.declarations ?? []) {
			const name = getNodeName(declarator.id)
			if (name) exportedNames.add(name)
		}
		for (const specifier of statement.specifiers ?? []) {
			const name = getNodeName(specifier.local)
			if (name) exportedNames.add(name)
		}
	}
	const boundNamesInModule = new Set(
		[...scopes.bindings.values()].flatMap((scoped) => [...scoped.keys()]),
	)
	const constantsIn = (ancestors: ReadonlyArray<AstNode>) => {
		const inScope = new Map<string, string>()
		for (const name of new Set([...constants.keys(), ...boundNamesInModule])) {
			const scope = declaringScope(scopes, name, ancestors)
			const binding = scope ? scopes.bindings.get(scope)?.get(name) : null
			if (binding) {
				if (!binding.reassigned) inScope.set(name, binding.text)
			} else if (scope === parsed && constants.has(name)) {
				inScope.set(name, constants.get(name)!)
			}
		}
		return inScope
	}
	const resolvedPieces = new WeakSet<AstNode>()
	walkAst(parsed, (node, ancestors) => {
		if (resolvedPieces.has(node)) return
		if (
			node.type === 'CallExpression' ||
			node.type === 'OptionalCallExpression'
		) {
			if (getCalleeName(node.callee) === 'secretJwtSign') {
				scan.jwtSignCalls += 1
				const name = secretJwtSignSecretName(node)
				if (name) scan.jwtSignSecretNames.push(name)
			}
			return
		}
		const placementFor = (text: string) => (match: PlaceholderMatch) =>
			classifyPlacement(text, match, node, ancestors, {
				constants: constantsIn(ancestors),
				referencedDisplayNames,
				binding: (declarator) => {
					const name = getNodeName(declarator.id)
					const binding = bindingInScope(scopes, name, [
						...ancestors,
						declarator,
					])
					if (!binding) return 'unused'
					if (binding.reassigned) return 'reassigned'
					const exported =
						name != null && exportedNames.has(name) && binding.scope === parsed
					return exported || (readCount.get(binding) ?? 0) > 0
						? 'read'
						: 'unused'
				},
			})
		if (isCompositeString(node)) {
			const inScope = constantsIn(ancestors)
			const resolved = resolveStringExpression(node, inScope)
			if (resolved != null) {
				const substituted: Array<string> = []
				walkAst(node, (piece) => {
					resolvedPieces.add(piece)
					const name = piece.type === 'Identifier' ? getNodeName(piece) : null
					if (name && inScope.has(name)) substituted.push(inScope.get(name)!)
				})
				recordPlaceholders(
					resolved,
					placementFor(resolved),
					scan,
					countPlaceholders(substituted),
				)
				return
			}
		}
		switch (node.type) {
			case 'StringLiteral': {
				const value = getNodeName(node)
				if (value == null) return
				recordPlaceholders(value, placementFor(value), scan)
				return
			}
			case 'TemplateElement': {
				// A piece of a template that does not resolve to one string: the
				// placeholder sits in a computed value, so only its kind is known.
				const display = displayOnlyPlacement(
					ancestors,
					node,
					referencedDisplayNames,
				)
				recordPlaceholders(
					templateElementText(node),
					(match) =>
						match.kind === 'secret-basic'
							? { type: 'basic' }
							: (display ?? otherPlacement('template-computed')),
					scan,
				)
				return
			}
			case 'Identifier': {
				if (!isVariableRead(node, ancestors)) return
				const binding = bindingInScope(scopes, getNodeName(node), ancestors)
				if (!binding || binding.reassigned) return
				recordPlaceholders(
					binding.text,
					placementFor(binding.text),
					scan,
					countPlaceholders([binding.text]),
				)
				return
			}
			default:
				return
		}
	})
}

function isCompositeString(node: AstNode) {
	if (node.type === 'TemplateLiteral') return true
	return node.type === 'BinaryExpression' && node.operator === '+'
}

/** The nearest ancestor, skipping parentheses and type assertions. */
function parentOf(ancestors: ReadonlyArray<AstNode>, from = ancestors.length) {
	for (let index = from - 1; index >= 0; index -= 1) {
		const ancestor = ancestors[index]!
		if (!transparentExpressionTypes.has(ancestor.type)) {
			return { node: ancestor, index }
		}
	}
	return null
}

function propertyKey(node: AstNode) {
	if (node.type !== 'ObjectProperty' || node.computed === true) return null
	return getNodeName(node.key)
}

/** `private_key_secret_name` (or `secret_name`) string from a secretJwtSign call. */
function secretJwtSignSecretName(call: AstNode): string | null {
	if (
		call.type !== 'CallExpression' &&
		call.type !== 'OptionalCallExpression'
	) {
		return null
	}
	const [first] = call.arguments ?? []
	if (first?.type !== 'ObjectExpression') return null
	for (const property of first.properties ?? []) {
		const key = propertyKey(property)
		if (key !== 'private_key_secret_name' && key !== 'secret_name') continue
		if (property.type !== 'ObjectProperty') continue
		const value = property.value as AstNode | undefined
		if (value?.type === 'StringLiteral') {
			const name = getNodeName(value)?.trim()
			return name && name.length > 0 ? name : null
		}
	}
	return null
}

function safeIdentifier(value: string | null) {
	return value != null && identifierPattern.test(value) ? value : null
}

type ClassifyContext = {
	constants: ReadonlyMap<string, string>
	referencedDisplayNames: ReadonlySet<string>
	/** Whether the variable a declarator binds is read, reassigned, or unused. */
	binding: (declarator: AstNode) => 'read' | 'reassigned' | 'unused'
}

/** Documentation keys recorded on display placements (labels only). */
const displayDocumentationPropertyKeys = new Set([
	'example',
	'examples',
	'description',
	'help',
	'usage',
	'docs',
	'documentation',
	'hint',
	'hints',
	'sample',
	'samples',
])

/** Function / method names whose returns are package help, not request builders. */
const displayReturnFunctionNames = new Set(['status', 'help', 'docs', 'usage'])

function thisMemberDisplayNames(
	node: AstNode,
	ancestors: ReadonlyArray<AstNode>,
): Iterable<string> {
	let child = node
	let index = ancestors.length - 1
	while (index >= 0 && transparentExpressionTypes.has(ancestors[index]!.type)) {
		child = ancestors[index]!
		index -= 1
	}
	const parent = ancestors[index]
	if (
		(parent?.type === 'MemberExpression' ||
			parent?.type === 'OptionalMemberExpression') &&
		parent.object === child
	) {
		const name = parent.computed
			? typeof parent.property?.value === 'string'
				? parent.property.value
				: null
			: getNodeName(parent.property)
		if (name) {
			const lower = name.toLowerCase()
			return displayReturnFunctionNames.has(lower) ? [lower] : []
		}
	}
	return displayReturnFunctionNames
}

function enclosingFunctionName(ancestors: ReadonlyArray<AstNode>) {
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const ancestor = ancestors[index]!
		if (
			ancestor.type === 'FunctionDeclaration' ||
			ancestor.type === 'FunctionExpression' ||
			ancestor.type === 'ArrowFunctionExpression'
		) {
			const own = getNodeName(ancestor.id) ?? getNodeName(ancestor.key) ?? null
			if (own) return own
			// `const status = () => …` / `status: () => …` — the name sits on
			// the enclosing declarator or object property, not the function.
			const holder = ancestors[index - 1]
			if (holder?.type === 'VariableDeclarator' && holder.init === ancestor) {
				return getNodeName(holder.id)
			}
			if (holder?.type === 'ObjectProperty' && holder.value === ancestor) {
				return getNodeName(holder.key) ?? propertyKey(holder)
			}
			// Unnamed nested function (default param, callback, etc.): do not
			// inherit an outer status/help name.
			return null
		}
		if (
			ancestor.type === 'ObjectMethod' ||
			ancestor.type === 'ClassMethod' ||
			ancestor.type === 'ClassPrivateMethod'
		) {
			return getNodeName(ancestor.key) ?? getNodeName(ancestor.id) ?? null
		}
	}
	return null
}

/**
 * Display/help sites for vault tokens: values returned from a
 * status/help/docs/usage function the module never reads or calls itself, and
 * never when a call or `new` encloses the placeholder (so fetch bodies and
 * request helpers stay stamp-gated).
 * Documentation-keyed objects elsewhere (`const spec = { description }`) are
 * not exempt: a later read can feed them into a request.
 */
function displayOnlyPlacement(
	ancestors: ReadonlyArray<AstNode>,
	node: AstNode,
	referencedDisplayNames: ReadonlySet<string>,
): CredentialPlacement | null {
	for (const ancestor of ancestors) {
		if (
			ancestor.type === 'CallExpression' ||
			ancestor.type === 'OptionalCallExpression' ||
			ancestor.type === 'NewExpression'
		) {
			return null
		}
	}
	const inReturn =
		ancestors.some((ancestor) => ancestor.type === 'ReturnStatement') ||
		ancestors.some(
			(ancestor, index) =>
				ancestor.type === 'ArrowFunctionExpression' &&
				ancestor.body === (ancestors[index + 1] ?? node),
		)
	if (!inReturn) return null
	const functionName = enclosingFunctionName(ancestors)?.toLowerCase() ?? null
	if (
		!functionName ||
		!displayReturnFunctionNames.has(functionName) ||
		referencedDisplayNames.has(functionName)
	) {
		return null
	}
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const ancestor = ancestors[index]!
		if (ancestor.type === 'ObjectProperty') {
			const key = safeIdentifier(propertyKey(ancestor))
			if (key && displayDocumentationPropertyKeys.has(key.toLowerCase())) {
				return otherPlacement('display', key)
			}
		}
	}
	return otherPlacement('display')
}

function classifyPlacement(
	text: string,
	match: PlaceholderMatch,
	node: AstNode,
	ancestors: ReadonlyArray<AstNode>,
	context: ClassifyContext,
): CredentialPlacement {
	if (match.kind === 'secret-basic') return { type: 'basic' }
	const displayOnly = displayOnlyPlacement(
		ancestors,
		node,
		context.referencedDisplayNames,
	)
	if (displayOnly) return displayOnly
	const parent = parentOf(ancestors)
	if (
		parent?.node.type === 'VariableDeclarator' &&
		parent.node.id?.type === 'Identifier' &&
		node !== parent.node.id
	) {
		const binding = context.binding(parent.node)
		switch (binding) {
			case 'read':
				return { type: 'binding' }
			case 'reassigned':
				return otherPlacement('reassigned-binding')
			case 'unused':
				return otherPlacement('unused-binding')
			default: {
				const unexpected: never = binding
				return unexpected
			}
		}
	}
	if (isSigningKey(ancestors, node)) return { type: 'signing' }
	if (parent?.node.type === 'ObjectProperty') {
		const key = propertyKey(parent.node)
		const object = parentOf(ancestors, parent.index)
		const holder = object ? parentOf(ancestors, object.index) : null
		if (
			key != null &&
			object?.node.type === 'ObjectExpression' &&
			holder &&
			isHeadersHolder(holder.node, object.node)
		) {
			return headerPlacement(key, text, match)
		}
	}
	const call =
		parent &&
		(parent.node.type === 'CallExpression' ||
			parent.node.type === 'OptionalCallExpression' ||
			parent.node.type === 'NewExpression')
			? parent.node
			: null
	const argumentIndex = call
		? (call.arguments ?? []).indexOf(ancestors[parent!.index + 1] ?? node)
		: -1
	if (call && call.type !== 'NewExpression' && argumentIndex === 1) {
		const placement = setterPlacement(call, text, match)
		if (placement) return placement
	}
	const bodyIndex = ancestors.findLastIndex(
		(ancestor) => propertyKey(ancestor) === 'body',
	)
	if (bodyIndex !== -1) {
		return {
			type: 'body',
			field: safeIdentifier(nearestPropertyKey(ancestors, bodyIndex + 1)),
			endpoint: requestEndpoint(ancestors.slice(0, bodyIndex), context),
		}
	}
	if (call && argumentIndex === 0 && isUrlTaker(call) && match.start === 0) {
		return { type: 'url' }
	}
	if (/^https?:\/\//i.test(text)) return urlPlacement(text, match)
	if (match.start === 0 && /^[/?]/.test(text.slice(match.end))) {
		return { type: 'url' }
	}
	return otherContext(ancestors, node, call, argumentIndex)
}

/** Whether the placeholder is inside the key argument of a signing call. */
function isSigningKey(ancestors: ReadonlyArray<AstNode>, node: AstNode) {
	return ancestors.some((ancestor, index) => {
		if (
			ancestor.type !== 'CallExpression' &&
			ancestor.type !== 'OptionalCallExpression' &&
			ancestor.type !== 'NewExpression'
		) {
			return false
		}
		const keyArgument = signingKeyArgument.get(
			getCalleeName(ancestor.callee) ?? '',
		)
		if (!keyArgument) return false
		const args = ancestor.arguments ?? []
		return args[keyArgument(args)] === (ancestors[index + 1] ?? node)
	})
}

/** `fetch(url)`, `new URL(url)`, `new Request(url)`, and `x.fetch(url)`. */
function isUrlTaker(call: AstNode) {
	const name = getCalleeName(call.callee)
	return name === 'fetch' || name === 'URL' || name === 'Request'
}

/** The key of the innermost object property at or below `from`. */
function nearestPropertyKey(ancestors: ReadonlyArray<AstNode>, from: number) {
	for (let index = ancestors.length - 1; index >= from; index -= 1) {
		const key = propertyKey(ancestors[index]!)
		if (key != null) return key
	}
	return null
}

/** The path of the enclosing `fetch` call's literal URL, by shape. */
function requestEndpoint(
	ancestors: ReadonlyArray<AstNode>,
	context: ClassifyContext,
): CredentialEndpoint {
	for (let index = ancestors.length - 1; index >= 0; index -= 1) {
		const ancestor = ancestors[index]!
		if (
			(ancestor.type === 'CallExpression' ||
				ancestor.type === 'OptionalCallExpression') &&
			getCalleeName(ancestor.callee) === 'fetch'
		) {
			const url = resolveStringExpression(
				ancestor.arguments?.[0],
				context.constants,
			)
			if (url == null) return 'unknown'
			const path = url.replace(/^[a-z]+:\/\/[^/]*/i, '')
			return loginPathPattern.test(path) ? 'login' : 'other'
		}
	}
	return 'unknown'
}

function otherContext(
	ancestors: ReadonlyArray<AstNode>,
	node: AstNode,
	call: AstNode | null,
	argumentIndex: number,
): CredentialPlacement {
	const parent = parentOf(ancestors)
	if (!parent) return otherPlacement('other')
	const calleeOf = (target: AstNode) =>
		safeIdentifier(getCalleeName(target.callee))
	if (call && argumentIndex !== -1) {
		return otherPlacement('argument', null, calleeOf(call))
	}
	switch (parent.node.type) {
		case 'ObjectProperty': {
			const key = safeIdentifier(propertyKey(parent.node))
			const object = parentOf(ancestors, parent.index)
			const holder = object ? parentOf(ancestors, object.index) : null
			if (
				holder &&
				(holder.node.type === 'CallExpression' ||
					holder.node.type === 'OptionalCallExpression' ||
					holder.node.type === 'NewExpression')
			) {
				return otherPlacement('sdk-option', key, calleeOf(holder.node))
			}
			return otherPlacement('object', key)
		}
		case 'ReturnStatement':
			return otherPlacement('return')
		case 'ArrowFunctionExpression':
			return parent.node.body === (ancestors[parent.index + 1] ?? node)
				? otherPlacement('return')
				: otherPlacement('default-param')
		case 'AssignmentExpression': {
			const left = parent.node.left
			const key =
				left?.type === 'MemberExpression' && left.computed !== true
					? safeIdentifier(getNodeName(left.property))
					: null
			return otherPlacement('assignment', key)
		}
		case 'AssignmentPattern':
			return otherPlacement('default-param')
		case 'ArrayExpression':
			return otherPlacement('array')
		case 'TemplateLiteral':
			return otherPlacement('template-computed')
		case 'BinaryExpression':
			return otherPlacement(
				parent.node.operator === '+' ? 'template-computed' : 'comparison',
			)
		case 'SwitchCase':
			return otherPlacement('comparison')
		default:
			return otherPlacement('other')
	}
}

function isHeadersHolder(holder: AstNode, object: AstNode) {
	if (holder.type === 'ObjectProperty') {
		return propertyKey(holder) === 'headers' && holder.value === object
	}
	return (
		holder.type === 'NewExpression' &&
		getNodeName(holder.callee) === 'Headers' &&
		holder.arguments?.[0] === object
	)
}

/** `headers.set('X-Api-Key', …)` and `url.searchParams.set('key', …)`. */
function setterPlacement(
	call: AstNode,
	text: string,
	match: PlaceholderMatch,
): CredentialPlacement | null {
	const method = getCalleeName(call.callee)
	if (method !== 'set' && method !== 'append') return null
	const target = call.callee?.object
	const key = resolveStringExpression(call.arguments?.[0], new Map())
	if (key == null) return null
	const targetName =
		target?.type === 'MemberExpression' ||
		target?.type === 'OptionalMemberExpression'
			? getNodeName(target.property)
			: getNodeName(target)
	if (targetName === 'searchParams') {
		return isWholeValue(text, match) && /^[A-Za-z0-9._-]{1,64}$/.test(key)
			? { type: 'query', param: key }
			: otherPlacement('other')
	}
	if (targetName && /headers/i.test(targetName)) {
		return headerPlacement(key, text, match)
	}
	return null
}

function isWholeValue(text: string, match: PlaceholderMatch) {
	return match.start === 0 && match.end === text.length
}

function headerPlacement(
	name: string,
	text: string,
	match: PlaceholderMatch,
): CredentialPlacement {
	const format = `${text.slice(0, match.start)}{value}${text.slice(match.end)}`
	if (!headerNamePattern.test(name) || !headerFormatPattern.test(format)) {
		return { type: 'header-custom' }
	}
	return { type: 'header', name: name.toLowerCase(), format }
}

function urlPlacement(
	text: string,
	match: PlaceholderMatch,
): CredentialPlacement {
	const before = text.slice(0, match.start)
	if (!/^[a-z]+:\/\/[^/?#]*\//i.test(before) && !before.includes('?')) {
		return otherPlacement('url-host')
	}
	const queryStart = before.indexOf('?')
	if (queryStart === -1) {
		return before.includes('#') ? otherPlacement('other') : { type: 'path' }
	}
	const param = queryParamBeforePattern.exec(before)?.[1]
	const next = text[match.end]
	if (param && (next === undefined || next === '&' || next === '#')) {
		return { type: 'query', param }
	}
	return otherPlacement('other')
}
