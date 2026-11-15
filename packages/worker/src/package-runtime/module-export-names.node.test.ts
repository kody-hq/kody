import { expect, test } from 'vitest'
import {
	collectModuleExportNames,
	moduleSourceDeclaresDefaultExport,
} from './module-export-names.ts'

test('collects value exports across declarations, re-exports, and artifact JS', async () => {
	expect(
		await collectModuleExportNames({
			files: {
				'pkg/index.ts': [
					'export function add(left: number, right: number) { return left + right }',
					'export async function fetchStuff() {}',
					'export class Toolbox {}',
					'export const answer = 42',
					'export const { first, rest: [second] } = { first: 1, rest: [2] }',
					'export const [third, ...others] = [3, 4]',
					'const hidden = () => {}',
					'export { hidden as renamed }',
					'export default function main() {}',
					'export type Loud = string',
					'export interface Config { value: number }',
					'export declare function ghost(): void',
					'export type { AnotherType } from "./types.ts"',
					'type Local = number',
					'export { type Local, realValue } from "./values.ts"',
					'export function real() {}',
				].join('\n'),
				'pkg/values.ts': 'export const realValue = 1',
			},
			modulePath: 'pkg/index.ts',
		}),
	).toEqual([
		'Toolbox',
		'add',
		'answer',
		'fetchStuff',
		'first',
		'others',
		'real',
		'realValue',
		'renamed',
		'second',
		'third',
	])

	// Shape of esbuild output for a published importable-module artifact.
	expect(
		await collectModuleExportNames({
			files: {
				'artifact/index.js': [
					'var entry_default = async function main() {}',
					'function listItems() {}',
					'export { entry_default as default, listItems }',
				].join('\n'),
			},
			modulePath: 'artifact/index.js',
		}),
	).toEqual(['listItems'])
})

test('follows export-star chains and tolerates cycles and parse failures', async () => {
	expect(
		await collectModuleExportNames({
			files: {
				'pkg/index.ts': [
					"export * from './math.ts'",
					"export * from './extensionless'",
					"export * as helpers from './helpers.ts'",
					"export * from 'some-npm-package'",
					'export const local = 1',
				].join('\n'),
				'pkg/math.ts':
					"export function multiply() {}\nexport * from './deep/nested.ts'",
				'pkg/deep/nested.ts': 'export const nestedValue = 2',
				'pkg/extensionless.ts': 'export const extensionless = 3',
				'pkg/helpers.ts': 'export const shouldStayHidden = 4',
			},
			modulePath: 'pkg/index.ts',
		}),
	).toEqual(['extensionless', 'helpers', 'local', 'multiply', 'nestedValue'])

	expect(
		await collectModuleExportNames({
			files: {
				'pkg/a.ts': [
					"export * from './b.ts'",
					'const value = 1',
					'export { value as "not an identifier" }',
					'export { value as default }',
				].join('\n'),
				'pkg/b.ts': "export * from './a.ts'\nexport const fromB = 2",
			},
			modulePath: 'pkg/a.ts',
		}),
	).toEqual(['fromB'])

	expect(
		await collectModuleExportNames({
			files: { 'pkg/broken.ts': 'export const = not parseable {{{' },
			modulePath: 'pkg/broken.ts',
		}),
	).toEqual([])
	expect(
		await collectModuleExportNames({
			files: {},
			modulePath: 'pkg/missing.ts',
		}),
	).toEqual([])
})

test('detects runtime default exports and leaves unparseable sources to the bundler', async () => {
	for (const source of [
		'export default function run() {}',
		'export default async () => ({ ok: true })',
		'export default class Tool {}',
		'const value = 1\nexport default value',
		'const run = () => {}\nexport { run as default }',
		"export { default } from './impl.ts'",
		"export { run as default } from './impl.ts'",
		"export * as default from './impl.ts'",
		"import run from './impl.ts'\nexport { run as default }",
		'interface Tool { name: string }\nconst Tool = { name: "tool" }\nexport { Tool as default }',
		'export default function run() {}\nexport function double(value: number) { return value * 2 }',
	]) {
		expect({
			source,
			declaresDefault: await moduleSourceDeclaresDefaultExport(source),
		}).toEqual({ source, declaresDefault: true })
	}
	for (const source of [
		'export function double(value: number) { return value * 2 }',
		'export const answer = 42\nexport class Tool {}',
		"export * from './impl.ts'",
		'export default interface Config { value: number }\nexport const value = 1',
		'type Local = { value: number }\nexport type { Local as default }',
		'interface Shape { value: number }\nexport { Shape as default }\nexport function double(value: number) { return value * 2 }',
		"import type { Shape } from './shape.ts'\nexport { Shape as default }",
		"import { type Shape } from './shape.ts'\nexport { Shape as default }",
		'declare const ambient: number\nexport { ambient as default }',
		'export {}',
		'',
	]) {
		expect({
			source,
			declaresDefault: await moduleSourceDeclaresDefaultExport(source),
		}).toEqual({ source, declaresDefault: false })
	}
	expect(
		await moduleSourceDeclaresDefaultExport('export const = not parseable {{{'),
	).toBeNull()
})
