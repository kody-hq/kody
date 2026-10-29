import {
	type AstNode,
	constantsWithoutShadows,
	forEachScannableModule,
	getCalleeName,
	getNodeName,
	type NameKind,
	resolveStringExpression,
	walkAst,
} from '#worker/credentials/module-placeholder-scan.ts'
import { packageCredentialSlotNamePattern } from '#worker/package-registry/types.ts'
import {
	type PackageCodemod,
	type PackageCodemodContext,
	type PackageCodemodFinding,
	type PackageCodemodTransformResult,
} from '../types.ts'
import {
	type CredentialReferenceVia,
	scanModuleCredentialReferences,
} from './0010-detect-legacy-credential-patterns.ts'

export const declareCredentialNeedsCodemodId = '0013-declare-credential-needs'

const packageManifestPath = 'package.json'

/** Written into each slot the codemod adds; owners can reword it. */
export const declaredCredentialSlotDescription =
	'Used by this package by name. Declared automatically from its source; describe what it is for.'

/**
 * Fixed messages only: findings reach the fleet operator, so they never
 * carry a credential name, file contents, or manifest values.
 */
export const declareCredentialNeedsMessages = {
	declare:
		'Uses credentials by name that kody.credentials does not declare. Add a kody.credentials slot for each.',
	computed:
		'Builds a credential name or credential() key at run time. Declare each credential it can use as a kody.credentials slot by hand.',
	vault:
		'Uses a vault ref ({{secret/provider:ref}}). Declare a kody.credentials slot keyed by the provider by hand.',
	invalidKey:
		'Uses a credential name that is not a valid kody.credentials slot key (a letter, then letters, numbers, dots, underscores, or hyphens; max 64). Rename it or declare it by hand.',
	kindMismatch:
		'Uses a credential that kody.credentials declares with a kind that cannot fill it. Fix the slot kind by hand.',
	undeclaredCredentialKey:
		'Calls credential() with a key that kody.credentials does not declare. Declare the slot with the kind it takes (a slot with no kind takes only secret, oauth, or login credentials) by hand.',
	indirectCredential:
		'Passes credential or credentials around instead of calling it. Declare each key it reads as a kody.credentials slot by hand.',
	invalidManifest:
		'package.json or its kody.credentials is not valid. Fix it, then declare each credential the package uses.',
	unparsedModule:
		'A module could not be parsed, so the credential names it uses were not read reliably. Declare each credential it uses as a kody.credentials slot by hand.',
} as const

/**
 * Helpers whose names reach the fetch gateway. The rest resolve a name
 * outside it (`secretJwtSign`, `integrationTokenRefresh`) or read a
 * `kody.secretMounts` alias, which counts as declared.
 */
const gatewayVias = new Set<CredentialReferenceVia>([
	'placeholder',
	'createAuthenticatedFetch',
	'basic',
	'oauthClientCredentials',
])

/** Declared slot kinds that can fill a placeholder of each name kind. */
const fillingSlotKinds: Record<NameKind, ReadonlySet<string>> = {
	secret: new Set(['secret']),
	integration: new Set(['oauth']),
}

type Plan = {
	add: Array<string>
	manual: Array<PackageCodemodFinding>
	manifestPath: string
	manifest: Record<string, unknown> | null
	source: string | null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

function parseManifest(source: string | undefined) {
	if (source == null) return null
	try {
		const parsed: unknown = JSON.parse(source)
		return isPlainObject(parsed) ? parsed : null
	} catch {
		return null
	}
}

function normalizeSnapshotPath(path: string) {
	return path.trim().replace(/^\/+/, '')
}

/**
 * The package's manifest key and its own files, keyed as in the snapshot. A
 * nested package (`sourceRoot` below the repo root) may arrive keyed from the
 * repo root, so only files under its root are its own, or keyed from its
 * source root, so every file is.
 */
function locatePackage(
	files: Record<string, string>,
	context: PackageCodemodContext,
) {
	const root = normalizeSnapshotPath(context.sourceRoot ?? '').replace(
		/\/+$/,
		'',
	)
	const manifestPath = normalizeSnapshotPath(
		context.manifestPath ?? packageManifestPath,
	)
	const prefix = `${root}/`
	const keyFor = (path: string) =>
		Object.keys(files).find((key) => normalizeSnapshotPath(key) === path)
	const underRoot = root !== '' && manifestPath.startsWith(prefix)
	const repoKey = keyFor(manifestPath)
	if (underRoot && repoKey !== undefined) {
		return {
			manifestKey: repoKey,
			files: Object.fromEntries(
				Object.entries(files).filter(([key]) =>
					normalizeSnapshotPath(key).startsWith(prefix),
				),
			),
		}
	}
	const relativeManifest = underRoot
		? manifestPath.slice(prefix.length)
		: manifestPath
	return { manifestKey: keyFor(relativeManifest) ?? relativeManifest, files }
}

const credentialFunctionNames = new Set(['credential', 'credentials'])

/** Local names bound to `credential` / `credentials` and the runtime object. */
function collectCredentialBindings(body: Array<AstNode>) {
	const functions = new Set<string>()
	const runtimeObjects = new Set<string>(['kody'])
	for (const node of body) {
		if (node.type !== 'ImportDeclaration') continue
		if (getNodeName(node.source) !== 'kody:runtime') continue
		for (const specifier of node.specifiers ?? []) {
			const local = getNodeName(specifier.local)
			if (!local) continue
			if (
				specifier.type === 'ImportDefaultSpecifier' ||
				specifier.type === 'ImportNamespaceSpecifier'
			) {
				runtimeObjects.add(local)
				continue
			}
			const imported = getNodeName(specifier.imported)
			if (specifier.type === 'ImportSpecifier' && imported === 'kody') {
				runtimeObjects.add(local)
			}
			if (imported && credentialFunctionNames.has(imported)) {
				functions.add(local)
			}
		}
	}
	return { functions, runtimeObjects }
}

function isCredentialCallee(
	callee: AstNode | undefined,
	bindings: ReturnType<typeof collectCredentialBindings>,
) {
	if (callee?.type === 'Identifier') {
		return bindings.functions.has(getNodeName(callee) ?? '')
	}
	if (
		(callee?.type === 'MemberExpression' ||
			callee?.type === 'OptionalMemberExpression') &&
		callee.computed !== true &&
		callee.object?.type === 'Identifier'
	) {
		return (
			bindings.runtimeObjects.has(getNodeName(callee.object) ?? '') &&
			credentialFunctionNames.has(getCalleeName(callee) ?? '')
		)
	}
	return false
}

/** A property or member name spelled like a binding, not a use of it. */
function isNonReferenceName(node: AstNode, parent: AstNode) {
	if (parent.computed === true) return false
	if (
		parent.type === 'MemberExpression' ||
		parent.type === 'OptionalMemberExpression'
	) {
		return parent.property === node
	}
	if (
		parent.type === 'Property' ||
		parent.type === 'ObjectProperty' ||
		parent.type === 'MethodDefinition' ||
		parent.type === 'PropertyDefinition'
	) {
		return (
			parent.key === node &&
			(parent as { shorthand?: boolean }).shorthand !== true
		)
	}
	return false
}

type KeyScan = {
	key: (key: string) => void
	computed: () => void
	indirect: () => void
}

function scanParsedCredentialKeys(
	parsed: AstNode,
	constants: ReadonlyMap<string, string>,
	scan: KeyScan,
) {
	const bindings = collectCredentialBindings(parsed.program?.body ?? [])
	walkAst(parsed, (node, ancestors) => {
		if (
			(node.type === 'CallExpression' ||
				node.type === 'OptionalCallExpression') &&
			isCredentialCallee(node.callee, bindings)
		) {
			const key = resolveStringExpression(
				node.arguments?.[0],
				constantsWithoutShadows(constants, ancestors),
			)
			if (key == null) scan.computed()
			else scan.key(key)
			return
		}
		if (node.type !== 'Identifier') return
		if (!bindings.functions.has(getNodeName(node) ?? '')) return
		const parent = ancestors.at(-1)
		if (!parent || parent.type.startsWith('Import')) return
		if (isNonReferenceName(node, parent)) return
		const isCallee =
			(parent.type === 'CallExpression' ||
				parent.type === 'OptionalCallExpression') &&
			parent.callee === node
		const isNamedAccess =
			(parent.type === 'MemberExpression' ||
				parent.type === 'OptionalMemberExpression') &&
			parent.object === node &&
			getNodeName(parent.property) === 'named'
		if (!isCallee && !isNamedAccess) scan.indirect()
	})
}

const textCredentialCallPattern =
	/\bcredentials?\s*\(\s*(?:(['"`])([^'"`$\\]*)\1)?/g

function scanUnparsedCredentialKeys(source: string, scan: KeyScan) {
	if (!/\bkody:runtime\b|\bkody\s*(?:\?\.|\.)\s*credentials?\b/.test(source)) {
		return
	}
	for (const match of source.matchAll(textCredentialCallPattern)) {
		if (match[2] == null) scan.computed()
		else scan.key(match[2])
	}
}

function planDeclarations(
	allFiles: Record<string, string>,
	context: PackageCodemodContext,
): Plan {
	const { manifestKey, files } = locatePackage(allFiles, context)
	const source = Object.hasOwn(allFiles, manifestKey)
		? allFiles[manifestKey]
		: undefined
	const manifest = parseManifest(source)
	const kody = manifest?.kody
	const slots = isPlainObject(kody) ? kody.credentials : undefined
	if (
		source == null ||
		manifest == null ||
		(kody !== undefined && !isPlainObject(kody)) ||
		(slots !== undefined && !isPlainObject(slots))
	) {
		return {
			add: [],
			manual: [
				{
					path: manifestKey,
					message: declareCredentialNeedsMessages.invalidManifest,
				},
			],
			manifestPath: manifestKey,
			manifest: null,
			source: source ?? null,
		}
	}
	const declaredSlots = (slots ?? {}) as Record<string, unknown>
	const uses = new Map<string, Set<NameKind>>()
	const manual = new Map<
		string,
		Set<keyof typeof declareCredentialNeedsMessages>
	>()
	const flag = (
		path: string,
		message: keyof typeof declareCredentialNeedsMessages,
	) => {
		const messages = manual.get(path) ?? new Set()
		messages.add(message)
		manual.set(path, messages)
	}
	const pathsByName = new Map<string, Set<string>>()
	const use = (path: string, name: string, kind: NameKind) => {
		const kinds = uses.get(name) ?? new Set()
		kinds.add(kind)
		uses.set(name, kinds)
		const paths = pathsByName.get(name) ?? new Set()
		paths.add(path)
		pathsByName.set(name, paths)
	}
	scanModuleCredentialReferences(files, (path, parsed) => ({
		add: () => {},
		named: (name, kind, via) => {
			if (!gatewayVias.has(via)) return
			// A text match in an unparsed module can sit in a comment or string.
			if (parsed) use(path, name, kind)
			else flag(path, 'unparsedModule')
		},
		computed: (_kind, via) => {
			if (gatewayVias.has(via)) flag(path, 'computed')
		},
		unnamed: (via) => {
			if (via === 'placeholder') flag(path, 'vault')
		},
	}))
	forEachScannableModule(files, (path, parsed, constants) => {
		// A slot's kind decides what credential() can resolve (no kind means
		// fetch-capable only), and source cannot say which kind a key takes.
		const scan: KeyScan = {
			key: (key) => {
				if (!Object.hasOwn(declaredSlots, key)) {
					flag(path, 'undeclaredCredentialKey')
				}
			},
			computed: () => flag(path, 'computed'),
			indirect: () => flag(path, 'indirectCredential'),
		}
		if (parsed) scanParsedCredentialKeys(parsed, constants, scan)
		else scanUnparsedCredentialKeys(files[path]!, scan)
	})
	const add: Array<string> = []
	for (const [name, kinds] of [...uses].sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		const paths = [...(pathsByName.get(name) ?? [])]
		if (Object.hasOwn(declaredSlots, name)) {
			const slot = declaredSlots[name]
			const declaredKind = isPlainObject(slot) ? slot.kind : undefined
			if (declaredKind == null) continue
			const fills = [...kinds].every((kind) =>
				fillingSlotKinds[kind].has(String(declaredKind)),
			)
			if (!fills) for (const path of paths) flag(path, 'kindMismatch')
			continue
		}
		if (!packageCredentialSlotNamePattern.test(name)) {
			for (const path of paths) flag(path, 'invalidKey')
			continue
		}
		add.push(name)
	}
	return {
		add,
		manual: [...manual]
			.sort(([left], [right]) => left.localeCompare(right))
			.flatMap(([path, messages]) =>
				[...messages].map((message) => ({
					path,
					message: declareCredentialNeedsMessages[message],
				})),
			),
		manifestPath: manifestKey,
		manifest,
		source,
	}
}

function detectJsonIndent(source: string) {
	const match = source.match(/\n([ \t]+)"/)
	return match?.[1] ?? '\t'
}

function detectDeclareCredentialNeeds(
	files: Record<string, string>,
	context: PackageCodemodContext,
): Array<PackageCodemodFinding> {
	const plan = planDeclarations(files, context)
	return [
		...(plan.add.length > 0
			? [
					{
						path: plan.manifestPath,
						message: declareCredentialNeedsMessages.declare,
					},
				]
			: []),
		...plan.manual,
	]
}

function transformDeclareCredentialNeeds(
	files: Record<string, string>,
	context: PackageCodemodContext,
): PackageCodemodTransformResult {
	const plan = planDeclarations(files, context)
	if (plan.add.length === 0 || plan.manifest == null || plan.source == null) {
		return {
			files: { ...files },
			changed: false,
			changedPaths: [],
			needsManual: plan.manual,
		}
	}
	const kody = isPlainObject(plan.manifest.kody) ? plan.manifest.kody : {}
	const existing = isPlainObject(kody.credentials) ? kody.credentials : {}
	const credentials = {
		...existing,
		...Object.fromEntries(
			plan.add.map((name) => [
				name,
				{ description: declaredCredentialSlotDescription },
			]),
		),
	}
	const nextSource = `${JSON.stringify(
		{ ...plan.manifest, kody: { ...kody, credentials } },
		null,
		detectJsonIndent(plan.source),
	)}\n`
	return {
		files: { ...files, [plan.manifestPath]: nextSource },
		changed: true,
		changedPaths: [plan.manifestPath],
		needsManual: plan.manual,
	}
}

/**
 * Credential-need enforcement (issue #3822) limits a package run by someone
 * other than its author to the credentials it declares. This adds a
 * kind-less `kody.credentials` slot for every literal name the package fills
 * through the fetch gateway (a kind-less slot does not change how a
 * placeholder resolves), so enforcement changes nothing for those uses.
 * Undeclared `credential()` keys and names it cannot read are left for the
 * owner. Kept registered until enforcement is on and a scoped rescan is
 * clean.
 */
export const declareCredentialNeedsCodemod: PackageCodemod = {
	id: declareCredentialNeedsCodemodId,
	description:
		'Declare a kody.credentials slot for each credential a package fills through the fetch gateway by literal name (placeholders, createAuthenticatedFetch, secretHeaders.basic, oauthClientCredentials); flag undeclared credential() keys and computed names for manual review.',
	applyMode: 'published-only',
	detect: detectDeclareCredentialNeeds,
	transform: transformDeclareCredentialNeeds,
}
