import { normalizeUsername } from '#worker/identity/username.ts'
import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
import type {
	PackageCodemod,
	PackageCodemodContext,
	PackageCodemodFinding,
	PackageCodemodTransformResult,
} from '../types.ts'

export const invokeObjectToSpecifierCodemodId =
	'0006-invoke-object-to-specifier'

const rewriteDetectMessage =
	'Uses the removed object-only `packages.invoke({ kodyId, exportName, ... })` API; rewrite to the scoped string-first specifier API required by publish checks.'
const manualRewriteMessage =
	'Uses the removed object-only `packages.invoke` API in a shape that cannot be migrated safely; pass the scoped `kody:@owner/package` specifier manually.'
const manifestScopeMessage =
	'Package scope could not be read from package.json; migrate removed object-only `packages.invoke` calls manually.'
const orgScopeMismatchMessage =
	"The package.json scope is not the package's org. Removed object-only `packages.invoke` targets resolved in the package's org, so rewriting to the manifest scope would retarget them; migrate this call manually."
const parseFailureMessage =
	'File references `packages.invoke` but could not be parsed; migrate any removed object-only calls manually.'

const packageManifestPath = 'package.json'
const scannableModuleFilePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/
const markdownFilePattern = /\.mdx?$/
const markdownModuleLanguages = new Set([
	'cjs',
	'cts',
	'javascript',
	'js',
	'jsx',
	'mjs',
	'mts',
	'ts',
	'tsx',
	'typescript',
])
const supportedOptionKeys = new Set([
	'exportName',
	'params',
	'idempotencyKey',
	'topic',
])
type AstNode = ModuleAstNode & {
	start?: number
	end?: number
	computed?: boolean
	name?: unknown
	value?: unknown
	callee?: AstNode
	object?: AstNode
	property?: AstNode
	arguments?: Array<AstNode>
	properties?: Array<AstNode>
	key?: AstNode
}

type SourceRewrite = {
	start: number
	end: number
	replacement: string
}

type FileClassification = {
	path: string
	rewrites: Array<SourceRewrite>
	manualMessage: string | null
}

type MarkdownCodeFence = {
	start: number
	end: number
	contentStart: number
	contentEnd: number
	language: string
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

function readPackageName(files: Record<string, string>): string | null {
	const source = files[packageManifestPath]
	if (typeof source !== 'string') return null
	try {
		const parsed: unknown = JSON.parse(source)
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return null
		}
		const name = (parsed as Record<string, unknown>)['name']
		if (typeof name !== 'string') return null
		const trimmedName = name.trim()
		return /^@[^/\s]+\/[^/\s]+$/.test(trimmedName) ? trimmedName : null
	} catch {
		return null
	}
}

function readPackageScope(files: Record<string, string>): string | null {
	const packageName = readPackageName(files)
	if (!packageName) return null
	const match = /^@([^/\s]+)\/[^/\s]+$/.exec(packageName)
	return match?.[1] ? `@${match[1]}` : null
}

function scopeIsPackageOrg(scope: string, context: PackageCodemodContext) {
	const orgScope = /^@([^/\s]+)\//.exec(context.packageName.trim())?.[1]
	return (
		orgScope != null &&
		normalizeUsername(scope.replace(/^@/, '')) === normalizeUsername(orgScope)
	)
}

function isPackagesInvokeCall(node: AstNode) {
	if (
		node.type !== 'CallExpression' &&
		node.type !== 'OptionalCallExpression'
	) {
		return false
	}
	const callee = node.callee
	return (
		(callee?.type === 'MemberExpression' ||
			callee?.type === 'OptionalMemberExpression') &&
		callee.computed !== true &&
		callee.object?.type === 'Identifier' &&
		callee.object.name === 'packages' &&
		callee.property?.type === 'Identifier' &&
		callee.property.name === 'invoke'
	)
}

function readStaticPropertyName(property: AstNode): string | null {
	if (
		(property.type !== 'ObjectProperty' && property.type !== 'Property') ||
		property.computed === true
	) {
		return null
	}
	const key = property.key
	if (key?.type === 'Identifier' && typeof key.name === 'string') {
		return key.name
	}
	if (
		(key?.type === 'StringLiteral' || key?.type === 'Literal') &&
		typeof key.value === 'string'
	) {
		return key.value
	}
	return null
}

function readStringLiteral(node: AstNode | undefined): string | null {
	if (
		(node?.type === 'StringLiteral' || node?.type === 'Literal') &&
		typeof node.value === 'string'
	) {
		return node.value
	}
	return null
}

function buildOptionsSource(input: {
	source: string
	objectNode: AstNode
	properties: Array<AstNode>
	kodyIdProperty: AstNode
}): string | null {
	const { objectNode, properties, kodyIdProperty, source } = input
	if (
		typeof objectNode.start !== 'number' ||
		typeof objectNode.end !== 'number' ||
		typeof kodyIdProperty.start !== 'number' ||
		typeof kodyIdProperty.end !== 'number'
	) {
		return null
	}
	const propertyIndex = properties.indexOf(kodyIdProperty)
	if (propertyIndex === -1 || properties.length < 2) return null
	let removalStart: number
	let removalEnd: number
	if (propertyIndex < properties.length - 1) {
		const nextProperty = properties[propertyIndex + 1]
		if (typeof nextProperty?.start !== 'number') return null
		removalStart = kodyIdProperty.start
		removalEnd = nextProperty.start
	} else {
		const previousProperty = properties[propertyIndex - 1]
		if (typeof previousProperty?.end !== 'number') return null
		removalStart = previousProperty.end
		removalEnd = kodyIdProperty.end
	}
	const removedSource = source.slice(removalStart, removalEnd)
	if (removedSource.includes('//') || removedSource.includes('/*')) {
		return null
	}
	return (
		source.slice(objectNode.start, removalStart) +
		source.slice(removalEnd, objectNode.end)
	)
}

function classifyObjectCall(input: {
	source: string
	scope: string
	objectNode: AstNode
}): SourceRewrite | null {
	const properties = input.objectNode.properties
	if (!properties || properties.length === 0) return null
	const namedProperties = properties.map((property) => ({
		property,
		name: readStaticPropertyName(property),
	}))
	if (namedProperties.some((entry) => entry.name == null)) return null
	const kodyIdEntries = namedProperties.filter(
		(entry) => entry.name === 'kodyId',
	)
	if (kodyIdEntries.length !== 1) return null
	if (namedProperties.some((entry) => entry.name === 'packageId')) return null
	if (
		namedProperties.some(
			(entry) =>
				entry.name !== 'kodyId' && !supportedOptionKeys.has(entry.name ?? ''),
		)
	) {
		return null
	}
	const kodyIdProperty = kodyIdEntries[0]?.property
	if (!kodyIdProperty) return null
	const kodyId = readStringLiteral(
		(kodyIdProperty as { value?: AstNode }).value,
	)?.trim()
	if (
		!kodyId ||
		kodyId.includes('/') ||
		Array.from(kodyId).some((character) => /\s/.test(character))
	) {
		return null
	}
	if (!namedProperties.some((entry) => entry.name === 'exportName')) return null
	const optionsSource = buildOptionsSource({
		source: input.source,
		objectNode: input.objectNode,
		properties,
		kodyIdProperty,
	})
	if (
		optionsSource == null ||
		typeof input.objectNode.start !== 'number' ||
		typeof input.objectNode.end !== 'number'
	) {
		return null
	}
	return {
		start: input.objectNode.start,
		end: input.objectNode.end,
		replacement: `${JSON.stringify(`kody:${input.scope}/${kodyId}`)}, ${optionsSource}`,
	}
}

function rewritesOverlap(rewrites: Array<SourceRewrite>) {
	const sorted = [...rewrites].sort((left, right) => left.start - right.start)
	return sorted.some(
		(rewrite, index) =>
			index > 0 && (sorted[index - 1]?.end ?? 0) > rewrite.start,
	)
}

function classifyModuleSource(input: {
	path: string
	source: string
	scope: string
	offset?: number
}): FileClassification | null {
	if (!input.source.includes('packages') || !input.source.includes('invoke')) {
		return null
	}
	const program = parseProgram(input.source)
	if (!program) {
		return /packages\s*\??\.\s*invoke\b/.test(input.source)
			? {
					path: input.path,
					rewrites: [],
					manualMessage: parseFailureMessage,
				}
			: null
	}
	const rewrites: Array<SourceRewrite> = []
	let manual = false

	function visit(node: unknown): void {
		if (node == null || typeof node !== 'object') return
		if (Array.isArray(node)) {
			for (const item of node) visit(item)
			return
		}
		if (!('type' in node)) return
		const typedNode = node as AstNode
		if (isPackagesInvokeCall(typedNode)) {
			const args = typedNode.arguments ?? []
			const firstArg = args[0]
			if (args.length >= 2) {
				// String-first calls have an options argument and are already migrated.
			} else if (
				firstArg?.type === 'StringLiteral' ||
				firstArg?.type === 'TemplateLiteral' ||
				(firstArg?.type === 'Literal' && typeof firstArg.value === 'string')
			) {
				// A one-argument specifier call is already migrated.
			} else if (firstArg?.type === 'ObjectExpression') {
				const rewrite = classifyObjectCall({
					source: input.source,
					scope: input.scope,
					objectNode: firstArg,
				})
				if (rewrite) rewrites.push(rewrite)
				else manual = true
			} else if (firstArg) {
				manual = true
			}
		}
		for (const value of Object.values(node as Record<string, unknown>)) {
			if (value != null && typeof value === 'object') visit(value)
		}
	}

	visit(program)
	if (rewrites.length === 0 && !manual) return null
	const offset = input.offset ?? 0
	const offsetRewrites = rewrites.map((rewrite) => ({
		...rewrite,
		start: rewrite.start + offset,
		end: rewrite.end + offset,
	}))
	return {
		path: input.path,
		rewrites: offsetRewrites,
		manualMessage:
			manual || rewritesOverlap(rewrites) ? manualRewriteMessage : null,
	}
}

function listMarkdownCodeFences(source: string): Array<MarkdownCodeFence> {
	const fences: Array<MarkdownCodeFence> = []
	const openerPattern = /^(?: {0,3})(`{3,}|~{3,})([^\n]*)\r?\n/gm
	let opener: RegExpExecArray | null
	while ((opener = openerPattern.exec(source))) {
		const marker = opener[1]
		if (!marker) continue
		const markerCharacter = marker[0]
		if (!markerCharacter) continue
		const contentStart = opener.index + opener[0].length
		const closingPattern = new RegExp(
			`^(?: {0,3})${markerCharacter === '`' ? '`' : '~'}{${marker.length},}[ \\t]*\\r?$`,
			'gm',
		)
		closingPattern.lastIndex = contentStart
		const closing = closingPattern.exec(source)
		if (!closing) break
		const language = (opener[2] ?? '').trim().split(/\s+/, 1)[0]?.toLowerCase()
		fences.push({
			start: opener.index,
			end: closing.index + closing[0].length,
			contentStart,
			contentEnd: closing.index,
			language: language ?? '',
		})
		openerPattern.lastIndex = closing.index + closing[0].length
	}
	return fences
}

function rangeOverlaps(
	range: { start: number; end: number },
	ranges: ReadonlyArray<{ start: number; end: number }>,
) {
	return ranges.some(
		(candidate) => range.start < candidate.end && candidate.start < range.end,
	)
}

function sourceOutsideRangesHasDeprecatedObjectCall(
	source: string,
	ranges: ReadonlyArray<{ start: number; end: number }>,
) {
	const sorted = [...ranges].sort((left, right) => left.start - right.start)
	let cursor = 0
	for (const range of sorted) {
		if (
			/packages\s*\??\.\s*invoke\s*\(\s*\{/.test(
				source.slice(cursor, range.start),
			)
		) {
			return true
		}
		cursor = Math.max(cursor, range.end)
	}
	return /packages\s*\??\.\s*invoke\s*\(\s*\{/.test(source.slice(cursor))
}

function classifyMarkdownFile(input: {
	path: string
	source: string
	scope: string
}): FileClassification | null {
	if (!input.source.includes('packages') || !input.source.includes('invoke')) {
		return null
	}
	const fences = listMarkdownCodeFences(input.source)
	const coveredRanges: Array<{ start: number; end: number }> = fences.map(
		(fence) => ({ start: fence.start, end: fence.end }),
	)
	const rewrites: Array<SourceRewrite> = []
	let manualMessage: string | null = null
	for (const fence of fences) {
		const content = input.source.slice(fence.contentStart, fence.contentEnd)
		if (!markdownModuleLanguages.has(fence.language)) {
			if (/packages\s*\??\.\s*invoke\s*\(\s*\{/.test(content)) {
				manualMessage ??= manualRewriteMessage
			}
			continue
		}
		const classification = classifyModuleSource({
			path: input.path,
			source: content,
			scope: input.scope,
			offset: fence.contentStart,
		})
		if (!classification) continue
		rewrites.push(...classification.rewrites)
		manualMessage ??= classification.manualMessage
	}

	const inlineCodePattern = /`([^`\n]+)`/g
	let inlineCode: RegExpExecArray | null
	while ((inlineCode = inlineCodePattern.exec(input.source))) {
		const fullRange = {
			start: inlineCode.index,
			end: inlineCode.index + inlineCode[0].length,
		}
		if (rangeOverlaps(fullRange, coveredRanges)) continue
		coveredRanges.push(fullRange)
		const content = inlineCode[1] ?? ''
		const classification = classifyModuleSource({
			path: input.path,
			source: content,
			scope: input.scope,
			offset: inlineCode.index + 1,
		})
		if (!classification) continue
		rewrites.push(...classification.rewrites)
		manualMessage ??= classification.manualMessage
	}

	if (sourceOutsideRangesHasDeprecatedObjectCall(input.source, coveredRanges)) {
		manualMessage ??= manualRewriteMessage
	}
	if (rewrites.length === 0 && manualMessage == null) return null
	return {
		path: input.path,
		rewrites,
		manualMessage:
			manualMessage ??
			(rewritesOverlap(rewrites) ? manualRewriteMessage : null),
	}
}

function classifyFile(input: {
	path: string
	source: string
	scope: string
}): FileClassification | null {
	if (markdownFilePattern.test(input.path)) {
		return classifyMarkdownFile(input)
	}
	if (!scannableModuleFilePattern.test(input.path)) return null
	if (isTypeDeclarationFilePath(input.path)) return null
	return classifyModuleSource(input)
}

function classifyFiles(
	files: Record<string, string>,
): Array<FileClassification> {
	const scope = readPackageScope(files) ?? '@invalid'
	return Object.entries(files)
		.flatMap(([path, source]) => {
			const classification = classifyFile({ path, source, scope })
			return classification ? [classification] : []
		})
		.sort((left, right) => left.path.localeCompare(right.path))
}

function detect(
	files: Record<string, string>,
	context: PackageCodemodContext,
): Array<PackageCodemodFinding> {
	const classifications = classifyFiles(files)
	if (classifications.length === 0) return []
	const scope = readPackageScope(files)
	if (!scope) {
		return [{ path: packageManifestPath, message: manifestScopeMessage }]
	}
	if (!scopeIsPackageOrg(scope, context)) {
		return classifications.map((classification) => ({
			path: classification.path,
			message: orgScopeMismatchMessage,
		}))
	}
	return classifications.map((classification) => ({
		path: classification.path,
		message: classification.manualMessage ?? rewriteDetectMessage,
	}))
}

function applyRewrites(source: string, rewrites: Array<SourceRewrite>) {
	let nextSource = source
	for (const rewrite of [...rewrites].sort(
		(left, right) => right.start - left.start,
	)) {
		nextSource =
			nextSource.slice(0, rewrite.start) +
			rewrite.replacement +
			nextSource.slice(rewrite.end)
	}
	return nextSource
}

function transform(
	files: Record<string, string>,
	context: PackageCodemodContext,
): PackageCodemodTransformResult {
	const classifications = classifyFiles(files)
	if (classifications.length === 0) {
		return {
			files: { ...files },
			changed: false,
			changedPaths: [],
			needsManual: [],
		}
	}
	const scope = readPackageScope(files)
	if (!scope) {
		return {
			files: { ...files },
			changed: false,
			changedPaths: [],
			needsManual: [
				{ path: packageManifestPath, message: manifestScopeMessage },
			],
		}
	}
	if (!scopeIsPackageOrg(scope, context)) {
		return {
			files: { ...files },
			changed: false,
			changedPaths: [],
			needsManual: classifications.map((classification) => ({
				path: classification.path,
				message: orgScopeMismatchMessage,
			})),
		}
	}
	const nextFiles = { ...files }
	const changedPaths: Array<string> = []
	const needsManual: Array<PackageCodemodFinding> = []
	for (const classification of classifications) {
		if (classification.manualMessage) {
			needsManual.push({
				path: classification.path,
				message: classification.manualMessage,
			})
			continue
		}
		const source = files[classification.path]
		if (typeof source !== 'string') continue
		const nextSource = applyRewrites(source, classification.rewrites)
		if (nextSource !== source) {
			nextFiles[classification.path] = nextSource
			changedPaths.push(classification.path)
		}
	}
	return {
		files: nextFiles,
		changed: changedPaths.length > 0,
		changedPaths,
		needsManual,
	}
}

/**
 * Repair the removed object-only package invocation API to the required
 * scoped string-first form. Bare kody ids resolve in the invoking package's
 * org, so the package manifest scope is the equivalent explicit owner when it
 * is that org. Ambiguous expressions remain unchanged for operator review.
 */
export const invokeObjectToSpecifierCodemod = {
	id: invokeObjectToSpecifierCodemodId,
	description:
		'Repair publish-blocked packages.invoke({ kodyId, exportName, ... }) calls as packages.invoke("kody:@owner/kodyId", { exportName, ... }); flag ambiguous calls for manual review.',
	detect,
	transform,
} satisfies PackageCodemod
