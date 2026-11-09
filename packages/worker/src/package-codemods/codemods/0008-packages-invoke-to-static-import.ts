import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'
import {
	packageSpecifierPrefix,
	parseKodyPackageSpecifier,
} from '#worker/package-runtime/package-import-resolution.ts'
import {
	kodyPackageDependencyWildcard,
	kodyPackageDependencySchema,
} from '#worker/package-registry/types.ts'
import type {
	PackageCodemod,
	PackageCodemodFinding,
	PackageCodemodTransformResult,
} from '../types.ts'

export const packagesInvokeToStaticImportCodemodId =
	'0008-packages-invoke-to-static-import'

const rewriteMessage =
	'Uses author-facing `packages.invoke`; rewrite literal targets to a static `kody:@` import and declare the package in `package.json#kody.dependencies`.'
const keyedMessage =
	'Uses keyed `packages.invoke` (`idempotencyKey`); rewrite to a workflow for exactly-once work, or drop the key and use a static import / `import(specifier)`.'
const manualMessage =
	'A `packages.invoke` call is ambiguous or cannot be rewritten safely; use a static `kody:@` import when the name is known, or `import(specifier)` when the name is data.'
const parseFailureMessage =
	'File references `packages.invoke` but could not be parsed; migrate to static imports or `import(specifier)` manually.'
const manifestMessage =
	'package.json is missing or not valid JSON; declare rewritten static imports in `kody.dependencies` manually.'

const packageManifestPath = 'package.json'
const scannableModuleFilePattern = /\.(?:[cm]?[jt]s|[jt]sx)$/
const markdownFilePattern = /\.mdx?$/
const javascriptReservedWords = new Set([
	'await',
	'break',
	'case',
	'catch',
	'class',
	'const',
	'continue',
	'debugger',
	'default',
	'delete',
	'do',
	'else',
	'enum',
	'export',
	'extends',
	'false',
	'finally',
	'for',
	'function',
	'if',
	'import',
	'in',
	'instanceof',
	'new',
	'null',
	'return',
	'super',
	'switch',
	'this',
	'throw',
	'true',
	'try',
	'typeof',
	'var',
	'void',
	'while',
	'with',
	'yield',
	'let',
	'static',
	'implements',
	'interface',
	'package',
	'private',
	'protected',
	'public',
])
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
	source?: AstNode
	specifiers?: Array<AstNode>
	local?: AstNode
	imported?: AstNode
	expressions?: Array<AstNode>
	expression?: AstNode
	quasis?: Array<AstNode>
}

type SourceRewrite = {
	start: number
	end: number
	replacement: string
}

type StaticCallRewrite = {
	kind: 'static'
	callStart: number
	callEnd: number
	specifier: string
	paramsSource: string | null
}

type ComputedCallRewrite = {
	kind: 'computed'
	callStart: number
	callEnd: number
	specifierSource: string
	paramsSource: string | null
}

type CallRewrite = StaticCallRewrite | ComputedCallRewrite

type FileClassification = {
	path: string
	rewrites: Array<SourceRewrite>
	dependencyNames: Array<string>
	needsManual: string | null
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

function hasPackagesInvokeTokens(source: string) {
	return source.includes('packages') && source.includes('invoke')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === 'object' && !Array.isArray(value)
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

function readStringLiteral(node: AstNode | undefined): string | null {
	const unwrapped = unwrapTransparentExpression(node)
	if (
		(unwrapped?.type === 'StringLiteral' || unwrapped?.type === 'Literal') &&
		typeof unwrapped.value === 'string'
	) {
		return unwrapped.value
	}
	if (
		unwrapped?.type === 'TemplateLiteral' &&
		(unwrapped.expressions?.length ?? 0) === 0
	) {
		const quasiValue = unwrapped.quasis?.[0]?.value
		const cooked =
			quasiValue != null &&
			typeof quasiValue === 'object' &&
			'cooked' in quasiValue
				? (quasiValue as { cooked?: unknown }).cooked
				: null
		return typeof cooked === 'string' ? cooked : null
	}
	return null
}

function isStaticStringSpecifier(node: AstNode) {
	return readStringLiteral(node) != null
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

function canonicalizeInvokeSpecifier(rawSpecifier: string): string | null {
	const trimmed = rawSpecifier.trim()
	const specifier = trimmed.startsWith('@') ? `kody:${trimmed}` : trimmed
	if (!specifier.startsWith(packageSpecifierPrefix)) return null
	try {
		const parsed = parseKodyPackageSpecifier(specifier)
		const pathSegments = specifier
			.slice(packageSpecifierPrefix.length)
			.split('/')
		const hasExplicitExport = pathSegments
			.slice(2)
			.some((segment) => segment.trim())
		return `${packageSpecifierPrefix}${parsed.packageName.slice(1)}${
			hasExplicitExport ? `/${parsed.exportName}` : ''
		}`
	} catch {
		return null
	}
}

function specifierWithExportName(
	specifier: string,
	exportName: string | null,
): string | null {
	const canonical = canonicalizeInvokeSpecifier(specifier)
	if (!canonical) return null
	const parsed = parseKodyPackageSpecifier(canonical)
	const pathSegments = canonical.slice(packageSpecifierPrefix.length).split('/')
	const hasExplicitExport = pathSegments
		.slice(2)
		.some((segment) => segment.trim())
	if (hasExplicitExport) return canonical
	if (exportName == null || exportName === '' || exportName === '.') {
		return null
	}
	const normalizedExport = exportName.replace(/^\.\//, '').trim()
	if (!normalizedExport) return null
	return `${packageSpecifierPrefix}${parsed.packageName.slice(1)}/${normalizedExport}`
}

function classifyOptionsObject(input: { source: string; objectNode: AstNode }):
	| {
			kind: 'ok'
			paramsSource: string | null
			exportName: string | null
	  }
	| { kind: 'keyed' }
	| { kind: 'manual' } {
	const properties = input.objectNode.properties ?? []
	let paramsSource: string | null = null
	let exportName: string | null = null
	for (const property of properties) {
		if (property.type === 'SpreadElement' || property.type === 'RestElement') {
			return { kind: 'manual' }
		}
		const name = readStaticPropertyName(property)
		if (name == null || !supportedOptionKeys.has(name)) {
			return { kind: 'manual' }
		}
		const value = (property as { value?: AstNode }).value
		if (name === 'idempotencyKey') {
			return { kind: 'keyed' }
		}
		if (name === 'topic') {
			return { kind: 'manual' }
		}
		if (name === 'exportName') {
			const literal = readStringLiteral(value)
			if (literal == null) return { kind: 'manual' }
			exportName = literal
			continue
		}
		if (
			name === 'params' &&
			value &&
			typeof value.start === 'number' &&
			typeof value.end === 'number'
		) {
			paramsSource = input.source.slice(value.start, value.end)
		}
	}
	return { kind: 'ok', paramsSource, exportName }
}

function collectExistingDefaultImports(program: AstNode) {
	const bindings = new Map<string, string>()
	const usedNames = new Set<string>()

	function visit(value: unknown): void {
		if (value == null || typeof value !== 'object') return
		if (Array.isArray(value)) {
			for (const item of value) visit(item)
			return
		}
		if (!('type' in value)) return
		const node = value as AstNode
		if (node.type === 'Identifier' && typeof node.name === 'string') {
			usedNames.add(node.name)
		}
		if (node.type === 'ImportDeclaration') {
			const specifier = readStringLiteral(node.source)
			for (const spec of node.specifiers ?? []) {
				const localName =
					typeof spec.local?.name === 'string' ? spec.local.name : null
				if (
					specifier?.startsWith(packageSpecifierPrefix) &&
					spec.type === 'ImportDefaultSpecifier' &&
					localName
				) {
					bindings.set(specifier, localName)
				}
			}
		}
		for (const child of Object.values(node as Record<string, unknown>)) {
			if (child != null && typeof child === 'object') visit(child)
		}
	}

	visit(program)
	return { bindings, usedNames }
}

function programBody(program: AstNode): Array<AstNode> {
	const nested = (program as { program?: { body?: Array<AstNode> } }).program
		?.body
	if (Array.isArray(nested)) return nested
	const body = (program as { body?: Array<AstNode> }).body
	return Array.isArray(body) ? body : []
}

function lastImportInsertionOffset(program: AstNode): number {
	let offset = 0
	const body = programBody(program)
	for (const statement of body) {
		if (
			statement.type === 'ImportDeclaration' &&
			typeof statement.end === 'number'
		) {
			offset = statement.end
		}
	}
	return offset
}

function toBindingName(specifier: string, usedNames: Set<string>) {
	const parsed = parseKodyPackageSpecifier(specifier)
	const exportPart =
		parsed.exportName === '.'
			? (parsed.packageName.split('/')[1] ?? 'imported')
			: parsed.exportName.replace(/^\.\//, '')
	const segments = exportPart.split(/[^A-Za-z0-9]+/).filter(Boolean)
	let base = segments
		.map((segment, index) => {
			const lower = segment.toLowerCase()
			if (index === 0) return lower
			return lower.slice(0, 1).toUpperCase() + lower.slice(1)
		})
		.join('')
	if (!/^[A-Za-z_$]/.test(base)) base = `imported${base}`
	if (javascriptReservedWords.has(base)) base = `${base}Export`
	let candidate = base || 'imported'
	let suffix = 2
	while (usedNames.has(candidate)) {
		candidate = `${base}${suffix}`
		suffix += 1
	}
	usedNames.add(candidate)
	return candidate
}

function callReplacement(input: {
	bindingOrImport: string
	paramsSource: string | null
	kind: 'static' | 'computed'
}) {
	const args = input.paramsSource ?? ''
	if (input.kind === 'computed') {
		return `(await import(${input.bindingOrImport})).default(${args})`
	}
	return `${input.bindingOrImport}(${args})`
}

function classifyInvokeCall(input: {
	source: string
	node: AstNode
}): CallRewrite | { kind: 'keyed' } | { kind: 'manual' } {
	if (
		typeof input.node.start !== 'number' ||
		typeof input.node.end !== 'number'
	) {
		return { kind: 'manual' }
	}
	const args = input.node.arguments ?? []
	const firstArg = args[0]
	const secondArg = args[1]
	if (!firstArg || firstArg.type === 'SpreadElement') {
		return { kind: 'manual' }
	}
	let paramsSource: string | null = null
	let exportName: string | null = null
	if (secondArg) {
		if (secondArg.type === 'SpreadElement') return { kind: 'manual' }
		const options = unwrapTransparentExpression(secondArg)
		if (options?.type !== 'ObjectExpression') return { kind: 'manual' }
		const classified = classifyOptionsObject({
			source: input.source,
			objectNode: options,
		})
		if (classified.kind !== 'ok') return classified
		paramsSource = classified.paramsSource
		exportName = classified.exportName
	}
	if (isStaticStringSpecifier(firstArg)) {
		const raw = readStringLiteral(firstArg)
		if (raw == null) return { kind: 'manual' }
		const specifier = specifierWithExportName(raw, exportName)
		if (!specifier) return { kind: 'manual' }
		return {
			kind: 'static',
			callStart: input.node.start,
			callEnd: input.node.end,
			specifier,
			paramsSource,
		}
	}
	if (exportName != null) return { kind: 'manual' }
	if (
		typeof firstArg.start !== 'number' ||
		typeof firstArg.end !== 'number' ||
		firstArg.type === 'ObjectExpression'
	) {
		return { kind: 'manual' }
	}
	return {
		kind: 'computed',
		callStart: input.node.start,
		callEnd: input.node.end,
		specifierSource: input.source.slice(firstArg.start, firstArg.end),
		paramsSource,
	}
}

function buildModuleRewrites(input: {
	path: string
	source: string
	offset?: number
}): FileClassification | null {
	if (!hasPackagesInvokeTokens(input.source)) return null
	const program = parseProgram(input.source)
	if (!program) {
		return /packages\s*\??\.\s*invoke\b/.test(input.source)
			? {
					path: input.path,
					rewrites: [],
					dependencyNames: [],
					needsManual: parseFailureMessage,
				}
			: null
	}
	const { bindings, usedNames } = collectExistingDefaultImports(program)
	const callRewrites: Array<CallRewrite> = []
	const manualReasons = new Set<string>()

	function visit(node: unknown): void {
		if (node == null || typeof node !== 'object') return
		if (Array.isArray(node)) {
			for (const item of node) visit(item)
			return
		}
		if (!('type' in node)) return
		const typedNode = node as AstNode
		if (isPackagesInvokeCall(typedNode)) {
			const classified = classifyInvokeCall({
				source: input.source,
				node: typedNode,
			})
			switch (classified.kind) {
				case 'static':
				case 'computed':
					callRewrites.push(classified)
					break
				case 'keyed':
					manualReasons.add(keyedMessage)
					break
				case 'manual':
					manualReasons.add(manualMessage)
					break
				default: {
					const exhaustive: never = classified
					void exhaustive
				}
			}
		}
		for (const value of Object.values(node as Record<string, unknown>)) {
			if (value != null && typeof value === 'object') visit(value)
		}
	}

	visit(program)
	if (callRewrites.length === 0 && manualReasons.size === 0) return null

	const remainingInvokeCount = [
		...input.source.matchAll(/packages\s*\??\.\s*invoke\b/g),
	].length
	const rewrites: Array<SourceRewrite> = []
	const dependencyNames = new Set<string>()
	const importsToInsert: Array<{ specifier: string; binding: string }> = []

	for (const call of callRewrites) {
		if (call.kind === 'computed') {
			rewrites.push({
				start: call.callStart,
				end: call.callEnd,
				replacement: callReplacement({
					bindingOrImport: call.specifierSource,
					paramsSource: call.paramsSource,
					kind: 'computed',
				}),
			})
			continue
		}
		let binding = bindings.get(call.specifier)
		if (!binding) {
			binding = toBindingName(call.specifier, usedNames)
			bindings.set(call.specifier, binding)
			importsToInsert.push({ specifier: call.specifier, binding })
		}
		dependencyNames.add(parseKodyPackageSpecifier(call.specifier).packageName)
		rewrites.push({
			start: call.callStart,
			end: call.callEnd,
			replacement: callReplacement({
				bindingOrImport: binding,
				paramsSource: call.paramsSource,
				kind: 'static',
			}),
		})
	}

	if (importsToInsert.length > 0) {
		const insertAt = lastImportInsertionOffset(program)
		const importBlock = importsToInsert
			.map(
				(entry) =>
					`import ${entry.binding} from ${JSON.stringify(entry.specifier)}`,
			)
			.join('\n')
		const prefix = insertAt === 0 ? '' : '\n'
		const suffix = insertAt === 0 ? '\n' : '\n'
		rewrites.push({
			start: insertAt,
			end: insertAt,
			replacement: `${prefix}${importBlock}${suffix}`,
		})
	}

	const remainingMemberCount = [...input.source.matchAll(/\bpackages\s*\??\./g)]
		.length
	if (
		remainingInvokeCount === callRewrites.length &&
		remainingMemberCount === remainingInvokeCount &&
		![...manualReasons].some(
			(reason) => reason === keyedMessage || reason === manualMessage,
		)
	) {
		const unusedPackagesImport = collectUnusedPackagesImportRewrite(
			program,
			input.source,
		)
		if (unusedPackagesImport) rewrites.push(unusedPackagesImport)
	}

	const offset = input.offset ?? 0
	return {
		path: input.path,
		rewrites: rewrites.map((rewrite) => ({
			...rewrite,
			start: rewrite.start + offset,
			end: rewrite.end + offset,
		})),
		dependencyNames: [...dependencyNames],
		needsManual:
			manualReasons.size === 0
				? null
				: [...manualReasons].includes(keyedMessage)
					? keyedMessage
					: ([...manualReasons][0] ?? null),
	}
}

function collectUnusedPackagesImportRewrite(
	program: AstNode,
	source: string,
): SourceRewrite | null {
	const body = programBody(program)
	for (const statement of body) {
		if (statement.type !== 'ImportDeclaration') continue
		if (readStringLiteral(statement.source) !== 'kody:runtime') continue
		const specifiers = statement.specifiers ?? []
		const packagesSpec = specifiers.find(
			(specifier) =>
				specifier.type === 'ImportSpecifier' &&
				isIdentifierNamed(
					unwrapTransparentExpression(specifier.imported) ?? specifier.local,
					'packages',
				),
		)
		if (
			!packagesSpec ||
			typeof statement.start !== 'number' ||
			typeof statement.end !== 'number'
		) {
			continue
		}
		if (specifiers.length === 1) {
			return {
				start: statement.start,
				end: statement.end,
				replacement: '',
			}
		}
		if (
			typeof packagesSpec.start !== 'number' ||
			typeof packagesSpec.end !== 'number'
		) {
			continue
		}
		const trailingComma = /^\s*,\s*/.exec(source.slice(packagesSpec.end))
		if (trailingComma) {
			return {
				start: packagesSpec.start,
				end: packagesSpec.end + trailingComma[0].length,
				replacement: '',
			}
		}
		const leadingComma = /,\s*$/.exec(source.slice(0, packagesSpec.start))
		if (leadingComma) {
			return {
				start: packagesSpec.start - leadingComma[0].length,
				end: packagesSpec.end,
				replacement: '',
			}
		}
		return {
			start: packagesSpec.start,
			end: packagesSpec.end,
			replacement: '',
		}
	}
	return null
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

function listMarkdownInlineCode(source: string): Array<{
	start: number
	end: number
	contentStart: number
	contentEnd: number
}> {
	const spans: Array<{
		start: number
		end: number
		contentStart: number
		contentEnd: number
	}> = []
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
		if (/packages\s*\??\.\s*invoke\b/.test(source.slice(cursor, range.start))) {
			return true
		}
		cursor = Math.max(cursor, range.end)
	}
	return /packages\s*\??\.\s*invoke\b/.test(source.slice(cursor))
}

function classifyMarkdownFile(input: {
	path: string
	source: string
}): FileClassification | null {
	if (!hasPackagesInvokeTokens(input.source)) return null
	const fences = listMarkdownCodeFences(input.source)
	const coveredRanges: Array<{ start: number; end: number }> = fences.map(
		(fence) => ({ start: fence.start, end: fence.end }),
	)
	const rewrites: Array<SourceRewrite> = []
	let needsManual: string | null = null
	for (const fence of fences) {
		const content = input.source.slice(fence.contentStart, fence.contentEnd)
		if (!markdownModuleLanguages.has(fence.language)) {
			if (/packages\s*\??\.\s*invoke\b/.test(content)) {
				needsManual ??= manualMessage
			}
			continue
		}
		const classification = buildModuleRewrites({
			path: input.path,
			source: content,
			offset: fence.contentStart,
		})
		if (!classification) continue
		rewrites.push(...classification.rewrites)
		needsManual ??= classification.needsManual
	}
	for (const inlineCode of listMarkdownInlineCode(input.source)) {
		const range = { start: inlineCode.start, end: inlineCode.end }
		if (rangeOverlaps(range, coveredRanges)) continue
		coveredRanges.push(range)
		const classification = buildModuleRewrites({
			path: input.path,
			source: input.source.slice(
				inlineCode.contentStart,
				inlineCode.contentEnd,
			),
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
	return {
		path: input.path,
		rewrites,
		// Repo checks count static kody:@ imports in JS/TS only. README
		// examples must not add unused kody.dependencies entries.
		dependencyNames: [],
		needsManual,
	}
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
	return buildModuleRewrites(input)
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

function detectJsonIndent(source: string) {
	const match = source.match(/\n([ \t]+)"/)
	return match?.[1] ?? '\t'
}

function addKodyDependencies(
	files: Record<string, string>,
	packageNames: ReadonlyArray<string>,
): { files: Record<string, string>; changed: boolean; manual: boolean } {
	if (packageNames.length === 0) {
		return { files, changed: false, manual: false }
	}
	const source = files[packageManifestPath]
	if (typeof source !== 'string') {
		return { files, changed: false, manual: true }
	}
	try {
		const parsed: unknown = JSON.parse(source)
		if (!isPlainObject(parsed)) {
			return { files, changed: false, manual: true }
		}
		const kody = parsed['kody']
		if (kody !== undefined && !isPlainObject(kody)) {
			return { files, changed: false, manual: true }
		}
		const current = isPlainObject(kody) ? kody['dependencies'] : undefined
		const nextDependencies: Record<string, string> = {}
		if (Array.isArray(current)) {
			for (const entry of current) {
				if (typeof entry === 'string') nextDependencies[entry] = '*'
			}
		} else if (isPlainObject(current)) {
			for (const [name, version] of Object.entries(current)) {
				if (typeof version === 'string') nextDependencies[name] = version
			}
		} else if (current !== undefined) {
			return { files, changed: false, manual: true }
		}
		let changed = false
		for (const name of packageNames) {
			if (!kodyPackageDependencySchema.safeParse(name).success) continue
			if (nextDependencies[name] == null) {
				nextDependencies[name] = kodyPackageDependencyWildcard
				changed = true
			}
		}
		if (!changed) return { files, changed: false, manual: false }
		const next = {
			...parsed,
			kody: {
				...(isPlainObject(kody) ? kody : {}),
				dependencies: nextDependencies,
			},
		}
		return {
			files: {
				...files,
				[packageManifestPath]: `${JSON.stringify(next, null, detectJsonIndent(source))}\n`,
			},
			changed: true,
			manual: false,
		}
	} catch {
		return { files, changed: false, manual: true }
	}
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
		.replaceAll(/import \{,\s*/g, 'import {')
		.replaceAll(/,\s*\} from/g, ' } from')
}

function detect(files: Record<string, string>): Array<PackageCodemodFinding> {
	return classifyFiles(files).map((classification) => ({
		path: classification.path,
		message: classification.needsManual ?? rewriteMessage,
	}))
}

function transform(
	files: Record<string, string>,
): PackageCodemodTransformResult {
	const classifications = classifyFiles(files)
	const nextFiles = { ...files }
	const changedPaths: Array<string> = []
	const needsManual: Array<PackageCodemodFinding> = []
	const dependencyNames = new Set<string>()
	for (const classification of classifications) {
		const source = files[classification.path]
		if (typeof source !== 'string') continue
		const nextSource = applyRewrites(source, classification.rewrites)
		if (nextSource !== source) {
			nextFiles[classification.path] = nextSource
			changedPaths.push(classification.path)
		}
		for (const name of classification.dependencyNames) {
			dependencyNames.add(name)
		}
		if (classification.needsManual) {
			needsManual.push({
				path: classification.path,
				message: classification.needsManual,
			})
		}
	}
	const dependencyResult = addKodyDependencies(nextFiles, [...dependencyNames])
	if (dependencyResult.manual) {
		needsManual.push({ path: packageManifestPath, message: manifestMessage })
	}
	if (dependencyResult.changed) {
		nextFiles[packageManifestPath] =
			dependencyResult.files[packageManifestPath] ??
			nextFiles[packageManifestPath] ??
			''
		if (!changedPaths.includes(packageManifestPath)) {
			changedPaths.push(packageManifestPath)
		}
	}
	return {
		files: dependencyResult.changed ? dependencyResult.files : nextFiles,
		changed: changedPaths.length > 0,
		changedPaths: changedPaths.sort((left, right) => left.localeCompare(right)),
		needsManual,
	}
}

/**
 * Replace author-facing `packages.invoke` with composition primitives:
 * literal specifiers become static `kody:@` imports (and `kody.dependencies`
 * entries from JS/TS modules only). JavaScript/TypeScript Markdown fences and
 * inline examples are rewritten the same way but do not declare dependencies.
 * Computed specifiers become `import(specifier)` (name is data). Keyed invokes
 * stay `needsManual` for workflows.
 */
export const packagesInvokeToStaticImportCodemod = {
	id: packagesInvokeToStaticImportCodemodId,
	description:
		'Rewrite literal packages.invoke targets to static kody:@ imports (and kody.dependencies from JS/TS), including Markdown examples; rewrite computed specifiers to import(specifier); flag keyed invokes for workflows.',
	detect,
	transform,
} satisfies PackageCodemod
