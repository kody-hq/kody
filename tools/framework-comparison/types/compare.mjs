#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'
import { createHash } from 'node:crypto'
const [remix, before, current, output] = process.argv
	.slice(2)
	.map((p) => path.resolve(p))
fs.mkdirSync(output, { recursive: true })
const tool = path.join(
	current,
	'tools/framework-comparison/source-comparison.mjs',
)
for (const [label, candidate] of [
	['before', before],
	['current', current],
])
	execFileSync(
		process.execPath,
		[tool, remix, candidate, path.join(output, `${label}-raw.json`)],
		{ stdio: 'ignore' },
	)
const previous = JSON.parse(
	fs.readFileSync(path.join(output, 'before-raw.json')),
)
const latest = JSON.parse(
	fs.readFileSync(path.join(output, 'current-raw.json')),
)
const names = [
	'account-jobs.tsx',
	'account-jobs-detail.tsx',
	'account-jobs-shared.ts',
]
function summarize(root, files) {
	const details = files.map((entry) => {
		const text = fs.readFileSync(path.join(root, entry.path), 'utf8')
		const ast = ts.createSourceFile(
			entry.path,
			text,
			ts.ScriptTarget.Latest,
			true,
		)
		let assertions = 0,
			nonNullAssertions = 0,
			explicitGenericCalls = 0
		function visit(node) {
			if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node))
				assertions++
			if (ts.isNonNullExpression(node)) nonNullAssertions++
			if (ts.isCallExpression(node) && node.typeArguments?.length)
				explicitGenericCalls++
			ts.forEachChild(node, visit)
		}
		visit(ast)
		return {
			...entry,
			sha256: createHash('sha256').update(text).digest('hex'),
			assertions,
			nonNullAssertions,
			explicitGenericCalls,
		}
	})
	const keys = [
		'lines',
		'nonblankLines',
		'functions',
		'decisions',
		'assertions',
		'nonNullAssertions',
		'explicitGenericCalls',
	]
	return {
		files: details.length,
		...Object.fromEntries(
			keys.map((key) => [key, details.reduce((n, f) => n + f[key], 0)]),
		),
		distinctImports: new Set(
			details.flatMap((f) => f.imports.map((i) => i.module)),
		).size,
		details,
	}
}
const matches = (f) => names.includes(path.basename(f.path))
const report = {
	scope:
		'Same three handwritten jobs UI/action files, shared helpers and framework adapters reported separately. Nonblank LOC includes comments. Syntax decisions are not cyclomatic complexity.',
	remix: summarize(remix, previous.baselineClient.filesDetail.filter(matches)),
	startBefore: summarize(
		before,
		previous.candidateNative.filesDetail.filter(matches),
	),
	startCurrent: summarize(
		current,
		latest.candidateNative.filesDetail.filter(matches),
	),
	startRouteAdapters: summarize(
		current,
		latest.candidateNative.filesDetail.filter((f) =>
			/routes\/account_\.jobs(?:_|\.)/.test(f.path),
		),
	),
	retainedJobsFilter: summarize(
		current,
		latest.candidateRetainedClient.filesDetail.filter((f) =>
			f.path.endsWith('/account-jobs-filter.ts'),
		),
	),
}
fs.writeFileSync(
	path.join(output, 'jobs-scope.json'),
	JSON.stringify(report, null, 2) + '\n',
)
console.log(
	JSON.stringify(
		Object.fromEntries(
			Object.entries(report)
				.filter(([, v]) => typeof v === 'object')
				.map(([k, { details: _details, ...v }]) => [k, v]),
		),
		null,
		2,
	),
)

function allocated(root, file, declarationNames = null) {
	const source = fs.readFileSync(path.join(root, file), 'utf8')
	const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
	const nodes = declarationNames
		? ast.statements.filter((node) =>
				declarationNames.some(
					(name) =>
						(ts.isFunctionDeclaration(node) && node.name?.text === name) ||
						(ts.isVariableStatement(node) &&
							node.declarationList.declarations.some(
								(declaration) => declaration.name.getText(ast) === name,
							)),
				),
			)
		: [ast]
	const text = nodes.map((node) => node.getText(ast)).join('\n')
	const functions = []
	function decision(node) {
		return (
			ts.isIfStatement(node) ||
			ts.isConditionalExpression(node) ||
			ts.isForStatement(node) ||
			ts.isForOfStatement(node) ||
			ts.isForInStatement(node) ||
			ts.isWhileStatement(node) ||
			ts.isDoStatement(node) ||
			ts.isCatchClause(node) ||
			ts.isCaseClause(node) ||
			(ts.isBinaryExpression(node) &&
				[
					ts.SyntaxKind.AmpersandAmpersandToken,
					ts.SyntaxKind.BarBarToken,
					ts.SyntaxKind.QuestionQuestionToken,
				].includes(node.operatorToken.kind))
		)
	}
	function visit(node) {
		if (ts.isFunctionLike(node) && node.body) {
			let complexity = 1
			function count(child) {
				if (ts.isFunctionLike(child) && child !== node) return
				if (decision(child)) complexity++
				ts.forEachChild(child, count)
			}
			count(node)
			functions.push({
				name:
					node.name?.getText(ast) ??
					node.parent?.name?.getText(ast) ??
					'<anonymous>',
				line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
				complexity,
			})
		}
		ts.forEachChild(node, visit)
	}
	nodes.forEach(visit)
	return {
		path: file,
		allocatedDeclarations: declarationNames,
		nonblankLines: text.split('\n').filter((line) => line.trim()).length,
		functions,
	}
}
function cyclomatic(files) {
	const functions = files
		.flatMap((file) => file.functions.map((fn) => ({ path: file.path, ...fn })))
		.sort((a, b) => a.complexity - b.complexity)
	const mid = Math.floor(functions.length / 2)
	return {
		files: files.length,
		allocatedNonblankLines: files.reduce((n, f) => n + f.nonblankLines, 0),
		functionCount: functions.length,
		sum: functions.reduce((n, f) => n + f.complexity, 0),
		median:
			functions.length % 2
				? functions[mid].complexity
				: (functions[mid - 1].complexity + functions[mid].complexity) / 2,
		max: functions.at(-1)?.complexity ?? 0,
		top: functions.slice(-5).reverse(),
		details: files,
	}
}
const cohorts = {}
for (const [label, root] of [
	['remix', remix],
	['startBefore', before],
	['startCurrent', current],
]) {
	const dir = label === 'remix' ? 'client/routes' : 'start/pages'
	const files = names.map((name) =>
		allocated(root, `packages/worker/${dir}/${name}`),
	)
	files.push(
		allocated(root, 'packages/worker/client/routes/account-jobs-filter.ts'),
	)
	if (label !== 'remix') {
		for (const name of ['account_.jobs.tsx', 'account_.jobs_.$jobId.tsx'])
			files.push(allocated(root, `packages/worker/start/routes/${name}`))
		files.push(
			allocated(root, 'packages/worker/start/server/account-collections.ts', [
				'loadJobsPage',
			]),
		)
	}
	cohorts[label] = cyclomatic(files)
}
cohorts.sharedStartAuthentication = cyclomatic([
	allocated(current, 'packages/worker/start/server/account-collections.ts', [
		'loadCollection',
	]),
])
fs.writeFileSync(
	path.join(output, 'jobs-allocated-complexity.json'),
	JSON.stringify(
		{
			definition:
				'Per executable function: base 1 plus if/conditional/loops/catch/non-default case/&&/||/??. Nested function decisions are counted only in that nested function. Syntax-based cyclomatic estimate, not a formal control-flow graph.',
			cohorts,
		},
		null,
		2,
	) + '\n',
)
console.log(
	JSON.stringify(
		Object.fromEntries(
			Object.entries(cohorts).map(([key, { details: _details, ...value }]) => [
				key,
				value,
			]),
		),
		null,
		2,
	),
)

function broad(root, summary) {
	const counts = {
		...Object.fromEntries(
			[
				'files',
				'nonblankLines',
				'functions',
				'decisions',
				'serverFunctions',
			].map((key) => [key, summary[key]]),
		),
		validateSearchProperties: 0,
		validators: 0,
		loaderDataCalls: 0,
		genericJsonReads: 0,
		genericStateCalls: 0,
		asAny: 0,
		anyTypeNodes: 0,
		explicitReturnTypes: 0,
	}
	for (const file of summary.filesDetail) {
		const source = fs.readFileSync(path.join(root, file.path), 'utf8')
		const ast = ts.createSourceFile(
			file.path,
			source,
			ts.ScriptTarget.Latest,
			true,
		)
		function visit(n) {
			if (
				(ts.isPropertyAssignment(n) || ts.isMethodDeclaration(n)) &&
				n.name?.getText(ast) === 'validateSearch'
			)
				counts.validateSearchProperties++
			if (ts.isAsExpression(n) && n.type.kind === ts.SyntaxKind.AnyKeyword)
				counts.asAny++
			if (n.kind === ts.SyntaxKind.AnyKeyword) counts.anyTypeNodes++
			if (ts.isFunctionLike(n) && n.body && n.type) counts.explicitReturnTypes++
			if (ts.isCallExpression(n)) {
				const name = ts.isPropertyAccessExpression(n.expression)
					? n.expression.name.text
					: n.expression.getText(ast)
				if (['validator', 'inputValidator'].includes(name)) counts.validators++
				if (name === 'useLoaderData') counts.loaderDataCalls++
				if (name === 'readJson' && n.typeArguments?.length)
					counts.genericJsonReads++
				if (name === 'useState' && n.typeArguments?.length)
					counts.genericStateCalls++
			}
			ts.forEachChild(n, visit)
		}
		visit(ast)
	}
	return counts
}
fs.writeFileSync(
	path.join(output, 'frontend-overall.json'),
	JSON.stringify(
		{
			scope:
				'Handwritten directories, excluding generated/declarations/tests/vendor. Native includes its server adapters, legacy client does not include existing Worker handlers. Retained client is maintenance surface, not all shipped code. Shared backend excluded from both.',
			remixClient: broad(remix, previous.baselineClient),
			startBeforeNative: broad(before, previous.candidateNative),
			startCurrentNative: broad(current, latest.candidateNative),
			startRetainedClient: broad(current, latest.candidateRetainedClient),
		},
		null,
		2,
	) + '\n',
)
