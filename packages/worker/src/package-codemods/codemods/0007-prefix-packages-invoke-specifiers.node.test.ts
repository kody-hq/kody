import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, test } from 'vitest'
import { parseModuleSource } from '#worker/module-source.ts'
import type { PackageCodemodFinding as Finding } from '../types.ts'
import { prefixPackagesInvokeSpecifiersCodemod as codemod } from './0007-prefix-packages-invoke-specifiers.ts'

const paths = (findings: Array<Finding>) =>
	findings.map((finding) => finding.path)

function missingSnippets(text: string | undefined, snippets: Array<string>) {
	return snippets.filter((snippet) => !text?.includes(snippet))
}

/** Findings carry a message but never leak the given private source text. */
function expectPrivacySafe(findings: Array<Finding>, secrets: Array<string>) {
	expect(findings.every((finding) => finding.message.length > 0)).toBe(true)
	const serialized = JSON.stringify(findings)
	expect(secrets.filter((secret) => serialized.includes(secret))).toEqual([])
}

function expectIdempotent(
	files: Record<string, string>,
	needsManual: Array<Finding> = [],
) {
	expect(codemod.transform(files)).toEqual({
		files,
		changed: false,
		changedPaths: [],
		needsManual,
	})
}

const wrapperCount = (text: string | undefined) =>
	text?.match(/kody-codemod-0007/g)?.length ?? 0

test('0007 prefixes JS and TS literals while preserving options and export precedence', () => {
	const result = codemod.transform({
		'index.ts': `
const result = await packages.invoke('@owner/pkg/specifier-export', {
  exportName: computedExport,
  params: buildParams(),
  idempotencyKey,
  topic: 'events',
})
await packages?.invoke("@owner/other", options)
await packages.invoke('kody:@owner/already/export', { params: {} })
`,
		'spaced.ts':
			"await packages.invoke('@owner / package / export-name', { exportName: fallback, params: buildParams() })\n",
		'worker.js': 'await packages.invoke(`@owner/template/export`, options)\n',
	})

	expect(result).toMatchObject({
		changed: true,
		changedPaths: ['index.ts', 'spaced.ts', 'worker.js'],
		needsManual: [],
	})
	expect(
		missingSnippets(result.files['index.ts'], [
			"packages.invoke('kody:@owner/pkg/specifier-export', {\n  exportName: computedExport,\n  params: buildParams(),",
			'packages?.invoke("kody:@owner/other", options)',
			"packages.invoke('kody:@owner/already/export', { params: {} })",
		]),
	).toEqual([])
	expect(result.files['worker.js']).toBe(
		'await packages.invoke(`kody:@owner/template/export`, options)\n',
	)
	expect(result.files['spaced.ts']).toBe(
		"await packages.invoke('kody:@owner/package/export-name', { exportName: fallback, params: buildParams() })\n",
	)
	expectIdempotent(result.files)
})

test('0007 detects and rewrites comment-separated packages.invoke access', () => {
	const files = {
		'before-operator.ts': `
await packages /* block note */ .invoke('@owner/block/export')
await packages // line note
  .invoke('@owner/line/export')
`,
		'before-invoke.ts': `
await packages. /* block note */ invoke('@owner/block/export')
await packages. // line note
  invoke('@owner/line/export')
await packages /* optional note */ ?. /* property note */ invoke('@owner/optional/export')
`,
	}
	const findings = codemod.detect(files)
	expect(paths(findings)).toEqual(['before-invoke.ts', 'before-operator.ts'])
	expect(findings.every((finding) => finding.message.length > 0)).toBe(true)

	const result = codemod.transform(files)
	expect(result.changedPaths).toEqual([
		'before-invoke.ts',
		'before-operator.ts',
	])
	expect(result.needsManual).toEqual([])
	expect(
		missingSnippets(result.files['before-operator.ts'], [
			"packages /* block note */ .invoke('kody:@owner/block/export')",
			"packages // line note\n  .invoke('kody:@owner/line/export')",
		]),
	).toEqual([])
	expect(
		missingSnippets(result.files['before-invoke.ts'], [
			"packages. /* block note */ invoke('kody:@owner/block/export')",
			"packages. // line note\n  invoke('kody:@owner/line/export')",
			"packages /* optional note */ ?. /* property note */ invoke('kody:@owner/optional/export')",
		]),
	).toEqual([])
})

test('0007 rewrites only proven Kody packages bindings', () => {
	const untouched = {
		'shadowed.ts': `
await packages.invoke('@owner/file-level/export')
function nested(packages) {
  return packages.invoke('@owner/shadowed/export')
}
`,
		'unrelated-import.ts': `
import { packages } from 'other-library'
await packages.invoke('@owner/unrelated/export')
`,
		'local.ts': `
const packages = { invoke: (value) => value }
packages.invoke('@owner/local/export')
`,
		'ambiguous-alias.ts': `
const packages = runtimePackages
packages.invoke('@private-owner/private-package/export')
`,
		'for-of.ts': `
for (const packages of providers) {
  packages.invoke('@owner/for-of/export')
}
`,
		'switch.ts': `
switch (kind) {
  case 'local': {
    const packages = createPackages()
    packages.invoke('@owner/switch/export')
  }
}
`,
		'class-private.ts': `
class Runner {
  #run(packages) {
    return packages.invoke('@owner/private-method/export')
  }
}
`,
		'ts-namespace.ts': `
namespace packages {
  export const value = true
}
packages.invoke('@owner/namespace/export')
`,
	}
	const result = codemod.transform({
		'global.ts': "await packages.invoke('@owner/global/export')\n",
		'kody-import.ts': `
import { packages } from 'kody:runtime'
await packages.invoke('@owner/imported/export')
`,
		...untouched,
	})

	expect(result.changedPaths).toEqual(['global.ts', 'kody-import.ts'])
	expect(result.files['global.ts']).toContain(
		"packages.invoke('kody:@owner/global/export')",
	)
	expect(result.files['kody-import.ts']).toContain(
		"packages.invoke('kody:@owner/imported/export')",
	)
	// A shadowed inner binding makes the whole file ambiguous.
	expect(result.files).toMatchObject(untouched)
	expect(paths(result.needsManual)).toEqual(
		Object.keys(untouched).sort((left, right) => left.localeCompare(right)),
	)
	expectPrivacySafe(result.needsManual, ['private-owner'])
})

test('0007 rewrites parseable Markdown and MDX examples but never HTML comments', () => {
	const result = codemod.transform({
		'README.md': `
\`\`\`ts
await packages.invoke('@owner/pkg/export', { params: { value: 1 } })
\`\`\`

Inline: \`packages.invoke("@owner/pkg", { exportName: "run" })\`.

\`\`\`text
packages.invoke('@owner/prose/export')
\`\`\`
`,
		'guide.mdx': `
## Example

\`\`\`javascript
await packages?.invoke('@owner/mdx/export', options)
\`\`\`
`,
		'escaping.md':
			"Escaped delimiters: \\`packages.invoke('@owner/escaped/export')\\`.\n\n" +
			"Multi-backtick span: ``packages.invoke('@owner/multiple/export')``.\n",
		'multiline-inline.md':
			'Inline: `packages.invoke(/* private comment\n*/ privateSpecifier)`.\n',
		'comment.md': `
<!--
\`packages.invoke('@private-owner/private-package/export')\`
-->

\`packages.invoke('@owner/visible/export')\`
`,
	})

	expect(result.changedPaths).toEqual(['comment.md', 'guide.mdx', 'README.md'])
	expect(paths(result.needsManual)).toEqual([
		'comment.md',
		'escaping.md',
		'multiline-inline.md',
		'README.md',
	])
	expectPrivacySafe(result.needsManual, ['privateSpecifier', 'private-owner'])
	expect(
		missingSnippets(result.files['README.md'], [
			"packages.invoke('kody:@owner/pkg/export', { params: { value: 1 } })",
			'packages.invoke("kody:@owner/pkg", { exportName: "run" })',
			"```text\npackages.invoke('@owner/prose/export')",
		]),
	).toEqual([])
	expect(result.files['guide.mdx']).toContain(
		"packages?.invoke('kody:@owner/mdx/export', options)",
	)
	expect(
		missingSnippets(result.files['comment.md'], [
			"packages.invoke('@private-owner/private-package/export')",
			"packages.invoke('kody:@owner/visible/export')",
		]),
	).toEqual([])
})

test('0007 partially rewrites safe calls and emits fixed privacy-safe manual findings', () => {
	const files = {
		'ambiguous.ts': `
await packages.invoke('@private-owner/private-package/export', options)
await packages.invoke(dynamicSpecifier, options)
await packages.invoke(\`@\${owner}/pkg/export\`, options)
`,
		'broken.ts': `await packages.invoke('@owner/package/export'`,
		'object-only.ts':
			"await packages.invoke({ kodyId: 'legacy', exportName: 'run' })\n",
	}
	const result = codemod.transform(files)

	expect(result.changedPaths).toEqual(['ambiguous.ts'])
	expect(result.files['ambiguous.ts']).toContain(
		"packages.invoke('kody:@private-owner/private-package/export', options)",
	)
	expect(result.files['object-only.ts']).toBe(files['object-only.ts'])
	expect(paths(result.needsManual)).toEqual(['broken.ts'])
	expectPrivacySafe(result.needsManual, ['private-owner', 'private-package'])
})

test('0007 detect orders rewritable and manual findings and omits prefixed calls', () => {
	const findings = codemod.detect({
		'a-rewrite.ts':
			"packages.invoke('@private-owner/private-package/export')\n",
		'b-manual.ts': 'packages.invoke(privateSpecifier)\n',
		'c-prefixed.ts':
			"packages.invoke('kody:@private-owner/private-package/export')\n",
		'd-parse.ts': "packages.invoke('@private-owner/private-package/export'\n",
		'e-unrelated-parse.ts': 'const packages = (\nconst invoke = true\n',
	})

	expect(paths(findings)).toEqual(['a-rewrite.ts', 'b-manual.ts', 'd-parse.ts'])
	expectPrivacySafe(findings, ['private-owner', 'private-package'])
})

test('0007 evaluates dynamic JS specifiers and sequence expressions once and preserves runtime rejection inputs', () => {
	const run = (source: string) => {
		const result = codemod.transform({ 'index.js': source })
		const transformed = result.files['index.js'] ?? ''
		const observed: Array<unknown> = []
		const context: {
			codemodResult?: Record<string, unknown>
			packages: { invoke(value: unknown): unknown }
		} = {
			packages: {
				invoke(value) {
					observed.push(value)
					if (value === 'not-a-specifier' || typeof value !== 'string') {
						throw new Error('rejected')
					}
					return value
				},
			},
		}
		runInNewContext(transformed, context)
		return {
			result,
			transformed,
			observed,
			codemodResult: context.codemodResult,
		}
	}

	const dynamic = run(`
let producerCalls = 0
function produce(value) {
  producerCalls += 1
  return value
}
packages.invoke(produce('  @owner/pkg/export  '))
packages.invoke(produce('kody:@owner/already'))
try { packages.invoke(produce('not-a-specifier')) } catch {}
try { packages.invoke(produce(42)) } catch {}
globalThis.codemodResult = { producerCalls }
`)
	expect(dynamic.transformed).toContain('kody-codemod-0007')
	expect(dynamic.transformed).not.toMatch(/: unknown| as `kody:/)
	expect(dynamic.codemodResult).toEqual({ producerCalls: 4 })
	expect(dynamic.observed).toEqual([
		'kody:@owner/pkg/export',
		'kody:@owner/already',
		'not-a-specifier',
		42,
	])

	const sequence = run(`
let initCalls = 0
function init() {
  initCalls += 1
}
const spec = '@owner/pkg/run'
const result = packages.invoke((init(), spec))
globalThis.codemodResult = { initCalls, result }
`)
	expect(sequence.transformed).toContain('})((init(), spec)))')
	expect(sequence.codemodResult).toEqual({
		initCalls: 1,
		result: 'kody:@owner/pkg/run',
	})
	expect(sequence.observed).toEqual(['kody:@owner/pkg/run'])
	expectIdempotent(sequence.result.files)
})

test('0007 normalizes every parseable dynamic expression and preserves the rest of each call', () => {
	const result = codemod.transform({
		'index.ts': `
const __kodyCodemod0007Value = outerValue
const __kodyCodemod0007Trimmed = outerTrimmed
await packages.invoke(result.exports[0].import_specifier, {
  exportName: chooseExport(primary, fallback),
  params: buildParams({ complete: true }),
  idempotencyKey: event.id,
  topic: \`events:\${kind}\`,
})
await packages.invoke(condition ? left : right, options)
await packages.invoke(getSpecifier(input), buildOptions())
await packages.invoke(\`@\${owner}/\${packageName}/run\`, options)
await packages?.invoke(__kodyCodemod0007Value, options)
`,
	})
	const transformed = result.files['index.ts']

	expect(result.needsManual).toEqual([])
	expect(wrapperCount(transformed)).toBe(5)
	expect(
		missingSnippets(transformed, [
			'})((result.exports[0].import_specifier)), {\n  exportName: chooseExport(primary, fallback),\n  params: buildParams({ complete: true }),\n  idempotencyKey: event.id,\n  topic: `events:${kind}`,\n})',
			'})((condition ? left : right)), options)',
			'})((getSpecifier(input))), buildOptions())',
			'})((`@${owner}/${packageName}/run`)), options)',
			'packages?.invoke(((__kodyCodemod0007Value: unknown)',
			'})((__kodyCodemod0007Value)), options)',
		]),
	).toEqual([])
})

test('0007 rewrites non-null, static computed, and nested invoke forms but ignores dynamic keys', () => {
	const files = {
		'non-null.ts': `
packages!.invoke(firstSpecifier, firstOptions)
packages.invoke!(secondSpecifier, secondOptions)
packages!.invoke!(thirdSpecifier, thirdOptions)
(packages.invoke(fourthSpecifier, fourthOptions))!
`,
		'computed.ts': `
packages['invoke'](firstSpecifier, firstOptions)
packages["invoke"](secondSpecifier, secondOptions)
packages?.['invoke']?.(thirdSpecifier, thirdOptions)
`,
		'dynamic.ts': 'packages[method](dynamicSpecifier, options)\n',
		'nested.js':
			'packages.invoke(select(packages.invoke(innerSpecifier)), outerOptions)\n',
	}
	const result = codemod.transform(files)

	expect(result.changedPaths).toEqual([
		'computed.ts',
		'nested.js',
		'non-null.ts',
	])
	expect(result.needsManual).toEqual([])
	expect(result.files['dynamic.ts']).toBe(files['dynamic.ts'])
	expect(wrapperCount(result.files['non-null.ts'])).toBe(4)
	expect(
		missingSnippets(result.files['non-null.ts'], [
			'})((firstSpecifier)), firstOptions)',
			'})((secondSpecifier)), secondOptions)',
			'})((thirdSpecifier)), thirdOptions)',
			'})((fourthSpecifier)), fourthOptions))!',
		]),
	).toEqual([])
	expect(wrapperCount(result.files['computed.ts'])).toBe(3)
	expect(
		missingSnippets(result.files['computed.ts'], [
			"packages['invoke']((",
			'packages["invoke"]((',
			"packages?.['invoke']?.((",
		]),
	).toEqual([])
	// Nested arg0 rewrites compose without overlapping ranges.
	expect(wrapperCount(result.files['nested.js'])).toBe(2)
	expect(
		missingSnippets(result.files['nested.js'], [
			'packages.invoke(/** @type {`kody:@${string}/${string}`} */',
			'select(packages.invoke(/** @type {`kody:@${string}/${string}`} */',
		]),
	).toEqual([])
})

test('0007 emits type-correct TS and JSDoc-only JS wrappers', () => {
	const result = codemod.transform({
		'index.ts':
			"declare const dynamicSpecifier: unknown\npackages.invoke(dynamicSpecifier, { exportName: 'run' })\n",
		'worker.js': `
export {}
const dynamicSpecifier = /** @type {unknown} */ (null)
const options = {}
packages.invoke(dynamicSpecifier, options)
`,
	})
	const virtualFiles: Record<string, string> = {
		'index.ts': result.files['index.ts'] ?? '',
		'worker.js': result.files['worker.js'] ?? '',
		'runtime.d.ts': `
declare const packages: {
  invoke(specifier: \`kody:@\${string}/\${string}\`, options?: unknown): unknown
}
`,
	}
	const compilerOptions = {
		allowJs: true,
		checkJs: true,
		noEmit: true,
		strict: true,
		target: ts.ScriptTarget.ES2022,
	} satisfies ts.CompilerOptions
	const host = ts.createCompilerHost(compilerOptions)
	const getSourceFile = host.getSourceFile.bind(host)
	const fileExists = host.fileExists.bind(host)
	const readFile = host.readFile.bind(host)
	host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
		const text = virtualFiles[fileName]
		if (text === undefined) {
			return getSourceFile(fileName, languageVersion, onError, shouldCreate)
		}
		return ts.createSourceFile(
			fileName,
			text,
			languageVersion,
			true,
			fileName.endsWith('.js') ? ts.ScriptKind.JS : undefined,
		)
	}
	host.fileExists = (fileName) =>
		fileName in virtualFiles || fileExists(fileName)
	host.readFile = (fileName) => virtualFiles[fileName] ?? readFile(fileName)
	const diagnostics = ts.getPreEmitDiagnostics(
		ts.createProgram({
			rootNames: Object.keys(virtualFiles),
			options: compilerOptions,
			host,
		}),
	)

	expect(
		diagnostics.map((diagnostic) =>
			ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
		),
	).toEqual([])
	expect(virtualFiles['index.ts']).toContain(
		'(__kodyCodemod0007Value: unknown): `kody:@${string}/${string}`',
	)
	expect(
		missingSnippets(virtualFiles['worker.js'], [
			'/** @type {`kody:@${string}/${string}`} */',
			'/** @type {unknown} */',
		]),
	).toEqual([])
	expect(virtualFiles['worker.js']).not.toMatch(/: unknown| as `kody:/)
})

test('0007 normalizes parseable Markdown dynamics with valid inline code and is idempotent', () => {
	const result = codemod.transform({
		'guide.md': `
\`\`\`ts
await packages.invoke(metadata.import_specifier, options)
\`\`\`

\`\`\`js
await packages.invoke(makeSpecifier(), options)
\`\`\`

Inline: \`packages.invoke(condition ? left : right, { exportName: chooseExport() })\`.
`,
		'guide.mdx': `
\`\`\`tsx
await packages?.invoke(\`@\${owner}/pkg/run\`, options)
\`\`\`
`,
		'inline.md':
			'Inline: `packages.invoke(condition ? left : right, options)`.\n',
	})

	expect(result.changedPaths).toEqual(['guide.md', 'guide.mdx', 'inline.md'])
	expect(result.needsManual).toEqual([])
	expect(
		missingSnippets(result.files['guide.md'], [
			'(__kodyCodemod0007Value: unknown)',
			'/** @type {any} */',
		]),
	).toEqual([])
	expect(result.files['guide.mdx']).toContain('kody-codemod-0007')
	expectIdempotent(result.files)
	expect(codemod.detect(result.files)).toEqual([])

	// Generated single-backtick inline code stays one valid span.
	const inline = result.files['inline.md'] ?? ''
	expect(inline.match(/`/g)).toHaveLength(2)
	expect(inline).toContain('/** @type {any} */')
	expect(inline).not.toContain('`kody:@${string}/${string}`')
	expect(() =>
		parseModuleSource(
			inline.slice(inline.indexOf('`') + 1, inline.lastIndexOf('`')),
		),
	).not.toThrow()
})

test('0007 confines malformed inline delimiters to physical lines', () => {
	const malformed = [
		'Malformed: `packages.invoke(/* private-source',
		'backtick on another line `',
		'*/ privateSpecifier)`.',
	].join('\r\n')
	const ordinary = 'Ordinary: `balanced /* Markdown prose */ span` stays.'
	const unmatchedCommentProse =
		'Ordinary unmatched /* prose does not suppress later spans.'
	const prose =
		'Intervening prose packages.invoke(privateProse) must remain unchanged.'
	const later = 'Later: `packages.invoke(laterSpecifier, laterOptions)`.'
	const result = codemod.transform({
		'recovery.md': [
			malformed,
			'',
			ordinary,
			unmatchedCommentProse,
			prose,
			'',
			later,
			'',
		].join('\r\n'),
	})

	expect(result.changedPaths).toEqual(['recovery.md'])
	expect(paths(result.needsManual)).toEqual(['recovery.md'])
	expect(
		missingSnippets(result.files['recovery.md'], [
			malformed,
			ordinary,
			unmatchedCommentProse,
			prose,
			'Later: `packages.invoke(/** @type {any} */',
		]),
	).toEqual([])
	expectIdempotent(result.files, result.needsManual)
	expectPrivacySafe(result.needsManual, [
		'private-source',
		'privateSpecifier',
		'privateProse',
		'laterSpecifier',
	])
})

test('0007 Markdown fallback requires a call shape and keeps findings privacy-safe', () => {
	const privateSource = '@private-owner/private-package/private-export'
	const files = {
		'discord.md':
			'Architecture labels: packages.invoke → runtime worker → package export.\n',
		'prose.md': `A malformed example packages.invoke(${privateSource} remains here.\n`,
		'untyped.md': `\`\`\`text\npackages.invoke(${privateSource})\n\`\`\`\n`,
		'broken.ts': `packages.invoke(${privateSource}\n`,
		'broken-optional.ts': `packages.invoke /* private */ ?. (${privateSource}\n`,
		'broken-non-null-packages.ts': `packages! /* private */ .invoke(${privateSource}\n`,
		'broken-non-null-invoke.ts': `packages.invoke! /* private */ (${privateSource}\n`,
		'broken-non-null-both.ts': `packages! /* private */ .invoke! /* private */ ?. (${privateSource}\n`,
	}
	const result = codemod.transform(files)

	expect(result.files).toEqual(files)
	expect(result.changed).toBe(false)
	// discord.md has no call shape, so it is not reported.
	expect(paths(result.needsManual)).toEqual([
		'broken-non-null-both.ts',
		'broken-non-null-invoke.ts',
		'broken-non-null-packages.ts',
		'broken-optional.ts',
		'broken.ts',
		'prose.md',
		'untyped.md',
	])
	expectPrivacySafe(result.needsManual, [
		privateSource,
		'private-owner',
		'private-package',
	])
})

test('0007 treats packages and packages.invoke mutations as ambiguous', () => {
	const call = '\npackages.invoke(dynamicSpecifier)\n'
	const files = Object.fromEntries(
		Object.entries({
			'assigned-invoke.js': 'packages.invoke = value => value',
			'assigned-packages.js': 'packages = otherPackages',
			'assigned-computed-invoke.js': "packages['invoke'] = replacement",
			'assigned-non-null-invoke.ts': 'packages!.invoke = replacement',
			'updated-invoke.js': 'packages.invoke++',
			'updated-packages.js': 'packages++',
			'deleted-invoke.js': 'delete packages.invoke',
			'deleted-optional-invoke.js': 'delete packages?.invoke',
			'destructured-object-assignment.js': '({ packages } = replacements)',
			'destructured-array-assignment.js': ';[packages] = values',
			'for-of-assignment.js': 'for (packages of providers) {}',
			'for-in-assignment.js': 'for (packages in providers) {}',
			'for-of-object-assignment.js': 'for ({ packages } of providers) {}',
			'for-in-array-assignment.js': 'for ([packages] in providers) {}',
		}).map(([path, mutation]) => [path, `${mutation}${call}`]),
	)
	const result = codemod.transform(files)

	expect(result.changed).toBe(false)
	expect(result.files).toEqual(files)
	expect(paths(result.needsManual)).toEqual(
		Object.keys(files).sort((left, right) => left.localeCompare(right)),
	)
	expectPrivacySafe(result.needsManual, ['dynamicSpecifier'])
})
