#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
const [baselineArg, candidateArg, outputArg] = process.argv.slice(2)
if (!baselineArg || !candidateArg || !outputArg)
	throw new Error(
		'Usage: node source-comparison.mjs BASELINE_ROOT CANDIDATE_ROOT OUTPUT_JSON',
	)
const baseline = path.resolve(baselineArg)
const candidate = path.resolve(candidateArg)
const out = path.resolve(outputArg)
function walk(dir) {
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.flatMap((e) =>
			e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
		)
}
function measure(root, dir) {
	const files = walk(path.join(root, dir)).filter(
		(f) =>
			/\.[jt]sx?$/.test(f) && !/(?:\.test|\.spec|\.gen|\.d)\.[jt]sx?$/.test(f),
	)
	const summaries = files.map((file) => {
		const source = fs.readFileSync(file, 'utf8')
		const ast = ts.createSourceFile(
			file,
			source,
			ts.ScriptTarget.Latest,
			true,
			file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
		)
		let functions = 0,
			decisions = 0,
			handleUpdateCalls = 0,
			routeDataCalls = 0,
			serverFunctions = 0
		const imports = []
		function visit(n) {
			if (ts.isCallExpression(n)) {
				const callee = n.expression.getText(ast)
				if (callee === 'handle.update') handleUpdateCalls++
				if (callee === 'createRouteData') routeDataCalls++
				if (callee === 'createServerFn') serverFunctions++
			}
			if (
				ts.isFunctionDeclaration(n) ||
				ts.isFunctionExpression(n) ||
				ts.isArrowFunction(n) ||
				ts.isMethodDeclaration(n)
			)
				functions++
			if (
				ts.isIfStatement(n) ||
				ts.isConditionalExpression(n) ||
				ts.isCaseClause(n) ||
				ts.isForStatement(n) ||
				ts.isForOfStatement(n) ||
				ts.isForInStatement(n) ||
				ts.isWhileStatement(n) ||
				ts.isDoStatement(n) ||
				ts.isCatchClause(n) ||
				(ts.isBinaryExpression(n) &&
					[
						ts.SyntaxKind.AmpersandAmpersandToken,
						ts.SyntaxKind.BarBarToken,
						ts.SyntaxKind.QuestionQuestionToken,
					].includes(n.operatorToken.kind))
			)
				decisions++
			if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
				const typeOnly =
					n.importClause?.isTypeOnly ||
					(n.importClause?.namedBindings &&
						ts.isNamedImports(n.importClause.namedBindings) &&
						n.importClause.namedBindings.elements.length > 0 &&
						n.importClause.namedBindings.elements.every((x) => x.isTypeOnly))
				imports.push({ module: n.moduleSpecifier.text, typeOnly: !!typeOnly })
			}
			ts.forEachChild(n, visit)
		}
		visit(ast)
		return {
			path: path.relative(root, file),
			lines: source.split('\n').length,
			nonblankLines: source.split('\n').filter((l) => l.trim()).length,
			bytes: Buffer.byteLength(source),
			functions,
			decisions,
			handleUpdateCalls,
			routeDataCalls,
			serverFunctions,
			imports,
		}
	})
	return {
		directory: dir,
		files: summaries.length,
		lines: summaries.reduce((n, f) => n + f.lines, 0),
		nonblankLines: summaries.reduce((n, f) => n + f.nonblankLines, 0),
		functions: summaries.reduce((n, f) => n + f.functions, 0),
		decisions: summaries.reduce((n, f) => n + f.decisions, 0),
		handleUpdateCalls: summaries.reduce((n, f) => n + f.handleUpdateCalls, 0),
		routeDataCalls: summaries.reduce((n, f) => n + f.routeDataCalls, 0),
		serverFunctions: summaries.reduce((n, f) => n + f.serverFunctions, 0),
		filesDetail: summaries,
	}
}
const old = measure(baseline, 'packages/worker/client')
const native = measure(candidate, 'packages/worker/start')
const retained = measure(candidate, 'packages/worker/client')
const importedLegacy = [
	...new Set(
		native.filesDetail.flatMap((f) =>
			f.imports
				.filter(
					(i) =>
						!i.typeOnly &&
						(i.module.startsWith('#client/') || i.module.includes('/client/')),
				)
				.map((i) => i.module),
		),
	),
].sort()
const report = {
	measuredAt: new Date().toISOString(),
	baselineCommit: '8b2528460',
	baselineClient: old,
	candidateNative: native,
	candidateRetainedClient: retained,
	nativeRuntimeImportsFromLegacyClient: importedLegacy,
	caveats: [
		'Snapshot during ongoing migration validation; source can change after measurement.',
		'Generated files, declaration files and test files excluded.',
		'Decision counts include if/conditional/case/loops/catch and logical/nullish expressions; they are syntax counts, not cyclomatic complexity or maintainability scores.',
		'Baseline client includes data-only utilities; native imports many retained utilities, so native-only size is not like-for-like total ownership.',
		'Unused retained legacy files still count as source maintenance surface but not necessarily runtime transfer.',
	],
}
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
console.log(
	JSON.stringify(
		{
			baselineClient: { ...old, filesDetail: undefined },
			candidateNative: { ...native, filesDetail: undefined },
			candidateRetainedClient: { ...retained, filesDetail: undefined },
			nativeRuntimeImportsFromLegacyClient: importedLegacy.length,
		},
		null,
		2,
	),
)
