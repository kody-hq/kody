import { expect, test, vi } from 'vitest'
import * as moduleSource from '#worker/module-source.ts'
import {
	collectDynamicImportExpressionNodes,
	collectLiteralImportNodes,
	collectLiteralImportSpecifiers,
	collectModuleImportNodes,
	parseBundlerResolvedSpecifiers,
} from './import-specifiers.ts'
import { collectStaticKodyPackageImportsFromFiles } from './static-kody-imports.ts'

test('collectLiteralImportSpecifiers ignores type-only import and export sources', () => {
	const specifiers = collectLiteralImportSpecifiers(
		[
			'import type { Config } from "kody:@kentcdodds/types/config"',
			'import helper from "kody:@kentcdodds/helper/run"',
			'export { type Result } from "kody:@kentcdodds/types/result"',
			'export { run, type RunInput } from "kody:@kentcdodds/runner"',
			'export type { Other } from "kody:@kentcdodds/types/other"',
			'export * from "kody:@kentcdodds/all"',
			'const dynamic = import("kody:@kentcdodds/dynamic")',
			'void dynamic',
			'void helper',
		].join('\n'),
	)

	expect(specifiers).toEqual([
		'kody:@kentcdodds/helper/run',
		'kody:@kentcdodds/runner',
		'kody:@kentcdodds/all',
		'kody:@kentcdodds/dynamic',
	])
})

test('collectLiteralImportSpecifiers includes declarations and TS import types when requested', () => {
	const specifiers = collectLiteralImportSpecifiers(
		[
			'import type { Config } from "kody:@kentcdodds/types/config"',
			'export type { Other } from "kody:@kentcdodds/types/other"',
			'type Detail = import("kody:@kentcdodds/types/detail").Detail',
		].join('\n'),
		{ includeTypeOnly: true },
	)

	expect(specifiers).toEqual([
		'kody:@kentcdodds/types/config',
		'kody:@kentcdodds/types/other',
		'kody:@kentcdodds/types/detail',
	])
})

test('collectModuleImportNodes parses once for literal and dynamic import sites', () => {
	const source = [
		'import helper from "./helper.ts"',
		'const value = await import("./dynamic.ts")',
		'export { helper, value }',
	].join('\n')
	const parseSpy = vi.spyOn(moduleSource, 'parseModuleSource')
	parseSpy.mockClear()

	const nodes = collectModuleImportNodes(source)
	expect(parseSpy).toHaveBeenCalledTimes(1)
	expect(nodes.literalImports.map((node) => node.specifier)).toEqual([
		'./helper.ts',
		'./dynamic.ts',
	])
	expect(nodes.dynamicImportExpressions).toHaveLength(1)
	expect(nodes.dynamicImportExpressions[0]?.literalSpecifier).toBe(
		'./dynamic.ts',
	)

	// Legacy helpers stay compatible with the combined collector.
	expect(collectLiteralImportNodes(source)).toEqual(nodes.literalImports)
	expect(collectDynamicImportExpressionNodes(source)).toEqual(
		nodes.dynamicImportExpressions,
	)
	parseSpy.mockRestore()
})

test('dynamic import() with TS assertion or static template stays literal', () => {
	const cases: Array<{ source: string; specifier: string }> = [
		{
			source: `await import('kody:@kentcdodds/grok-bot/wake' as \`kody:@\${string}/\${string}\`)`,
			specifier: 'kody:@kentcdodds/grok-bot/wake',
		},
		{
			source: `await import(('kody:@kentcdodds/helper/run' as string))`,
			specifier: 'kody:@kentcdodds/helper/run',
		},
		{
			source: 'await import(`kody:@kentcdodds/helper/run`)',
			specifier: 'kody:@kentcdodds/helper/run',
		},
	]
	for (const { source, specifier } of cases) {
		const nodes = collectDynamicImportExpressionNodes(source)
		expect(nodes, source).toHaveLength(1)
		expect(nodes[0]?.literalSpecifier, source).toBe(specifier)
		expect(
			collectLiteralImportNodes(source).map((node) => node.specifier),
			source,
		).toEqual([specifier])
	}

	const computed = collectDynamicImportExpressionNodes(
		'await import(subscriber.importSpecifier)',
	)
	expect(computed).toHaveLength(1)
	expect(computed[0]?.literalSpecifier).toBeNull()
})

const genericArrowWithImports = [
	'import helper from "kody:@kentcdodds/helper/run"',
	'const first = <T>(xs: T[]): T | undefined => xs[0]',
	'export default () => first([helper])',
].join('\n')

test('import scans pick the parser by file extension', () => {
	expect(
		collectLiteralImportSpecifiers(genericArrowWithImports, {
			filePath: 'src/app.ts',
		}),
	).toEqual(['kody:@kentcdodds/helper/run'])
	expect(
		parseBundlerResolvedSpecifiers(genericArrowWithImports, {
			filePath: 'src/app.ts',
		}),
	).toEqual({ ok: true, specifiers: ['kody:@kentcdodds/helper/run'] })
	expect(
		parseBundlerResolvedSpecifiers(genericArrowWithImports, {
			filePath: 'src/app.tsx',
		}),
	).toEqual({
		ok: false,
		error: {
			line: 2,
			column: expect.any(Number),
			message: expect.stringContaining('Unexpected token'),
		},
	})
	expect(
		collectStaticKodyPackageImportsFromFiles({
			'src/app.ts': genericArrowWithImports,
		}).map((entry) => entry.specifier),
	).toEqual(['kody:@kentcdodds/helper/run'])
})
