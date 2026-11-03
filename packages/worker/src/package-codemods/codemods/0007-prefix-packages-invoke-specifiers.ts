import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
import {
	packageSpecifierPrefix,
	parseKodyPackageSpecifier,
} from '#worker/package-runtime/package-import-resolution.ts'
import type {
	PackageCodemod,
	PackageCodemodFinding,
	PackageCodemodTransformResult,
} from '../types.ts'

export const prefixPackagesInvokeSpecifiersCodemodId =
	'0007-prefix-packages-invoke-specifiers'

const rewriteMessage =
	'Uses a deprecated prefixless packages.invoke specifier; add the kody: prefix.'
const manualMessage =
	'A packages.invoke call is ambiguous or cannot be safely rewritten; add the kody: prefix manually.'
const parseFailureMessage =
	'File references packages.invoke but could not be parsed; add kody: prefixes manually.'
const generatedWrapperMarker = 'kody-codemod-0007'

const scannableModuleFilePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/
const typescriptModuleFilePattern = /\.(?:[cm]?ts|tsx)$/
const markdownFilePattern = /\.mdx?$/
const packagesInvokeDetectorPattern =
	/\bpackages(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/|\/\/[^\r\n]*)*!?(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/|\/\/[^\r\n]*)*(?:\?\.|\.)(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/|\/\/[^\r\n]*)*invoke(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/|\/\/[^\r\n]*)*!?(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/|\/\/[^\r\n]*)*(?:\?\.(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/|\/\/[^\r\n]*)*)?\(/
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
const markdownTypescriptLanguages = new Set([
	'cts',
	'mts',
	'ts',
	'tsx',
	'typescript',
])

type SourceKind = 'javascript' | 'markdown-inline' | 'typescript'

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
	expressions?: Array<AstNode>
	expression?: AstNode
	params?: Array<AstNode>
	body?: AstNode
}

type SourceRewrite = {
	start: number
	end: number
	replacement: string
}

type FileClassification = {
	path: string
	rewrites: Array<SourceRewrite>
	needsManual: string | null
}

type MarkdownCodeFence = {
	start: number
	end: number
	contentStart: number
	contentEnd: number
	language: string
}

type MarkdownInlineCode = {
	start: number
	end: number
	contentStart: number
	contentEnd: number
}

function hasPackagesInvokeTokens(source: string) {
	return source.includes('packages') && source.includes('invoke')
}

function patternBindsPackages(pattern: unknown): boolean {
	if (!pattern || typeof pattern !== 'object') return false
	const node = pattern as Record<string, unknown>
	switch (node['type']) {
		case 'Identifier':
			return node['name'] === 'packages'
		case 'AssignmentPattern':
			return patternBindsPackages(node['left'])
		case 'RestElement':
			return patternBindsPackages(node['argument'])
		case 'ArrayPattern':
			return (
				Array.isArray(node['elements']) &&
				node['elements'].some(patternBindsPackages)
			)
		case 'ObjectPattern':
			return (
				Array.isArray(node['properties']) &&
				node['properties'].some((property) => {
					if (!property || typeof property !== 'object') return false
					const propertyNode = property as Record<string, unknown>
					return propertyNode['type'] === 'RestElement'
						? patternBindsPackages(propertyNode['argument'])
						: patternBindsPackages(propertyNode['value'])
				})
			)
		case 'TSParameterProperty':
			return patternBindsPackages(node['parameter'])
		default:
			return false
	}
}

function unwrapTransparentExpression(
	node: AstNode | undefined,
): AstNode | undefined {
	let current = node
	while (
		current?.type === 'TSNonNullExpression' ||
		current?.type === 'ParenthesizedExpression' ||
		current?.type === 'ChainExpression'
	) {
		current = current.expression
	}
	return current
}

function isIdentifierNamed(node: AstNode | undefined, name: string) {
	const unwrapped = unwrapTransparentExpression(node)
	return unwrapped?.type === 'Identifier' && unwrapped.name === name
}

function isStaticInvokeProperty(node: AstNode) {
	const property = unwrapTransparentExpression(node.property)
	return node.computed === true
		? (property?.type === 'StringLiteral' || property?.type === 'Literal') &&
				property.value === 'invoke'
		: isIdentifierNamed(property, 'invoke')
}

function isPackagesMutationTarget(value: unknown) {
	if (!value || typeof value !== 'object' || !('type' in value)) return false
	const node = unwrapTransparentExpression(value as AstNode)
	if (isIdentifierNamed(node, 'packages')) return true
	if (
		node?.type !== 'MemberExpression' &&
		node?.type !== 'OptionalMemberExpression'
	) {
		return false
	}
	return (
		isIdentifierNamed(node.object, 'packages') && isStaticInvokeProperty(node)
	)
}

function isPackagesAssignmentTarget(value: unknown) {
	return patternBindsPackages(value) || isPackagesMutationTarget(value)
}

function classifyPackagesBindings(program: AstNode) {
	let canonicalImportCount = 0
	let hasOtherBinding = false

	function visit(value: unknown): void {
		if (!value || typeof value !== 'object') return
		if (Array.isArray(value)) {
			for (const item of value) visit(item)
			return
		}
		if (!('type' in value)) return
		const node = value as Record<string, unknown>
		const type = node['type']

		if (
			(type === 'AssignmentExpression' &&
				isPackagesAssignmentTarget(node['left'])) ||
			(type === 'UpdateExpression' &&
				isPackagesMutationTarget(node['argument'])) ||
			(type === 'UnaryExpression' &&
				node['operator'] === 'delete' &&
				isPackagesMutationTarget(node['argument'])) ||
			((type === 'ForOfStatement' || type === 'ForInStatement') &&
				isPackagesAssignmentTarget(node['left']))
		) {
			hasOtherBinding = true
		} else if (type === 'ImportDeclaration') {
			const source = node['source']
			const sourceValue =
				source && typeof source === 'object'
					? (source as Record<string, unknown>)['value']
					: null
			const specifiers = node['specifiers']
			if (Array.isArray(specifiers)) {
				for (const specifier of specifiers) {
					if (!specifier || typeof specifier !== 'object') continue
					const specifierNode = specifier as Record<string, unknown>
					if (!patternBindsPackages(specifierNode['local'])) continue
					const imported = specifierNode['imported']
					const importedName =
						imported && typeof imported === 'object'
							? ((imported as Record<string, unknown>)['name'] ??
								(imported as Record<string, unknown>)['value'])
							: null
					if (
						sourceValue === 'kody:runtime' &&
						specifierNode['type'] === 'ImportSpecifier' &&
						importedName === 'packages'
					) {
						canonicalImportCount += 1
					} else {
						hasOtherBinding = true
					}
				}
			}
		} else {
			const params = node['params']
			if (Array.isArray(params) && params.some(patternBindsPackages)) {
				hasOtherBinding = true
			}
			if (
				(type === 'VariableDeclarator' ||
					type === 'CatchClause' ||
					type === 'FunctionExpression' ||
					type === 'ClassExpression' ||
					(typeof type === 'string' &&
						(type.endsWith('Declaration') || type.startsWith('TS')))) &&
				(patternBindsPackages(node['id']) ||
					patternBindsPackages(node['param']))
			) {
				hasOtherBinding = true
			}
		}

		for (const child of Object.values(node)) {
			if (child != null && typeof child === 'object') visit(child)
		}
	}

	visit(program)
	return {
		canRewrite:
			!hasOtherBinding &&
			(canonicalImportCount === 0 || canonicalImportCount === 1),
	}
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

function isPackagesInvokeCall(node: AstNode) {
	if (
		node.type !== 'CallExpression' &&
		node.type !== 'OptionalCallExpression'
	) {
		return false
	}
	const callee = unwrapTransparentExpression(node.callee)
	return (
		(callee?.type === 'MemberExpression' ||
			callee?.type === 'OptionalMemberExpression') &&
		isIdentifierNamed(callee.object, 'packages') &&
		isStaticInvokeProperty(callee)
	)
}

function classifyLiteralSpecifier(
	source: string,
	node: AstNode,
): SourceRewrite | 'unchanged' | 'manual' {
	if (typeof node.start !== 'number' || typeof node.end !== 'number') {
		return 'manual'
	}
	const literalSource = source.slice(node.start, node.end)
	const quote = literalSource[0]
	if (
		(quote !== "'" && quote !== '"' && quote !== '`') ||
		literalSource.at(-1) !== quote
	) {
		return 'manual'
	}
	if (
		quote === '`' &&
		(node.expressions?.length !== 0 || literalSource.includes('${'))
	) {
		return 'manual'
	}
	const rawValue = literalSource.slice(1, -1)
	const value =
		typeof node.value === 'string'
			? node.value
			: quote === '`'
				? rawValue
				: null
	if (value == null) return 'manual'
	if (rawValue.includes('\\') || (quote !== '`' && rawValue !== value)) {
		return 'manual'
	}
	const trimmedValue = value.trim()
	if (trimmedValue.startsWith(packageSpecifierPrefix)) return 'unchanged'
	if (!trimmedValue.startsWith('@')) return 'manual'
	let canonicalValue: string
	try {
		const prefixedSpecifier = `kody:${trimmedValue}`
		const parsed = parseKodyPackageSpecifier(prefixedSpecifier)
		const pathSegments = prefixedSpecifier
			.slice(packageSpecifierPrefix.length)
			.split('/')
		const hasExplicitExport = pathSegments
			.slice(2)
			.some((segment) => segment.trim())
		canonicalValue = `${packageSpecifierPrefix}${parsed.packageName.slice(1)}${
			hasExplicitExport ? `/${parsed.exportName}` : ''
		}`
	} catch {
		return 'manual'
	}
	return {
		start: node.start,
		end: node.end,
		replacement: `${quote}${canonicalValue}${quote}`,
	}
}

function isStaticStringSpecifier(node: AstNode) {
	if (node.type === 'StringLiteral') return true
	if (node.type === 'Literal') return typeof node.value === 'string'
	return node.type === 'TemplateLiteral' && node.expressions?.length === 0
}

function createDynamicSpecifierBody(sourceKind: SourceKind) {
	const valueName = '__kodyCodemod0007Value'
	const trimmedName = '__kodyCodemod0007Trimmed'
	const specifierType = '`kody:@${string}/${string}`'
	const normalizedExpression =
		`typeof ${valueName} === 'string' && ${trimmedName}.startsWith('@') ` +
		`? ${
			sourceKind === 'typescript'
				? `\`kody:\${${trimmedName}}\``
				: `'kody:' + ${trimmedName}`
		} : ${valueName}`
	const bodyStart =
		`{ /* ${generatedWrapperMarker} */ ` +
		`const ${trimmedName} = typeof ${valueName} === 'string' ? ${valueName}.trim() : ''; `
	return sourceKind === 'typescript'
		? `${bodyStart}return (${normalizedExpression}) as ${specifierType} }`
		: `${bodyStart}return ${normalizedExpression} }`
}

function createDynamicSpecifierWrapper(input: {
	expression: string
	sourceKind: SourceKind
}) {
	const valueName = '__kodyCodemod0007Value'
	const specifierType = '`kody:@${string}/${string}`'
	const body = createDynamicSpecifierBody(input.sourceKind)
	if (input.sourceKind === 'typescript') {
		return (
			`((${valueName}: unknown): ${specifierType} => ${body})` +
			`((${input.expression}))`
		)
	}
	const assertionType =
		input.sourceKind === 'markdown-inline' ? 'any' : specifierType
	return (
		`/** @type {${assertionType}} */ (` +
		`((/** @type {unknown} */ ${valueName}) => ${body})` +
		`((${input.expression})))`
	)
}

function isGeneratedDynamicSpecifierWrapper(node: AstNode, source: string) {
	if (node.type !== 'CallExpression' || node.arguments?.length !== 1)
		return false
	const callee = unwrapTransparentExpression(node.callee)
	if (
		callee?.type !== 'ArrowFunctionExpression' ||
		callee.params?.length !== 1 ||
		!isIdentifierNamed(callee.params[0], '__kodyCodemod0007Value') ||
		callee.body?.type !== 'BlockStatement' ||
		typeof callee.body.start !== 'number' ||
		typeof callee.body.end !== 'number'
	) {
		return false
	}
	const bodySource = source.slice(callee.body.start, callee.body.end)
	return (
		bodySource === createDynamicSpecifierBody('javascript') ||
		bodySource === createDynamicSpecifierBody('typescript')
	)
}

function classifyModuleSource(input: {
	path: string
	source: string
	sourceKind: SourceKind
	offset?: number
}): FileClassification | null {
	// Keep the module prefilter deliberately broad. The AST below owns call
	// identification, including comments between member-access tokens.
	if (!hasPackagesInvokeTokens(input.source)) return null
	const program = parseProgram(input.source)
	if (!program) {
		return packagesInvokeDetectorPattern.test(input.source)
			? {
					path: input.path,
					rewrites: [],
					needsManual: parseFailureMessage,
				}
			: null
	}
	const rewrites: Array<SourceRewrite> = []
	let hasManual = false
	const bindingClassification = classifyPackagesBindings(program)

	function visit(node: unknown): void {
		if (node == null || typeof node !== 'object') return
		if (Array.isArray(node)) {
			for (const item of node) visit(item)
			return
		}
		if (!('type' in node)) return
		const typedNode = node as AstNode
		const packagesInvokeCall = isPackagesInvokeCall(typedNode)
		const firstArg = packagesInvokeCall ? typedNode.arguments?.[0] : undefined
		const firstArgSource =
			firstArg &&
			typeof firstArg.start === 'number' &&
			typeof firstArg.end === 'number'
				? input.source.slice(firstArg.start, firstArg.end)
				: null
		const hasGeneratedWrapper =
			firstArg != null &&
			isGeneratedDynamicSpecifierWrapper(firstArg, input.source)

		for (const [key, value] of Object.entries(
			node as Record<string, unknown>,
		)) {
			if (value == null || typeof value !== 'object') continue
			if (hasGeneratedWrapper && key === 'arguments' && Array.isArray(value)) {
				for (const argument of value.slice(1)) visit(argument)
			} else {
				visit(value)
			}
		}

		if (!packagesInvokeCall || hasGeneratedWrapper) return
		if (firstArg?.type !== 'ObjectExpression') {
			if (firstArg && isStaticStringSpecifier(firstArg)) {
				const result = classifyLiteralSpecifier(input.source, firstArg)
				if (result !== 'unchanged') {
					if (!bindingClassification.canRewrite || result === 'manual') {
						hasManual = true
					} else {
						rewrites.push(result)
					}
				}
			} else if (
				firstArg &&
				typeof firstArg.start === 'number' &&
				typeof firstArg.end === 'number' &&
				firstArg.type !== 'SpreadElement' &&
				firstArgSource != null
			) {
				if (!bindingClassification.canRewrite) {
					hasManual = true
				} else {
					const firstArgStart = firstArg.start
					const firstArgEnd = firstArg.end
					const nestedRewrites = rewrites.filter(
						(rewrite) =>
							rewrite.start >= firstArgStart && rewrite.end <= firstArgEnd,
					)
					const nestedRewriteSet = new Set(nestedRewrites)
					for (let index = rewrites.length - 1; index >= 0; index -= 1) {
						if (nestedRewriteSet.has(rewrites[index]!))
							rewrites.splice(index, 1)
					}
					const expression = applyRewrites(
						firstArgSource,
						nestedRewrites.map((rewrite) => ({
							...rewrite,
							start: rewrite.start - firstArgStart,
							end: rewrite.end - firstArgStart,
						})),
					)
					rewrites.push({
						start: firstArgStart,
						end: firstArgEnd,
						replacement: createDynamicSpecifierWrapper({
							expression,
							sourceKind: input.sourceKind,
						}),
					})
				}
			} else if (!firstArg || firstArg.type === 'SpreadElement') {
				hasManual = true
			}
		}
	}

	visit(program)
	if (rewrites.length === 0 && !hasManual) return null
	const offset = input.offset ?? 0
	return {
		path: input.path,
		rewrites: rewrites.map((rewrite) => ({
			...rewrite,
			start: rewrite.start + offset,
			end: rewrite.end + offset,
		})),
		needsManual: hasManual ? manualMessage : null,
	}
}

function listMarkdownCodeFences(source: string): Array<MarkdownCodeFence> {
	const fences: Array<MarkdownCodeFence> = []
	const openerPattern = /^(?: {0,3})(`{3,}|~{3,})([^\n]*)\r?\n/gm
	let opener: RegExpExecArray | null
	while ((opener = openerPattern.exec(source))) {
		const marker = opener[1]
		const markerCharacter = marker?.[0]
		if (!marker || !markerCharacter) continue
		const contentStart = opener.index + opener[0].length
		const closingPattern = new RegExp(
			`^(?: {0,3})${markerCharacter === '`' ? '`' : '~'}{${marker.length},}[ \\t]*\\r?$`,
			'gm',
		)
		closingPattern.lastIndex = contentStart
		const closing = closingPattern.exec(source)
		if (!closing) break
		fences.push({
			start: opener.index,
			end: closing.index + closing[0].length,
			contentStart,
			contentEnd: closing.index,
			language:
				(opener[2] ?? '').trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '',
		})
		openerPattern.lastIndex = closing.index + closing[0].length
	}
	return fences
}

function listMarkdownHtmlRanges(
	source: string,
): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = []
	const commentPattern = /<!--[\s\S]*?(?:-->|$)/g
	for (const match of source.matchAll(commentPattern)) {
		ranges.push({ start: match.index, end: match.index + match[0].length })
	}
	const blockPattern = /<([A-Za-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1\s*>/gi
	for (const match of source.matchAll(blockPattern)) {
		ranges.push({ start: match.index, end: match.index + match[0].length })
	}
	return ranges
}

function listMarkdownInlineCode(source: string): Array<MarkdownInlineCode> {
	const spans: Array<MarkdownInlineCode> = []
	let lineStart = 0
	while (lineStart < source.length) {
		const newline = source.indexOf('\n', lineStart)
		const lineEnd = newline === -1 ? source.length : newline
		let opener: number | null = null
		for (let cursor = lineStart; cursor < lineEnd; cursor += 1) {
			if (
				source[cursor] !== '`' ||
				source[cursor - 1] === '\\' ||
				source[cursor - 1] === '`' ||
				source[cursor + 1] === '`'
			) {
				continue
			}
			if (opener == null) {
				opener = cursor
			} else {
				spans.push({
					start: opener,
					end: cursor + 1,
					contentStart: opener + 1,
					contentEnd: cursor,
				})
				opener = null
			}
		}
		if (newline === -1) break
		lineStart = newline + 1
	}
	return spans
}

function rangeOverlaps(
	range: { start: number; end: number },
	ranges: ReadonlyArray<{ start: number; end: number }>,
) {
	return ranges.some(
		(candidate) => range.start < candidate.end && candidate.start < range.end,
	)
}

function sourceOutsideRangesHasPackagesInvoke(
	source: string,
	ranges: ReadonlyArray<{ start: number; end: number }>,
) {
	const sorted = [...ranges].sort((left, right) => left.start - right.start)
	let cursor = 0
	for (const range of sorted) {
		if (packagesInvokeDetectorPattern.test(source.slice(cursor, range.start))) {
			return true
		}
		cursor = Math.max(cursor, range.end)
	}
	return packagesInvokeDetectorPattern.test(source.slice(cursor))
}

function classifyMarkdownFile(input: {
	path: string
	source: string
}): FileClassification | null {
	if (!hasPackagesInvokeTokens(input.source)) return null
	const fences = listMarkdownCodeFences(input.source)
	const htmlRanges = listMarkdownHtmlRanges(input.source)
	const coveredRanges: Array<{ start: number; end: number }> = [
		...fences.map((fence) => ({ start: fence.start, end: fence.end })),
		...htmlRanges,
	]
	const rewrites: Array<SourceRewrite> = []
	let needsManual: string | null = null
	if (
		htmlRanges.some((range) =>
			packagesInvokeDetectorPattern.test(
				input.source.slice(range.start, range.end),
			),
		)
	) {
		needsManual = manualMessage
	}
	for (const fence of fences) {
		if (rangeOverlaps(fence, htmlRanges)) continue
		const content = input.source.slice(fence.contentStart, fence.contentEnd)
		if (!markdownModuleLanguages.has(fence.language)) {
			if (packagesInvokeDetectorPattern.test(content)) {
				needsManual ??= manualMessage
			}
			continue
		}
		const classification = classifyModuleSource({
			path: input.path,
			source: content,
			sourceKind: markdownTypescriptLanguages.has(fence.language)
				? 'typescript'
				: 'javascript',
			offset: fence.contentStart,
		})
		if (!classification) continue
		rewrites.push(...classification.rewrites)
		needsManual ??= classification.needsManual
	}

	// Only line-local pairs of single, unescaped backticks are mechanically
	// unambiguous. Multiline, escaped, and multi-backtick spans stay manual.
	for (const inlineCode of listMarkdownInlineCode(input.source)) {
		const range = {
			start: inlineCode.start,
			end: inlineCode.end,
		}
		if (rangeOverlaps(range, coveredRanges)) continue
		coveredRanges.push(range)
		const classification = classifyModuleSource({
			path: input.path,
			source: input.source.slice(
				inlineCode.contentStart,
				inlineCode.contentEnd,
			),
			sourceKind: 'markdown-inline',
			offset: inlineCode.contentStart,
		})
		if (!classification) continue
		rewrites.push(...classification.rewrites)
		needsManual ??= classification.needsManual
	}
	if (sourceOutsideRangesHasPackagesInvoke(input.source, coveredRanges)) {
		needsManual ??= manualMessage
	}
	if (rewrites.length === 0 && needsManual == null) return null
	return { path: input.path, rewrites, needsManual }
}

function classifyFile(input: {
	path: string
	source: string
}): FileClassification | null {
	if (markdownFilePattern.test(input.path)) return classifyMarkdownFile(input)
	if (
		!scannableModuleFilePattern.test(input.path) ||
		isTypeDeclarationFilePath(input.path)
	) {
		return null
	}
	return classifyModuleSource({
		...input,
		sourceKind: typescriptModuleFilePattern.test(input.path)
			? 'typescript'
			: 'javascript',
	})
}

function classifyFiles(
	files: Record<string, string>,
): Array<FileClassification> {
	return Object.entries(files)
		.flatMap(([path, source]) => {
			const classification = classifyFile({ path, source })
			return classification ? [classification] : []
		})
		.sort((left, right) => left.path.localeCompare(right.path))
}

function detect(files: Record<string, string>): Array<PackageCodemodFinding> {
	return classifyFiles(files).map((classification) => ({
		path: classification.path,
		message: classification.needsManual ?? rewriteMessage,
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
): PackageCodemodTransformResult {
	const nextFiles = { ...files }
	const changedPaths: Array<string> = []
	const needsManual: Array<PackageCodemodFinding> = []
	for (const classification of classifyFiles(files)) {
		const source = files[classification.path]
		if (typeof source !== 'string') continue
		const nextSource = applyRewrites(source, classification.rewrites)
		if (nextSource !== source) {
			nextFiles[classification.path] = nextSource
			changedPaths.push(classification.path)
		}
		if (classification.needsManual) {
			needsManual.push({
				path: classification.path,
				message: classification.needsManual,
			})
		}
	}
	return {
		files: nextFiles,
		changed: changedPaths.length > 0,
		changedPaths,
		needsManual,
	}
}

/** Add the preferred `kody:` prefix without changing call options or exports. */
export const prefixPackagesInvokeSpecifiersCodemod = {
	id: prefixPackagesInvokeSpecifiersCodemodId,
	description:
		'Rewrite literal prefixless packages.invoke specifiers and normalize parseable dynamic specifiers to the preferred kody:@owner/package[/export] form; flag ambiguous or unparseable calls for manual review.',
	detect,
	transform,
} satisfies PackageCodemod
