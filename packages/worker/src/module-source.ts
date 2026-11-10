import { parse, type ParserPlugin } from '@babel/parser'

export type ModuleAstNode = {
	type: string
	[key: string]: unknown
}

const typeScriptPlugins: Array<ParserPlugin> = ['typescript']
const typeScriptJsxPlugins: Array<ParserPlugin> = ['typescript', 'jsx']
const jsxPlugins: Array<ParserPlugin> = ['jsx']
const plainJavaScriptPlugins: Array<ParserPlugin> = []

/**
 * Babel plugins for a module path, matching the bundler's loader per
 * extension: `.ts` / `.mts` / `.cts` are TypeScript without JSX (so
 * `<T>(x: T) => x` is a generic arrow), `.tsx` is TSX, `.jsx` is JSX, and
 * `.js` / `.mjs` / `.cjs` are plain JavaScript. Unknown or missing paths keep
 * the lenient TSX default.
 */
export function moduleSourceParserPlugins(filePath?: string | null) {
	const extension = /\.([cm]?[jt]sx?)$/i
		.exec(filePath ?? '')?.[1]
		?.toLowerCase()
	switch (extension) {
		case 'ts':
		case 'mts':
		case 'cts':
			return typeScriptPlugins
		case 'tsx':
			return typeScriptJsxPlugins
		case 'jsx':
			return jsxPlugins
		case 'js':
		case 'mjs':
		case 'cjs':
			return plainJavaScriptPlugins
		default:
			return typeScriptJsxPlugins
	}
}

export function parseModuleSource(
	source: string,
	options?: { filePath?: string | null },
) {
	return parse(source, {
		sourceType: 'module',
		plugins: moduleSourceParserPlugins(options?.filePath),
		createImportExpressions: true,
	})
}

export type ModuleSourceParseError = {
	/** 1-based line. */
	line: number | null
	/** 1-based column. */
	column: number | null
	message: string
}

/** Line, column, and message (without Babel's `(line:col)` suffix). */
export function describeModuleSourceParseError(
	error: unknown,
): ModuleSourceParseError {
	const raw = error instanceof Error ? error.message : String(error)
	const loc = (error as { loc?: { line?: unknown; column?: unknown } } | null)
		?.loc
	const line = typeof loc?.line === 'number' ? loc.line : null
	const column = typeof loc?.column === 'number' ? loc.column + 1 : null
	return {
		line,
		column,
		message: raw.replace(/\s*\(\d+:\d+\)\s*$/, ''),
	}
}

const fallbackParserPlugins: Array<ParserPlugin[]> = [
	['typescript', 'decorators-legacy'],
	['typescript', 'jsx', 'decorators-legacy'],
]

/**
 * Like `parseModuleSource`, but retries without JSX so `.ts` code that uses
 * `<T>value` type assertions (a JSX parse error) still yields an AST, and with
 * decorators so decorated classes are scanned instead of skipped.
 */
export function parseModuleSourceAllowingTypeAssertions(source: string) {
	try {
		return parseModuleSource(source)
	} catch (error) {
		for (const plugins of fallbackParserPlugins) {
			try {
				return parse(source, {
					sourceType: 'module',
					plugins,
					createImportExpressions: true,
				})
			} catch {
				// Try the next plugin set; rethrow the original error if none parse.
			}
		}
		throw error
	}
}

function getProgramBody(parsed: ModuleAstNode) {
	const program = parsed.program as { body?: Array<ModuleAstNode> } | undefined
	const body =
		program?.body ?? (parsed.body as Array<ModuleAstNode> | undefined)
	return Array.isArray(body) ? body : []
}

function getNodeName(node: unknown) {
	if (!node || typeof node !== 'object') return null
	const candidate = node as { name?: unknown; value?: unknown }
	if (typeof candidate.name === 'string') return candidate.name
	if (typeof candidate.value === 'string') return candidate.value
	return null
}

export function hasTopLevelDefaultExport(source: string) {
	if (!source) return false
	try {
		const body = getProgramBody(
			parseModuleSource(source) as unknown as ModuleAstNode,
		)
		return body.some((statement) => {
			if (statement.type === 'ExportDefaultDeclaration') return true
			if (statement.type !== 'ExportNamedDeclaration') return false
			const specifiers = statement.specifiers
			if (!Array.isArray(specifiers)) return false
			return specifiers.some(
				(specifier) =>
					getNodeName((specifier as ModuleAstNode).exported) === 'default',
			)
		})
	} catch {
		return false
	}
}
