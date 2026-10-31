import { parse, type ParserPlugin } from '@babel/parser'

export type ModuleAstNode = {
	type: string
	[key: string]: unknown
}

export function parseModuleSource(source: string) {
	return parse(source, {
		sourceType: 'module',
		plugins: ['typescript', 'jsx'],
		createImportExpressions: true,
	})
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
