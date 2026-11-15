/**
 * Host-side best-effort shape of an ad-hoc execute module.
 *
 * Classifies the caller-authored source string only — never sandbox output
 * and never used for billing. Results live on the `execute` usage event
 * (Analytics Engine blob7) and are not shown to agents.
 *
 *   - `thin_single_export` — one static `kody:@` import whose default
 *     export is essentially a passthrough call
 *   - `thin_few_exports` — one to three static `kody:@` imports that are
 *     not a single passthrough
 *   - `glue` — parseable source that is not thin (capability
 *     orchestration, more imports, or other logic)
 *
 * Unparseable source returns `null` rather than guessing.
 */

import { collectLiteralImportNodes } from '#worker/package-runtime/import-specifiers.ts'
import { parseModuleSource, type ModuleAstNode } from '#worker/module-source.ts'

export const executeThinGlueClasses = [
	'thin_single_export',
	'thin_few_exports',
	'glue',
] as const

export type ExecuteThinGlueClass = (typeof executeThinGlueClasses)[number]

const fewPackageImportMax = 3

function readNodeType(node: unknown) {
	if (node == null || typeof node !== 'object') return null
	const type = (node as { type?: unknown }).type
	return typeof type === 'string' ? type : null
}

function readIdentifierName(node: unknown) {
	if (node == null || typeof node !== 'object') return null
	const typed = node as { type?: unknown; name?: unknown; value?: unknown }
	if (typed.type === 'Identifier' && typeof typed.name === 'string') {
		return typed.name
	}
	if (
		(typed.type === 'Literal' || typed.type === 'StringLiteral') &&
		typeof typed.value === 'string'
	) {
		return typed.value
	}
	return null
}

function readLiteralSpecifier(node: unknown) {
	if (node == null || typeof node !== 'object') return null
	const typed = node as {
		type?: unknown
		value?: unknown
		extra?: { rawValue?: unknown }
	}
	if (typeof typed.value === 'string') return typed.value
	if (typeof typed.extra?.rawValue === 'string') return typed.extra.rawValue
	return null
}

function isKodyPackageSpecifier(specifier: string) {
	return specifier.startsWith('kody:@')
}

async function getProgramBody(source: string) {
	const parsed = (await parseModuleSource(source)) as unknown as ModuleAstNode
	const program = parsed.program as { body?: Array<ModuleAstNode> } | undefined
	const body =
		program?.body ?? (parsed.body as Array<ModuleAstNode> | undefined)
	return Array.isArray(body) ? body : []
}

async function collectImportedLocalNames(source: string) {
	const names = new Set<string>()
	const body = await getProgramBody(source)
	for (const statement of body) {
		if (readNodeType(statement) !== 'ImportDeclaration') continue
		const specifier = readLiteralSpecifier(
			(statement as { source?: unknown }).source,
		)
		if (!specifier || !isKodyPackageSpecifier(specifier)) continue
		const specifiers = (statement as { specifiers?: unknown }).specifiers
		if (!Array.isArray(specifiers)) continue
		for (const item of specifiers) {
			const local = readIdentifierName((item as { local?: unknown }).local)
			if (local) names.add(local)
		}
	}
	return names
}

async function collectPackageImportCount(source: string) {
	const specifiers = new Set<string>()
	for (const node of await collectLiteralImportNodes(source)) {
		if (node.kind !== 'static') continue
		if (!isKodyPackageSpecifier(node.specifier)) continue
		specifiers.add(node.specifier)
	}
	const body = await getProgramBody(source)
	for (const statement of body) {
		if (readNodeType(statement) !== 'ExportNamedDeclaration') continue
		const specifier = readLiteralSpecifier(
			(statement as { source?: unknown }).source,
		)
		if (specifier && isKodyPackageSpecifier(specifier)) {
			specifiers.add(specifier)
		}
	}
	if (specifiers.size > 0) return specifiers.size
	return (await collectImportedLocalNames(source)).size
}

function unwrapExpression(node: unknown): unknown {
	let current = node
	while (current && typeof current === 'object') {
		const type = readNodeType(current)
		if (
			type === 'TSAsExpression' ||
			type === 'TSTypeAssertion' ||
			type === 'TSSatisfiesExpression' ||
			type === 'TSNonNullExpression' ||
			type === 'ParenthesizedExpression'
		) {
			current = (current as { expression?: unknown }).expression
			continue
		}
		break
	}
	return current
}

function isIdentifierNamed(node: unknown, names: ReadonlySet<string>) {
	const name = readIdentifierName(unwrapExpression(node))
	return name != null && names.has(name)
}

function isPassthroughCall(node: unknown, importedNames: ReadonlySet<string>) {
	const expression = unwrapExpression(node)
	if (readNodeType(expression) !== 'CallExpression') return false
	const typed = expression as {
		callee?: unknown
		arguments?: unknown
	}
	if (!isIdentifierNamed(typed.callee, importedNames)) return false
	if (!Array.isArray(typed.arguments)) return false
	if (typed.arguments.length === 0) return true
	if (typed.arguments.length === 1) {
		const only = typed.arguments[0]
		if (readNodeType(only) === 'Identifier') return true
		if (readNodeType(only) === 'ObjectExpression') return true
		if (readNodeType(only) === 'SpreadElement') return true
		return false
	}
	return false
}

function isPassthroughAwait(node: unknown, importedNames: ReadonlySet<string>) {
	const expression = unwrapExpression(node)
	if (readNodeType(expression) === 'AwaitExpression') {
		return isPassthroughCall(
			(expression as { argument?: unknown }).argument,
			importedNames,
		)
	}
	return isPassthroughCall(expression, importedNames)
}

function isPassthroughFunctionBody(
	node: unknown,
	importedNames: ReadonlySet<string>,
) {
	const body = (node as { body?: unknown }).body
	if (readNodeType(body) !== 'BlockStatement') {
		return isPassthroughAwait(body, importedNames)
	}
	const statements = (body as { body?: unknown }).body
	if (!Array.isArray(statements) || statements.length !== 1) return false
	const only = statements[0]
	if (readNodeType(only) !== 'ReturnStatement') return false
	return isPassthroughAwait(
		(only as { argument?: unknown }).argument,
		importedNames,
	)
}

function isReexportDefaultFromPackage(statement: ModuleAstNode) {
	if (readNodeType(statement) !== 'ExportNamedDeclaration') return false
	const specifier = readLiteralSpecifier(
		(statement as { source?: unknown }).source,
	)
	if (!specifier || !isKodyPackageSpecifier(specifier)) return false
	const specifiers = (statement as { specifiers?: unknown }).specifiers
	if (!Array.isArray(specifiers)) return false
	return specifiers.some((item) => {
		const exported = readIdentifierName(
			(item as { exported?: unknown }).exported,
		)
		if (exported !== 'default') return false
		const local = readIdentifierName((item as { local?: unknown }).local)
		return local === 'default' || local != null
	})
}

async function isPassthroughDefaultExport(
	source: string,
	importedNames: ReadonlySet<string>,
) {
	const body = await getProgramBody(source)
	for (const statement of body) {
		if (isReexportDefaultFromPackage(statement)) return true
		if (readNodeType(statement) !== 'ExportDefaultDeclaration') continue
		const declaration = (statement as { declaration?: unknown }).declaration
		if (isIdentifierNamed(declaration, importedNames)) return true
		const declarationType = readNodeType(declaration)
		if (
			declarationType === 'FunctionDeclaration' ||
			declarationType === 'FunctionExpression' ||
			declarationType === 'ArrowFunctionExpression'
		) {
			return isPassthroughFunctionBody(declaration, importedNames)
		}
	}
	return false
}

/**
 * `thin_single_export` is only the qualifying static `kody:@` import(s) and
 * one passthrough default export. Extra top-level statements are glue.
 */
async function isThinSingleExportProgram(source: string) {
	const body = await getProgramBody(source)
	let sawQualifyingExport = false
	for (const statement of body) {
		const type = readNodeType(statement)
		if (type === 'EmptyStatement') continue
		if (type === 'ImportDeclaration') {
			const specifier = readLiteralSpecifier(
				(statement as { source?: unknown }).source,
			)
			if (!specifier || !isKodyPackageSpecifier(specifier)) return false
			continue
		}
		if (type === 'ExportNamedDeclaration') {
			if (!isReexportDefaultFromPackage(statement)) return false
			if (sawQualifyingExport) return false
			sawQualifyingExport = true
			continue
		}
		if (type === 'ExportDefaultDeclaration') {
			if (sawQualifyingExport) return false
			sawQualifyingExport = true
			continue
		}
		return false
	}
	return sawQualifyingExport
}

/**
 * Classify one ad-hoc execute module. Returns `null` when the source cannot
 * be parsed — callers omit the field rather than inventing a class.
 */
export async function classifyExecuteThinGlue(
	source: string,
): Promise<ExecuteThinGlueClass | null> {
	try {
		const packageImportCount = await collectPackageImportCount(source)
		const importedNames = await collectImportedLocalNames(source)
		const passthrough = await isPassthroughDefaultExport(source, importedNames)
		if (
			packageImportCount === 1 &&
			passthrough &&
			(await isThinSingleExportProgram(source))
		) {
			return 'thin_single_export'
		}
		if (packageImportCount === 1 && passthrough) return 'glue'
		if (packageImportCount >= 1 && packageImportCount <= fewPackageImportMax) {
			return 'thin_few_exports'
		}
		return 'glue'
	} catch {
		return null
	}
}
