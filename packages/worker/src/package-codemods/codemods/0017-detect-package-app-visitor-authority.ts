import {
	type AstNode,
	getCalleeName,
	getNodeName,
	listScannableModulePaths,
	parseModule,
	walkAst,
} from '#worker/credentials/module-placeholder-scan.ts'
import {
	type PackageCodemod,
	type PackageCodemodFinding,
	type PackageCodemodTransformResult,
} from '../types.ts'
import { scanModuleCredentialReferences } from './0010-detect-legacy-credential-patterns.ts'

export const detectPackageAppVisitorAuthorityCodemodId =
	'0017-detect-package-app-visitor-authority'

export const packageAppVisitorAuthorityPatterns = [
	'undeclared capability',
	'computed capability',
	'kody.mcp',
	'visitor credential',
	'identity email',
] as const

export type PackageAppVisitorAuthorityPattern =
	(typeof packageAppVisitorAuthorityPatterns)[number]

/**
 * Fixed messages only: findings reach the fleet operator, so they never
 * carry a capability name, credential name, or file contents.
 */
export const packageAppVisitorAuthorityPatternMessages: Record<
	PackageAppVisitorAuthorityPattern,
	string
> = {
	'undeclared capability':
		'undeclared capability: the app calls a kody capability that kody.app.capabilities does not list. It runs with the visitor’s authority only through the logged fallback. List it in kody.app.capabilities to run it as the publisher.',
	'computed capability':
		'computed capability: the app picks a kody capability name at run time. List every capability it can call in kody.app.capabilities.',
	'kody.mcp':
		'kody.mcp: the app calls an MCP server tool. It runs with the visitor’s authority only through the logged fallback.',
	'visitor credential':
		'visitor credential: the app uses credentials and opts no need into ownerCredentialForVisitors. Signed-in visitors now get the publisher’s credentials; declare a kody.app.visitorNeeds entry and open it with credential.visitor(need) to keep using their own.',
	'identity email':
		'identity email: the app reads the visitor’s email from metaGetCurrentUser. Email needs the visitor’s email consent in Sign in with Kody.',
}

export function packageAppVisitorAuthorityPatternFromMessage(
	message: string,
): PackageAppVisitorAuthorityPattern | null {
	for (const pattern of packageAppVisitorAuthorityPatterns) {
		if (packageAppVisitorAuthorityPatternMessages[pattern] === message) {
			return pattern
		}
	}
	return null
}

const packageManifestPath = 'package.json'
const identityCapabilityName = 'metaGetCurrentUser'
/** Bridge calls that never need a kody.app.capabilities entry. */
const alwaysAvailableCalls = new Set([identityCapabilityName, 'visitorNeed'])

export type AppManifest = {
	capabilities: Set<string>
	visitorNeeds: number
	ownerCredentialForVisitors: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
}

export function readPackageAppManifest(
	source: string | undefined,
): AppManifest | null {
	if (source == null) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(source)
	} catch {
		return null
	}
	if (!isPlainObject(parsed) || !isPlainObject(parsed.kody)) return null
	const { app, credentials } = parsed.kody
	if (!isPlainObject(app)) return null
	const capabilities = new Set(
		Array.isArray(app.capabilities)
			? app.capabilities.filter((name) => typeof name === 'string')
			: [],
	)
	const visitorNeeds = isPlainObject(app.visitorNeeds)
		? Object.keys(app.visitorNeeds).length
		: 0
	const ownerCredentialForVisitors =
		isPlainObject(credentials) &&
		Object.values(credentials).some(
			(need) => isPlainObject(need) && need.ownerCredentialForVisitors === true,
		)
	return { capabilities, visitorNeeds, ownerCredentialForVisitors }
}

/** A module-level `kody` that is not the runtime bridge (`const kody = …`, another module's `kody`). */
function declaresTopLevelBinding(body: Array<AstNode>, name: string) {
	const runtimeNamespaces = new Set<string>()
	for (const node of body) {
		if (node.type !== 'ImportDeclaration') continue
		if (getNodeName(node.source) !== 'kody:runtime') continue
		for (const specifier of node.specifiers ?? []) {
			if (specifier.type !== 'ImportNamespaceSpecifier') continue
			const local = getNodeName(specifier.local)
			if (local) runtimeNamespaces.add(local)
		}
	}
	const readsRuntimeBridge = (init: AstNode | undefined) =>
		isMemberExpression(init) &&
		init?.object?.type === 'Identifier' &&
		runtimeNamespaces.has(getNodeName(init.object) ?? '') &&
		getNodeName(init.property) === 'kody'
	return body.some((node) => {
		const declaration =
			node.type === 'ExportNamedDeclaration' ? node.declaration : node
		if (declaration?.type === 'VariableDeclaration') {
			return (declaration.declarations ?? []).some(
				(declarator: AstNode) =>
					getNodeName(declarator.id) === name &&
					!readsRuntimeBridge(declarator.init),
			)
		}
		if (
			declaration?.type === 'FunctionDeclaration' ||
			declaration?.type === 'ClassDeclaration'
		) {
			return getNodeName(declaration.id) === name
		}
		if (node.type === 'ImportDeclaration') {
			if (getNodeName(node.source) === 'kody:runtime') return false
			return (node.specifiers ?? []).some(
				(specifier: AstNode) => getNodeName(specifier.local) === name,
			)
		}
		return false
	})
}

function collectKodyAliases(body: Array<AstNode>) {
	const aliases = new Set<string>(
		declaresTopLevelBinding(body, 'kody') ? [] : ['kody'],
	)
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

function isMemberExpression(node: AstNode | undefined) {
	return (
		node?.type === 'MemberExpression' ||
		node?.type === 'OptionalMemberExpression'
	)
}

function isKodyObject(node: AstNode | undefined, aliases: Set<string>) {
	return node?.type === 'Identifier' && aliases.has(getNodeName(node) ?? '')
}

export type ModuleKodyCalls = {
	/** Capability names called with a static name (`kody.x()`, `kody['x']()`). */
	names: Set<string>
	/** Calls whose capability name is picked at run time. */
	computedCalls: number
	/** `kody.mcp` member reads. */
	mcpCalls: number
	readsEmail: boolean
}

/**
 * The kody bridge calls one parsed module makes. Shared with the
 * import-closure scan in `package-app-capability-closure.ts`.
 */
export function collectModuleKodyCalls(parsed: AstNode): ModuleKodyCalls {
	const aliases = collectKodyAliases(parsed.program?.body ?? [])
	const calls: ModuleKodyCalls = {
		names: new Set(),
		computedCalls: 0,
		mcpCalls: 0,
		readsEmail: false,
	}
	walkAst(parsed, (node) => {
		if (
			node.type === 'CallExpression' ||
			node.type === 'OptionalCallExpression'
		) {
			const callee = node.callee
			if (
				!isMemberExpression(callee) ||
				!isKodyObject(callee?.object, aliases)
			) {
				return
			}
			if (callee?.computed === true) {
				const literal =
					callee.property?.type === 'StringLiteral'
						? getNodeName(callee.property)
						: null
				if (literal == null) calls.computedCalls += 1
				else calls.names.add(literal)
				return
			}
			const name = getCalleeName(callee)
			if (name != null) calls.names.add(name)
			return
		}
		if (isMemberExpression(node)) {
			if (
				isKodyObject(node.object, aliases) &&
				getNodeName(node.property) === 'mcp'
			) {
				calls.mcpCalls += 1
			}
			if (node.computed !== true && getNodeName(node.property) === 'email') {
				calls.readsEmail = true
			}
			return
		}
		if (node.type === 'ObjectPattern') {
			for (const property of node.properties ?? []) {
				if (
					property.type === 'ObjectProperty' &&
					getNodeName(property.key) === 'email'
				) {
					calls.readsEmail = true
				}
			}
		}
	})
	return calls
}

/** Whether a statically named call needs a `kody.app.capabilities` entry. */
export function needsCapabilityDeclaration(name: string) {
	return !alwaysAvailableCalls.has(name)
}

function detectInModule(
	parsed: AstNode,
	app: AppManifest,
	add: (pattern: PackageAppVisitorAuthorityPattern) => void,
) {
	const calls = collectModuleKodyCalls(parsed)
	if (calls.computedCalls > 0) add('computed capability')
	for (const name of calls.names) {
		if (needsCapabilityDeclaration(name) && !app.capabilities.has(name)) {
			add('undeclared capability')
			break
		}
	}
	if (calls.mcpCalls > 0) add('kody.mcp')
	if (calls.names.has(identityCapabilityName) && calls.readsEmail) {
		add('identity email')
	}
}

function usesCredentialHelper(parsed: AstNode) {
	let uses = false
	walkAst(parsed, (node) => {
		if (uses) return
		if (
			node.type !== 'CallExpression' &&
			node.type !== 'OptionalCallExpression'
		) {
			return
		}
		const callee = node.callee
		if (callee?.type === 'Identifier') {
			const name = getNodeName(callee)
			uses = name === 'credential' || name === 'credentials'
			return
		}
		if (isMemberExpression(callee) && callee?.object?.type === 'Identifier') {
			const objectName = getNodeName(callee.object)
			uses =
				objectName === 'credential' && getNodeName(callee.property) === 'named'
		}
	})
	return uses
}

function detectPackageAppVisitorAuthority(
	files: Record<string, string>,
): Array<PackageCodemodFinding> {
	const app = readPackageAppManifest(
		Object.hasOwn(files, packageManifestPath)
			? files[packageManifestPath]
			: undefined,
	)
	if (!app) return []
	const patternsByPath = new Map<
		string,
		Set<PackageAppVisitorAuthorityPattern>
	>()
	const patternsFor = (path: string) => {
		let patterns = patternsByPath.get(path)
		if (!patterns) {
			patterns = new Set()
			patternsByPath.set(path, patterns)
		}
		return patterns
	}
	const credentialPaths = new Set<string>()
	for (const path of listScannableModulePaths(files)) {
		const parsed = parseModule(files[path]!)
		if (!parsed) continue
		detectInModule(parsed, app, (pattern) => patternsFor(path).add(pattern))
		if (usesCredentialHelper(parsed)) credentialPaths.add(path)
	}
	scanModuleCredentialReferences(files, (path) => {
		const note = () => credentialPaths.add(path)
		return { add: () => {}, named: note, computed: note, unnamed: note }
	})
	if (!app.ownerCredentialForVisitors && app.visitorNeeds === 0) {
		for (const path of credentialPaths)
			patternsFor(path).add('visitor credential')
	}
	const findings: Array<PackageCodemodFinding> = []
	for (const [path, patterns] of patternsByPath) {
		for (const pattern of packageAppVisitorAuthorityPatterns) {
			if (patterns.has(pattern)) {
				findings.push({
					path,
					message: packageAppVisitorAuthorityPatternMessages[pattern],
				})
			}
		}
	}
	return findings.sort((left, right) =>
		(left.path ?? '').localeCompare(right.path ?? ''),
	)
}

function transformPackageAppVisitorAuthority(
	files: Record<string, string>,
): PackageCodemodTransformResult {
	return {
		files,
		changed: false,
		changedPaths: [],
		needsManual: detectPackageAppVisitorAuthority(files),
	}
}

export const detectPackageAppVisitorAuthorityCodemod: PackageCodemod = {
	id: detectPackageAppVisitorAuthorityCodemodId,
	description:
		'Detect only (writes nothing): find package apps that would lean on the visitor-authority fallback now that apps run as their publisher (kody capabilities missing from kody.app.capabilities, computed capability names, kody.mcp calls), apps whose signed-in visitors now get the publisher’s credentials, and apps that read the visitor’s email.',
	detect: detectPackageAppVisitorAuthority,
	transform: transformPackageAppVisitorAuthority,
}
