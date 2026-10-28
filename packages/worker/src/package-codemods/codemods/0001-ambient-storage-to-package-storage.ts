import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
import { collectAmbientStorageImportFiles } from '#worker/repo/checks.ts'
import {
	type PackageCodemod,
	type PackageCodemodFinding,
	type PackageCodemodTransformResult,
} from '../types.ts'

export const ambientStorageToPackageStorageCodemodId =
	'0001-ambient-storage-to-package-storage'

const ambientStorageDetectMessage =
	"Imports ambient `storage` from 'kody:runtime'; migrate to `packageStorage()`."

const manualAliasMessage =
	'Ambient `storage` is imported under an alias; migrate to `packageStorage()` manually.'

const manualUnusualMessage =
	"Ambient `storage` import from 'kody:runtime' uses a pattern this codemod will not rewrite; migrate to `packageStorage()` manually."

const manualNonMemberMessage =
	'Ambient `storage` is used as a value (not only as a member-expression object); migrate to `packageStorage()` manually.'

const manualParseFailureMessage =
	"File imports or references ambient `storage` from 'kody:runtime' but could not be parsed; migrate to `packageStorage()` manually."

const manualVerifyMessage =
	'Rewritten file still contains a `storage` identifier; migrate to `packageStorage()` manually.'

const manualExecutionSurfaceMessage =
	'Package declares an app, service, job, subscription, or webhook. Ambient `storage` and `packageStorage()` use different bucket identities for those surfaces; migrate manually to avoid silent data repointing.'

const scannableModuleFilePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/

type NamedImportSpecifier = {
	type: string
	importKind?: unknown
	imported?: { name?: unknown; value?: unknown }
	local?: { name?: unknown; value?: unknown }
	start?: number
	end?: number
}

type ImportDeclarationNode = ModuleAstNode & {
	importKind?: unknown
	source?: { value?: unknown }
	specifiers?: Array<NamedImportSpecifier>
	start?: number
	end?: number
}

type AstNode = ModuleAstNode & {
	name?: unknown
	value?: unknown
	start?: number
	end?: number
	computed?: boolean
	object?: AstNode
	property?: AstNode
	key?: AstNode
	id?: AstNode
	local?: AstNode
	imported?: AstNode
	exported?: AstNode
	params?: Array<AstNode>
	body?: AstNode | Array<AstNode>
	declarations?: Array<AstNode>
	argument?: AstNode
	left?: AstNode
	right?: AstNode
	callee?: AstNode
	arguments?: Array<AstNode>
	elements?: Array<AstNode | null>
	properties?: Array<AstNode>
	param?: AstNode
	program?: { body?: Array<AstNode> }
}

function getNodeName(
	node: AstNode | { name?: unknown; value?: unknown } | null | undefined,
) {
	if (!node) return null
	if (typeof node.name === 'string') return node.name
	if (typeof node.value === 'string') return node.value
	return null
}

function isTypeDeclarationFilePath(path: string) {
	return (
		path.endsWith('.d.ts') || path.endsWith('.d.mts') || path.endsWith('.d.cts')
	)
}

function parseProgram(source: string): AstNode | null {
	try {
		return parseModuleSource(source) as unknown as AstNode
	} catch {
		return null
	}
}

function getProgramBody(parsed: AstNode): Array<AstNode> {
	const program = parsed.program
	const body = program?.body ?? (parsed.body as Array<AstNode> | undefined)
	return Array.isArray(body) ? body : []
}

function walkAst(
	node: AstNode,
	parent: AstNode | null,
	visit: (node: AstNode, parent: AstNode | null) => void,
) {
	visit(node, parent)
	for (const [key, value] of Object.entries(node)) {
		if (
			key === 'loc' ||
			key === 'start' ||
			key === 'end' ||
			key === 'range' ||
			key === 'leadingComments' ||
			key === 'trailingComments' ||
			key === 'innerComments' ||
			key === 'comments'
		) {
			continue
		}
		if (Array.isArray(value)) {
			for (const child of value) {
				if (child && typeof child === 'object' && 'type' in child) {
					walkAst(child as AstNode, node, visit)
				}
			}
			continue
		}
		if (value && typeof value === 'object' && 'type' in value) {
			walkAst(value as AstNode, node, visit)
		}
	}
}

function isNonComputedPropertyName(node: AstNode, parent: AstNode | null) {
	if (!parent) return false
	if (
		(parent.type === 'MemberExpression' ||
			parent.type === 'OptionalMemberExpression') &&
		parent.property === node &&
		parent.computed !== true
	) {
		return true
	}
	if (
		(parent.type === 'ObjectProperty' ||
			parent.type === 'ObjectMethod' ||
			parent.type === 'ClassProperty' ||
			parent.type === 'ClassMethod' ||
			parent.type === 'ClassPrivateProperty' ||
			parent.type === 'Property') &&
		parent.key === node &&
		parent.computed !== true
	) {
		return true
	}
	if (
		parent.type === 'ExportSpecifier' &&
		parent.exported === node &&
		parent.local !== node
	) {
		return true
	}
	return false
}

function isImportStorageSpecifier(node: AstNode, parent: AstNode | null) {
	return (
		parent?.type === 'ImportSpecifier' &&
		(parent.local === node || parent.imported === node)
	)
}

function listRuntimeStorageImports(body: Array<AstNode>) {
	const imports: Array<{
		declaration: ImportDeclarationNode
		storageSpecifiers: Array<NamedImportSpecifier>
		hasPackageStorage: boolean
		hasUnusualSpecifiers: boolean
	}> = []
	for (const node of body) {
		if (node.type !== 'ImportDeclaration') continue
		const declaration = node as ImportDeclarationNode
		if (declaration.importKind === 'type') continue
		if (declaration.source?.value !== 'kody:runtime') continue
		const specifiers = Array.isArray(declaration.specifiers)
			? declaration.specifiers
			: []
		const storageSpecifiers: Array<NamedImportSpecifier> = []
		let hasPackageStorage = false
		let hasUnusualSpecifiers = false
		for (const specifier of specifiers) {
			if (
				specifier.type === 'ImportDefaultSpecifier' ||
				specifier.type === 'ImportNamespaceSpecifier'
			) {
				hasUnusualSpecifiers = true
				continue
			}
			if (specifier.type !== 'ImportSpecifier') continue
			if (specifier.importKind === 'type') continue
			const importedName = getNodeName(specifier.imported)
			const localName = getNodeName(specifier.local)
			if (importedName === 'packageStorage') {
				hasPackageStorage = true
				continue
			}
			if (importedName !== 'storage') continue
			if (localName !== 'storage') {
				hasUnusualSpecifiers = true
			}
			storageSpecifiers.push(specifier)
		}
		if (storageSpecifiers.length === 0) continue
		imports.push({
			declaration,
			storageSpecifiers,
			hasPackageStorage,
			hasUnusualSpecifiers,
		})
	}
	return imports
}

function hasExportReexportOfStorage(body: Array<AstNode>) {
	for (const node of body) {
		if (node.type !== 'ExportNamedDeclaration') continue
		const declaration = node as AstNode & {
			source?: { value?: unknown }
			specifiers?: Array<{
				local?: { name?: unknown; value?: unknown }
				exported?: { name?: unknown; value?: unknown }
			}>
		}
		if (declaration.source?.value !== 'kody:runtime') continue
		for (const specifier of declaration.specifiers ?? []) {
			if (
				getNodeName(specifier.local) === 'storage' ||
				getNodeName(specifier.exported) === 'storage'
			) {
				return true
			}
		}
	}
	return false
}

function hasStorageBindingSite(parsed: AstNode) {
	let found = false
	walkAst(parsed, null, (node, parent) => {
		if (found) return
		if (node.type !== 'Identifier' || getNodeName(node) !== 'storage') return
		if (isNonComputedPropertyName(node, parent)) return
		if (isImportStorageSpecifier(node, parent)) return
		if (parent?.type === 'VariableDeclarator' && parent.id === node) {
			found = true
			return
		}
		if (
			(parent?.type === 'FunctionDeclaration' ||
				parent?.type === 'FunctionExpression' ||
				parent?.type === 'ArrowFunctionExpression' ||
				parent?.type === 'ClassMethod' ||
				parent?.type === 'ObjectMethod') &&
			Array.isArray(parent.params) &&
			parent.params.includes(node)
		) {
			found = true
			return
		}
		if (parent?.type === 'CatchClause' && parent.param === node) {
			found = true
			return
		}
		if (parent?.type === 'AssignmentPattern' && parent.left === node) {
			found = true
		}
	})
	return found
}

function collectStorageMemberUseSites(parsed: AstNode): {
	memberObjects: Array<{ start: number; end: number }>
	nonMemberUses: boolean
} {
	const memberObjects: Array<{ start: number; end: number }> = []
	let nonMemberUses = false
	walkAst(parsed, null, (node, parent) => {
		if (node.type !== 'Identifier' || getNodeName(node) !== 'storage') return
		if (isNonComputedPropertyName(node, parent)) return
		if (isImportStorageSpecifier(node, parent)) return
		if (
			(parent?.type === 'MemberExpression' ||
				parent?.type === 'OptionalMemberExpression') &&
			parent.object === node &&
			typeof node.start === 'number' &&
			typeof node.end === 'number'
		) {
			memberObjects.push({ start: node.start, end: node.end })
			return
		}
		nonMemberUses = true
	})
	return { memberObjects, nonMemberUses }
}

function remainingStorageIdentifiers(parsed: AstNode) {
	const remaining: Array<AstNode> = []
	walkAst(parsed, null, (node, parent) => {
		if (node.type !== 'Identifier' || getNodeName(node) !== 'storage') return
		if (isNonComputedPropertyName(node, parent)) return
		remaining.push(node)
	})
	return remaining
}

function removeSpecifierFromImportText(input: {
	source: string
	declaration: ImportDeclarationNode
	specifier: NamedImportSpecifier
}) {
	const declarationStart = input.declaration.start
	const declarationEnd = input.declaration.end
	const specifierStart = input.specifier.start
	const specifierEnd = input.specifier.end
	if (
		declarationStart == null ||
		declarationEnd == null ||
		specifierStart == null ||
		specifierEnd == null
	) {
		return null
	}
	const declarationText = input.source.slice(declarationStart, declarationEnd)
	const relativeStart = specifierStart - declarationStart
	const relativeEnd = specifierEnd - declarationStart
	const before = declarationText.slice(0, relativeStart)
	const after = declarationText.slice(relativeEnd)
	const beforeTrimmed = before.replace(/\s*,\s*$/, '')
	const afterTrimmed = after.replace(/^\s*,\s*/, (match) =>
		beforeTrimmed.trimEnd().endsWith('{') ? match.replace(',', '') : match,
	)
	let nextDeclaration = `${beforeTrimmed}${afterTrimmed}`
	nextDeclaration = nextDeclaration.replace(/\{\s*,/, '{')
	nextDeclaration = nextDeclaration.replace(/,\s*\}/, ' }')
	nextDeclaration = nextDeclaration.replace(/\{\s+\}/, '{}')
	return (
		input.source.slice(0, declarationStart) +
		nextDeclaration +
		input.source.slice(declarationEnd)
	)
}

function replaceSpecifierNameInImportText(input: {
	source: string
	specifier: NamedImportSpecifier
	nextName: string
}) {
	const start = input.specifier.start
	const end = input.specifier.end
	if (start == null || end == null) return null
	return input.source.slice(0, start) + input.nextName + input.source.slice(end)
}

function applyRangeReplacements(
	source: string,
	replacements: Array<{ start: number; end: number; text: string }>,
) {
	const ordered = [...replacements].sort(
		(left, right) => right.start - left.start,
	)
	let next = source
	for (const replacement of ordered) {
		next =
			next.slice(0, replacement.start) +
			replacement.text +
			next.slice(replacement.end)
	}
	return next
}

function packageDeclaresNonExportExecutionSurface(
	files: Record<string, string>,
) {
	const raw = files['package.json']
	if (typeof raw !== 'string') {
		return {
			blocked: true as const,
			message:
				'package.json is missing; cannot confirm the package is export-only before migrating ambient storage.',
		}
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		return {
			blocked: true as const,
			message:
				'package.json could not be parsed; cannot confirm the package is export-only before migrating ambient storage.',
		}
	}
	if (!parsed || typeof parsed !== 'object') {
		return {
			blocked: true as const,
			message: manualExecutionSurfaceMessage,
		}
	}
	const kody = (parsed as { kody?: unknown }).kody
	if (!kody || typeof kody !== 'object') {
		return { blocked: false as const }
	}
	const record = kody as Record<string, unknown>
	const surfaceKeys = ['app', 'jobs', 'subscriptions', 'webhooks'] as const
	for (const key of surfaceKeys) {
		const value = record[key]
		if (value == null) continue
		if (Array.isArray(value) && value.length === 0) continue
		if (
			typeof value === 'object' &&
			!Array.isArray(value) &&
			Object.keys(value).length === 0
		) {
			continue
		}
		return { blocked: true as const, message: manualExecutionSurfaceMessage }
	}
	return { blocked: false as const }
}

function listParseFailureCandidates(files: Record<string, string>) {
	const paths: Array<string> = []
	for (const [path, source] of Object.entries(files)) {
		if (!scannableModuleFilePattern.test(path)) continue
		if (isTypeDeclarationFilePath(path)) continue
		if (!source.includes('kody:runtime') || !source.includes('storage'))
			continue
		if (parseProgram(source) == null) {
			paths.push(path)
		}
	}
	return paths.sort((left, right) => left.localeCompare(right))
}

function transformSourceFile(source: string): {
	content: string
	changed: boolean
	needsManual: string | null
} {
	const parsed = parseProgram(source)
	if (!parsed) {
		return {
			content: source,
			changed: false,
			needsManual: manualParseFailureMessage,
		}
	}
	const body = getProgramBody(parsed)
	const imports = listRuntimeStorageImports(body)
	if (imports.length === 0) {
		return { content: source, changed: false, needsManual: null }
	}
	if (imports.length > 1) {
		return {
			content: source,
			changed: false,
			needsManual: manualUnusualMessage,
		}
	}
	const target = imports[0]!
	if (target.hasUnusualSpecifiers) {
		return {
			content: source,
			changed: false,
			needsManual: manualAliasMessage,
		}
	}
	if (target.storageSpecifiers.length !== 1) {
		return {
			content: source,
			changed: false,
			needsManual: manualUnusualMessage,
		}
	}
	if (hasExportReexportOfStorage(body)) {
		return {
			content: source,
			changed: false,
			needsManual: manualUnusualMessage,
		}
	}
	const storageSpecifier = target.storageSpecifiers[0]!
	if (
		typeof target.declaration.start !== 'number' ||
		typeof storageSpecifier.start !== 'number' ||
		typeof storageSpecifier.end !== 'number'
	) {
		return {
			content: source,
			changed: false,
			needsManual: manualUnusualMessage,
		}
	}
	if (hasStorageBindingSite(parsed)) {
		return {
			content: source,
			changed: false,
			needsManual: manualUnusualMessage,
		}
	}
	const { memberObjects, nonMemberUses } = collectStorageMemberUseSites(parsed)
	if (nonMemberUses) {
		return {
			content: source,
			changed: false,
			needsManual: manualNonMemberMessage,
		}
	}
	if (memberObjects.length === 0) {
		return {
			content: source,
			changed: false,
			needsManual: manualUnusualMessage,
		}
	}

	let nextSource = applyRangeReplacements(
		source,
		memberObjects.map((range) => ({
			...range,
			text: 'packageStorage()',
		})),
	)

	const reparsedAfterUses = parseProgram(nextSource)
	if (!reparsedAfterUses) {
		return {
			content: source,
			changed: false,
			needsManual: manualUnusualMessage,
		}
	}
	const nextImports = listRuntimeStorageImports(
		getProgramBody(reparsedAfterUses),
	)
	const nextTarget = nextImports[0]
	if (!nextTarget || nextTarget.storageSpecifiers.length !== 1) {
		return {
			content: source,
			changed: false,
			needsManual: manualUnusualMessage,
		}
	}
	const nextStorageSpecifier = nextTarget.storageSpecifiers[0]!
	const alreadyHasPackageStorage = nextTarget.hasPackageStorage
	const withImport = alreadyHasPackageStorage
		? removeSpecifierFromImportText({
				source: nextSource,
				declaration: nextTarget.declaration,
				specifier: nextStorageSpecifier,
			})
		: replaceSpecifierNameInImportText({
				source: nextSource,
				specifier: nextStorageSpecifier,
				nextName: 'packageStorage',
			})
	if (withImport == null) {
		return {
			content: source,
			changed: false,
			needsManual: manualUnusualMessage,
		}
	}
	nextSource = withImport

	const verified = parseProgram(nextSource)
	if (!verified) {
		return {
			content: source,
			changed: false,
			needsManual: manualUnusualMessage,
		}
	}
	if (remainingStorageIdentifiers(verified).length > 0) {
		return {
			content: source,
			changed: false,
			needsManual: manualVerifyMessage,
		}
	}
	if (listRuntimeStorageImports(getProgramBody(verified)).length > 0) {
		return {
			content: source,
			changed: false,
			needsManual: manualVerifyMessage,
		}
	}
	if (nextSource === source) {
		return { content: source, changed: false, needsManual: null }
	}
	return { content: nextSource, changed: true, needsManual: null }
}

function detectAmbientStorage(
	files: Record<string, string>,
): Array<PackageCodemodFinding> {
	const findings: Array<PackageCodemodFinding> =
		collectAmbientStorageImportFiles(files).map((path) => ({
			path,
			message: ambientStorageDetectMessage,
		}))
	for (const path of listParseFailureCandidates(files)) {
		if (findings.some((finding) => finding.path === path)) continue
		findings.push({ path, message: manualParseFailureMessage })
	}
	findings.sort((left, right) =>
		(left.path ?? '').localeCompare(right.path ?? ''),
	)
	return findings
}

function transformAmbientStorage(
	files: Record<string, string>,
): PackageCodemodTransformResult {
	const ambientPaths = collectAmbientStorageImportFiles(files)
	const parseFailurePaths = listParseFailureCandidates(files)
	const candidatePaths = [
		...new Set([...ambientPaths, ...parseFailurePaths]),
	].sort((left, right) => left.localeCompare(right))

	if (candidatePaths.length === 0) {
		return {
			files: { ...files },
			changed: false,
			changedPaths: [],
			needsManual: [],
		}
	}

	const surfaceGate = packageDeclaresNonExportExecutionSurface(files)
	if (surfaceGate.blocked) {
		return {
			files: { ...files },
			changed: false,
			changedPaths: [],
			needsManual: candidatePaths.map((path) => ({
				path,
				message: surfaceGate.message,
			})),
		}
	}

	const nextFiles: Record<string, string> = { ...files }
	const changedPaths: Array<string> = []
	const needsManual: Array<PackageCodemodFinding> = []
	for (const path of candidatePaths) {
		const source = files[path]
		if (typeof source !== 'string') continue
		const result = transformSourceFile(source)
		if (result.needsManual) {
			needsManual.push({ path, message: result.needsManual })
			continue
		}
		if (!result.changed) continue
		nextFiles[path] = result.content
		changedPaths.push(path)
	}
	return {
		files: nextFiles,
		changed: changedPaths.length > 0,
		changedPaths,
		needsManual,
	}
}

/**
 * Permanent repair path for the publish-time ambient-storage guard. It remains
 * available so package authors can remediate rejected source safely.
 */
export const ambientStorageToPackageStorageCodemod = {
	id: ambientStorageToPackageStorageCodemodId,
	description:
		"Replace ambient `storage` member uses from 'kody:runtime' with `packageStorage()` call sites.",
	detect: detectAmbientStorage,
	transform: transformAmbientStorage,
} satisfies PackageCodemod
