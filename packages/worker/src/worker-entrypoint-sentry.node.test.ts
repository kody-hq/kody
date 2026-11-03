import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { expect, test } from 'vitest'

const srcDir = path.resolve(import.meta.dirname)

/**
 * Entrypoints left bare on purpose. Their RPC throws are caller-facing
 * results for sandboxed user code (host denials, missing credentials,
 * undeclared capabilities), so wrapping would page on user mistakes.
 */
const bareEntrypointAllowlist = new Map([
	['mcp/fetch-gateway.ts', 'KodyFetchGateway'],
	['package-runtime/package-app.ts', 'PackageAppRuntimeBridge'],
])

function listSourceFiles(dir: string): Array<string> {
	return readdirSync(dir).flatMap((name) => {
		const full = path.join(dir, name)
		if (statSync(full).isDirectory()) {
			return name === 'test-support' ? [] : listSourceFiles(full)
		}
		return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : []
	})
}

function extendsWorkerEntrypoint(node: ts.ClassDeclaration) {
	return (
		node.heritageClauses?.some((clause) =>
			clause.types.some((type) => {
				const expression = type.expression
				return (
					ts.isIdentifier(expression) && expression.text === 'WorkerEntrypoint'
				)
			}),
		) ?? false
	)
}

/** Top-level `WorkerEntrypoint` classes not wrapped with `Sentry.withSentry`. */
export function findBareWorkerEntrypoints(source: string): Array<string> {
	const sourceFile = ts.createSourceFile(
		'entry.ts',
		source,
		ts.ScriptTarget.Latest,
		true,
	)
	const classes = sourceFile.statements.filter(
		(statement): statement is ts.ClassDeclaration & { name: ts.Identifier } =>
			ts.isClassDeclaration(statement) &&
			statement.name !== undefined &&
			extendsWorkerEntrypoint(statement),
	)
	const wrapped = new Set<string>()
	const visit = (node: ts.Node) => {
		if (
			ts.isCallExpression(node) &&
			node.expression.getText(sourceFile) === 'Sentry.withSentry'
		) {
			const handler = node.arguments[1]
			if (handler && ts.isIdentifier(handler)) wrapped.add(handler.text)
		}
		ts.forEachChild(node, visit)
	}
	visit(sourceFile)
	return classes
		.filter((node) => {
			const exported =
				ts
					.getModifiers(node)
					?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
				false
			return exported || !wrapped.has(node.name.text)
		})
		.map((node) => node.name.text)
}

test('every worker WorkerEntrypoint is exported through Sentry.withSentry', () => {
	const bare = listSourceFiles(srcDir).flatMap((file) => {
		const relative = path.relative(srcDir, file).split(path.sep).join('/')
		return findBareWorkerEntrypoints(readFileSync(file, 'utf8'))
			.filter((name) => bareEntrypointAllowlist.get(relative) !== name)
			.map((name) => `${relative}: ${name}`)
	})
	expect(bare).toEqual([])
})

test('findBareWorkerEntrypoints flags exported and unwrapped classes only', () => {
	expect(
		findBareWorkerEntrypoints(`
			export class Bare extends WorkerEntrypoint {}
			class Unwrapped extends WorkerEntrypoint {}
			class Wrapped extends WorkerEntrypoint {}
			export const Ok = Sentry.withSentry(options, Wrapped)
			const generated = \`export class Generated extends WorkerEntrypoint {}\`
		`),
	).toEqual(['Bare', 'Unwrapped'])
})
