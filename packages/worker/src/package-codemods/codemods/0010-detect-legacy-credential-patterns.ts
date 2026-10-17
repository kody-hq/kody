import {
	type AstNode,
	constantsWithoutShadows,
	createModuleConstantsReader,
	findPlaceholders,
	getCalleeName,
	getCalleeObjectName,
	getNodeName,
	listScannableModulePaths,
	type NameKind,
	parseModule,
	resolveStringExpression,
	templateElementText,
	transparentExpressionTypes,
	walkAst,
} from '#worker/credentials/module-placeholder-scan.ts'
import {
	type PackageCodemod,
	type PackageCodemodFinding,
	type PackageCodemodTransformResult,
} from '../types.ts'

export const detectLegacyCredentialPatternsCodemodId =
	'0010-detect-legacy-credential-patterns'

export const legacyCredentialPatterns = [
	'literal secret',
	'computed secret',
	'computed integration',
	'kody.mcp',
	'|scope=',
	'secretMounts',
	'webhook secretName',
	'plain http',
	'packageSecrets.get',
] as const

export type LegacyCredentialPattern = (typeof legacyCredentialPatterns)[number]

/**
 * Fixed messages only: findings reach the fleet operator, so they never
 * carry a credential name, file contents, or manifest values.
 */
export const legacyCredentialPatternMessages: Record<
	LegacyCredentialPattern,
	string
> = {
	'literal secret':
		'literal secret: names a secret, vault ref, or integration with a literal string. Declare it as a kody.credentials slot.',
	'computed secret':
		'computed secret: builds a secret name or placeholder at runtime. Declare each secret it can pick as a kody.credentials slot.',
	'computed integration':
		'computed integration: picks an integration name at runtime. Declare a kody.credentials oauth slot (multiple when it picks among accounts).',
	'kody.mcp':
		'kody.mcp: calls an MCP server by name. Declare a kody.credentials mcp slot for each server.',
	'|scope=':
		'|scope=: reads a package- or session-scoped secret bucket. Move the value to an org credential assigned to the package.',
	secretMounts:
		'secretMounts: declares kody.secretMounts. Keep mounts that stale static dependents still read (check static_dependents) and delete a mount only once no stale dependent reads it. New package code uses a kody.credentials slot instead of packageSecrets.get.',
	'webhook secretName':
		'webhook secretName: a webhook names its signing secret with secretName. Declare that secret as a kody.credentials slot.',
	'plain http':
		'plain http: fetches an http:// URL in a module that uses secret placeholders. The fetch gateway substitutes secrets only over HTTPS.',
	'packageSecrets.get':
		'packageSecrets.get: reads a kody.secretMounts alias through packageSecrets.get. It returns an opaque {{secret:…}} ref, never the value. The fetch gateway fills the ref in a header, the URL path or query, or a non-multipart text body of an HTTPS request to a host the secret allows.',
}

export function legacyCredentialPatternFromMessage(
	message: string,
): LegacyCredentialPattern | null {
	for (const pattern of legacyCredentialPatterns) {
		if (legacyCredentialPatternMessages[pattern] === message) return pattern
	}
	return null
}

const packageManifestPath = 'package.json'

/** The kody.credentials slot kind a reference of each name kind resolves to. */
const slotKindByNameKind: Record<NameKind, 'secret' | 'oauth'> = {
	secret: 'secret',
	integration: 'oauth',
}

/**
 * Where a credential reference comes from: a placeholder in a string, or the
 * `kody:runtime` helper named here.
 */
export type CredentialReferenceVia =
	| 'placeholder'
	| 'createAuthenticatedFetch'
	| 'packageSecrets'
	| 'basic'
	| 'oauthClientCredentials'
	| 'secretJwtSign'
	| 'packageSecretGet'
	| 'packageSecretHas'
	| 'integrationTokenRefresh'

/** What a module scan reports, one call per reference. */
export type CredentialReferenceHandlers = {
	/** A pattern that names no credential (`kody.mcp`, `|scope=`, ...). */
	add: (pattern: LegacyCredentialPattern) => void
	/** A credential named by a known string. */
	named: (name: string, kind: NameKind, via: CredentialReferenceVia) => void
	/** A credential whose name is only known at run time. */
	computed: (kind: NameKind, via: CredentialReferenceVia) => void
	/** A literal reference that names no slot: a vault ref or unreadable text. */
	unnamed: (via: CredentialReferenceVia) => void
}

type Scan = CredentialReferenceHandlers & {
	/** Module-level string constants, declared or relatively imported. */
	constants: ReadonlyMap<string, string>
}
/**
 * A literal scope word, or a text-fallback computed suffix (`${` / quote +
 * `+`). The bare end-of-piece `|scope=` / `|scope=pack` form is only counted
 * when {@link hasComputedScopeContinuation} proves a following expression.
 */
const scopeSuffixPattern =
	/\|scope=(?:(?:session|package|user)\b|\$\{|['"`]\s*\+)/
/** `|scope=` or a partial scope word at the end of a template/concat piece. */
const computedScopePieceEndPattern = /\|scope=[a-z]*$/
const textKodyMcpPattern =
	/\bkody\s*(?:\?\.|\.)\s*mcp\b|\bkody\s*\[\s*['"`]mcp['"`]/

/** Group 1 captures the opening quote when the first argument is a literal. */
const textNameArgumentCalls: Array<{
	pattern: RegExp
	kind: NameKind
	via: CredentialReferenceVia
}> = [
	{
		pattern: /\bcreateAuthenticatedFetch\s*\(\s*(['"`])?/g,
		kind: 'integration',
		via: 'createAuthenticatedFetch',
	},
	{
		pattern: /\bpackageSecrets\s*(?:\?\.|\.)\s*(?:get|has)\s*\(\s*(['"`])?/g,
		kind: 'secret',
		via: 'packageSecrets',
	},
]

/**
 * Helper calls whose first argument (or named fields) name a credential. Read
 * with {@link ownEntry}: a callee named after an Object.prototype method
 * (`toString`, `hasOwnProperty`) must not match.
 */
const nameArgumentCallees: Record<string, NameKind> = {
	createAuthenticatedFetch: 'integration',
}
const nameFieldCallees: Record<
	string,
	{
		kind: NameKind
		via: CredentialReferenceVia
		fields: Array<string>
		scopeFields: Array<string>
	}
> = {
	basic: {
		kind: 'secret',
		via: 'basic',
		fields: ['usernameSecret', 'passwordSecret'],
		scopeFields: ['scope'],
	},
	oauthClientCredentials: {
		kind: 'secret',
		via: 'oauthClientCredentials',
		fields: ['clientIdSecret', 'clientSecretSecret'],
		scopeFields: ['scope'],
	},
	secretJwtSign: {
		kind: 'secret',
		via: 'secretJwtSign',
		fields: ['private_key_secret_name'],
		scopeFields: ['private_key_secret_scope'],
	},
	packageSecretGet: {
		kind: 'secret',
		via: 'packageSecretGet',
		fields: ['alias'],
		scopeFields: [],
	},
	packageSecretHas: {
		kind: 'secret',
		via: 'packageSecretHas',
		fields: ['alias'],
		scopeFields: [],
	},
	integrationTokenRefresh: {
		kind: 'integration',
		via: 'integrationTokenRefresh',
		fields: ['name'],
		scopeFields: [],
	},
}
const packageSecretsMethods = new Set(['get', 'has'])

function ownEntry<Value>(record: Record<string, Value>, key: string) {
	return Object.hasOwn(record, key) ? record[key] : undefined
}

function literalText(node: AstNode) {
	if (node.type === 'StringLiteral') return getNodeName(node)
	if (node.type !== 'TemplateLiteral') return null
	return (node.quasis ?? []).map(templateElementText).join('${}')
}

function isPlainHttpUrl(text: string) {
	return /^\s*http:\/\//i.test(text)
}

function isRequestUrlArgument(node: AstNode, parent: AstNode | undefined) {
	if (!parent || parent.arguments?.[0] !== node) return false
	if (parent.type === 'NewExpression') {
		return getNodeName(parent.callee) === 'Request'
	}
	return (
		(parent.type === 'CallExpression' ||
			parent.type === 'OptionalCallExpression') &&
		getCalleeName(parent.callee) === 'fetch'
	)
}

function classifyStringPiece(
	text: string,
	scan: Scan,
	allowComputedScopePieceEnd = false,
) {
	if (
		scopeSuffixPattern.test(text) ||
		(allowComputedScopePieceEnd && computedScopePieceEndPattern.test(text))
	) {
		scan.add('|scope=')
	}
	for (const placeholder of findPlaceholders(text)) {
		switch (placeholder.kind) {
			case 'secret':
			case 'integration':
				for (const name of placeholder.names) {
					scan.named(name, placeholder.kind, 'placeholder')
				}
				break
			case 'vault':
				scan.unnamed('placeholder')
				break
			case 'computed':
				scan.computed(placeholder.nameKind, 'placeholder')
				break
			default: {
				const exhaustive: never = placeholder
				throw new Error(`Unhandled placeholder: ${String(exhaustive)}`)
			}
		}
	}
}

function hasComputedScopeContinuation(
	node: AstNode,
	ancestors: ReadonlyArray<AstNode>,
) {
	let child = node
	let index = ancestors.length - 1
	if (node.type === 'TemplateElement') {
		const template = ancestors[index]
		if (template?.type !== 'TemplateLiteral') return false
		const quasiIndex = (template.quasis ?? []).indexOf(node)
		if (quasiIndex < 0) return false
		if (quasiIndex < (template.expressions ?? []).length) return true
		child = template
		index -= 1
	}
	for (; index >= 0; index -= 1) {
		const parent = ancestors[index]!
		if (transparentExpressionTypes.has(parent.type)) {
			child = parent
			continue
		}
		if (parent.type !== 'BinaryExpression' || parent.operator !== '+') {
			return false
		}
		if (parent.left === child) return true
		if (parent.right !== child) return false
		child = parent
	}
	return false
}

function classifyNameExpression(
	node: AstNode | undefined,
	kind: NameKind,
	via: CredentialReferenceVia,
	scan: Scan,
	ancestors: ReadonlyArray<AstNode> = [],
) {
	const name = resolveStringExpression(
		node,
		constantsWithoutShadows(scan.constants, ancestors),
	)
	if (name == null) scan.computed(kind, via)
	else scan.named(name, kind, via)
}

function computedPattern(kind: NameKind): LegacyCredentialPattern {
	return kind === 'integration' ? 'computed integration' : 'computed secret'
}

function classifyNamedFields(
	argument: AstNode | undefined,
	spec: (typeof nameFieldCallees)[string],
	scan: Scan,
	ancestors: ReadonlyArray<AstNode>,
) {
	if (argument?.type !== 'ObjectExpression') {
		if (argument) scan.computed(spec.kind, spec.via)
		return
	}
	for (const property of argument.properties ?? []) {
		if (property.type !== 'ObjectProperty' || property.computed === true) {
			scan.computed(spec.kind, spec.via)
			continue
		}
		const key = getNodeName(property.key)
		if (key == null) continue
		if (spec.scopeFields.includes(key)) {
			scan.add('|scope=')
			continue
		}
		if (spec.fields.includes(key)) {
			classifyNameExpression(
				property.value as AstNode,
				spec.kind,
				spec.via,
				scan,
				ancestors,
			)
		}
	}
}

function collectKodyAliases(body: Array<AstNode>) {
	const aliases = new Set<string>(['kody'])
	for (const node of body) {
		if (node.type !== 'ImportDeclaration') continue
		if (getNodeName(node.source) !== 'kody:runtime') continue
		for (const specifier of node.specifiers ?? []) {
			if (specifier.type !== 'ImportSpecifier') continue
			if (getNodeName(specifier.imported) !== 'kody') continue
			const local = getNodeName(specifier.local)
			if (local) aliases.add(local)
		}
	}
	return aliases
}

function isKodyMcpAccess(node: AstNode, aliases: Set<string>) {
	if (
		node.type !== 'MemberExpression' &&
		node.type !== 'OptionalMemberExpression'
	) {
		return false
	}
	if (node.object?.type !== 'Identifier') return false
	if (!aliases.has(getNodeName(node.object) ?? '')) return false
	return getNodeName(node.property) === 'mcp'
}

function isKodyMcpDestructure(node: AstNode, aliases: Set<string>) {
	if (node.type !== 'VariableDeclarator') return false
	if (node.id?.type !== 'ObjectPattern') return false
	if (node.init?.type !== 'Identifier') return false
	if (!aliases.has(getNodeName(node.init) ?? '')) return false
	return (node.id.properties ?? []).some(
		(property) =>
			property.type === 'ObjectProperty' && getNodeName(property.key) === 'mcp',
	)
}

/** A template or `+` chain with a non-literal part, so it may be computed. */
function isCompositeString(node: AstNode) {
	if (node.type === 'TemplateLiteral') {
		return (node.expressions ?? []).length > 0
	}
	return node.type === 'BinaryExpression' && node.operator === '+'
}

function detectInParsedModule(parsed: AstNode, scan: Scan) {
	const { add } = scan
	const body = parsed.program?.body ?? []
	const aliases = collectKodyAliases(body)
	let usesPlaceholder = false
	let fetchesPlainHttp = false
	/** Pieces of a composite string already classified as one resolved string. */
	const resolvedPieces = new WeakSet<AstNode>()
	const classifyLiteral = (
		node: AstNode,
		text: string,
		ancestors: ReadonlyArray<AstNode>,
	) => {
		if (isPlainHttpUrl(text) && isRequestUrlArgument(node, ancestors.at(-1))) {
			fetchesPlainHttp = true
		}
		if (findPlaceholders(text).length === 0) return
		usesPlaceholder = true
	}
	walkAst(parsed, (node, ancestors) => {
		if (resolvedPieces.has(node)) return
		if (isCompositeString(node)) {
			const resolved = resolveStringExpression(
				node,
				constantsWithoutShadows(scan.constants, ancestors),
			)
			if (resolved != null) {
				walkAst(node, (piece) => resolvedPieces.add(piece))
				classifyStringPiece(
					resolved,
					scan,
					hasComputedScopeContinuation(node, ancestors),
				)
				classifyLiteral(node, resolved, ancestors)
				return
			}
		}
		switch (node.type) {
			case 'StringLiteral': {
				const value = getNodeName(node)
				if (value == null) return
				classifyStringPiece(
					value,
					scan,
					hasComputedScopeContinuation(node, ancestors),
				)
				classifyLiteral(node, value, ancestors)
				return
			}
			case 'Identifier': {
				if (!hasComputedScopeContinuation(node, ancestors)) return
				const name = getNodeName(node)
				if (name == null) return
				const value = constantsWithoutShadows(scan.constants, ancestors).get(
					name,
				)
				if (value == null) return
				classifyStringPiece(value, scan, true)
				return
			}
			case 'TemplateLiteral': {
				const text = literalText(node)
				if (text != null) classifyLiteral(node, text, ancestors)
				return
			}
			case 'TemplateElement': {
				classifyStringPiece(
					templateElementText(node),
					scan,
					hasComputedScopeContinuation(node, ancestors),
				)
				return
			}
			case 'VariableDeclarator': {
				if (isKodyMcpDestructure(node, aliases)) add('kody.mcp')
				return
			}
			case 'MemberExpression':
			case 'OptionalMemberExpression': {
				if (isKodyMcpAccess(node, aliases)) add('kody.mcp')
				return
			}
			case 'CallExpression':
			case 'OptionalCallExpression': {
				const calleeName = getCalleeName(node.callee)
				if (calleeName == null) return
				const firstArgument = node.arguments?.[0]
				const nameKind = ownEntry(nameArgumentCallees, calleeName)
				if (nameKind) {
					if (firstArgument) {
						classifyNameExpression(
							firstArgument,
							nameKind,
							'createAuthenticatedFetch',
							scan,
							ancestors,
						)
					}
					return
				}
				const objectName = getCalleeObjectName(node.callee)
				if (
					objectName === 'packageSecrets' &&
					packageSecretsMethods.has(calleeName)
				) {
					if (calleeName === 'get') add('packageSecrets.get')
					if (firstArgument) {
						classifyNameExpression(
							firstArgument,
							'secret',
							'packageSecrets',
							scan,
							ancestors,
						)
					}
					return
				}
				if (calleeName === 'packageSecretGet') add('packageSecrets.get')
				if (calleeName === 'basic' && objectName !== 'secretHeaders') return
				const fieldSpec = ownEntry(nameFieldCallees, calleeName)
				if (fieldSpec) {
					classifyNamedFields(firstArgument, fieldSpec, scan, ancestors)
				}
				return
			}
			default:
				return
		}
	})
	if (usesPlaceholder && fetchesPlainHttp) add('plain http')
}

/** Unparseable modules fall back to text: weaker, but never silent. */
function detectInUnparsedModule(source: string, scan: Scan) {
	const { add } = scan
	/** The quoted name opened at `match`, or a computed finding. */
	const classifyQuoted = (
		match: RegExpMatchArray,
		kind: NameKind,
		via: CredentialReferenceVia,
	) => {
		const quote = match[1]
		if (!quote) {
			scan.computed(kind, via)
			return
		}
		const start = match.index! + match[0].length
		const end = source.indexOf(quote, start)
		if (end === -1) scan.unnamed(via)
		else scan.named(source.slice(start, end), kind, via)
	}
	classifyStringPiece(source, scan)
	if (textKodyMcpPattern.test(source)) add('kody.mcp')
	for (const { pattern, kind, via } of textNameArgumentCalls) {
		for (const match of source.matchAll(pattern)) {
			classifyQuoted(match, kind, via)
		}
	}
	if (
		/\bpackageSecrets\s*(?:\?\.|\.)\s*get\s*\(|\bpackageSecretGet\s*\(/.test(
			source,
		)
	) {
		add('packageSecrets.get')
	}
	for (const [callee, spec] of Object.entries(nameFieldCallees)) {
		const call =
			callee === 'basic'
				? /\bsecretHeaders\s*(?:\?\.|\.)\s*basic\s*\(/
				: new RegExp(`\\b${callee}\\s*\\(`)
		if (!call.test(source)) continue
		let namedField = false
		for (const field of spec.fields) {
			for (const match of source.matchAll(
				new RegExp(`\\b${field}\\s*:\\s*(['"\`])?`, 'g'),
			)) {
				namedField = true
				classifyQuoted(match, spec.kind, spec.via)
			}
		}
		if (!namedField) scan.computed(spec.kind, spec.via)
		for (const field of spec.scopeFields) {
			if (new RegExp(`\\b${field}\\s*:`).test(source)) add('|scope=')
		}
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function webhookNamesSecret(webhook: unknown) {
	if (!isPlainObject(webhook)) return false
	const verification = webhook.verification
	if (isPlainObject(verification) && verification.secretName != null) {
		return true
	}
	const challenge = webhook.challenge
	if (!isPlainObject(challenge)) return false
	const prove = challenge.prove
	return isPlainObject(prove) && prove.secretName != null
}

function detectInManifest(
	source: string,
	add: (pattern: LegacyCredentialPattern) => void,
) {
	let parsed: unknown
	try {
		parsed = JSON.parse(source)
	} catch {
		return
	}
	if (!isPlainObject(parsed) || !isPlainObject(parsed.kody)) return
	const kody = parsed.kody
	if ('secretMounts' in kody) add('secretMounts')
	if (Array.isArray(kody.webhooks) && kody.webhooks.some(webhookNamesSecret)) {
		add('webhook secretName')
	}
}

/** Declared kody.credentials slot names and their kinds. */
function readDeclaredSlotKinds(manifestSource: string | undefined) {
	const kinds = new Map<string, unknown>()
	if (manifestSource == null) return kinds
	let parsed: unknown
	try {
		parsed = JSON.parse(manifestSource)
	} catch {
		return kinds
	}
	if (!isPlainObject(parsed) || !isPlainObject(parsed.kody)) return kinds
	const credentials = parsed.kody.credentials
	if (!isPlainObject(credentials)) return kinds
	for (const [name, slot] of Object.entries(credentials)) {
		if (isPlainObject(slot)) kinds.set(name, slot.kind)
	}
	return kinds
}

/**
 * Scan every runtime-reachable module for credential references, in path
 * order. Unparseable modules fall back to a weaker text scan.
 */
export function scanModuleCredentialReferences(
	files: Record<string, string>,
	handlersFor: (path: string) => CredentialReferenceHandlers,
) {
	const modulePaths = listScannableModulePaths(files)
	const parsedModules = new Map(
		modulePaths.map((path) => [path, parseModule(files[path]!)]),
	)
	const moduleConstants = createModuleConstantsReader(parsedModules)
	for (const path of modulePaths) {
		const handlers = handlersFor(path)
		const parsed = parsedModules.get(path)
		if (parsed) {
			detectInParsedModule(parsed, {
				...handlers,
				constants: moduleConstants(path),
			})
		} else {
			detectInUnparsedModule(files[path]!, {
				...handlers,
				constants: new Map(),
			})
		}
	}
}

function detectLegacyCredentialPatterns(
	files: Record<string, string>,
): Array<PackageCodemodFinding> {
	const findings: Array<PackageCodemodFinding> = []
	const manifestSource = Object.hasOwn(files, packageManifestPath)
		? files[packageManifestPath]
		: undefined
	const slotKinds = readDeclaredSlotKinds(manifestSource)
	const findingSets: Array<{
		path: string
		patterns: Set<LegacyCredentialPattern>
	}> = []
	const patternsFor = (path: string) => {
		const patterns = new Set<LegacyCredentialPattern>()
		findingSets.push({ path, patterns })
		return patterns
	}
	if (manifestSource != null) {
		const patterns = patternsFor(packageManifestPath)
		detectInManifest(manifestSource, (pattern) => patterns.add(pattern))
	}
	scanModuleCredentialReferences(files, (path) => {
		const patterns = patternsFor(path)
		const add = (pattern: LegacyCredentialPattern) => patterns.add(pattern)
		return {
			add,
			named: (name, kind) => {
				if (!slotKinds.has(name)) {
					add('literal secret')
					return
				}
				const declared = slotKinds.get(name)
				const expected = slotKindByNameKind[kind]
				// Omitted kind matches any fetch-capable placeholder (secret/oauth).
				if (declared == null) return
				if (declared !== expected) {
					add('literal secret')
				}
			},
			computed: (kind) => add(computedPattern(kind)),
			unnamed: () => add('literal secret'),
		}
	})
	for (const { path, patterns } of findingSets) {
		for (const pattern of legacyCredentialPatterns) {
			if (patterns.has(pattern)) {
				findings.push({
					path,
					message: legacyCredentialPatternMessages[pattern],
				})
			}
		}
	}
	return findings.sort((left, right) =>
		(left.path ?? '').localeCompare(right.path ?? ''),
	)
}

function transformLegacyCredentialPatterns(
	files: Record<string, string>,
): PackageCodemodTransformResult {
	return {
		files,
		changed: false,
		changedPaths: [],
		needsManual: detectLegacyCredentialPatterns(files),
	}
}

export const detectLegacyCredentialPatternsCodemod: PackageCodemod = {
	id: detectLegacyCredentialPatternsCodemodId,
	description:
		'Detect only (writes nothing): find packages that reference credentials the old way (literal or computed secret and integration names, kody.mcp, |scope=, kody.secretMounts, webhook secretName) ahead of kody.credentials slots, plain http fetches the fetch gateway refuses to fill, and packageSecrets.get reads.',
	detect: detectLegacyCredentialPatterns,
	transform: transformLegacyCredentialPatterns,
}
