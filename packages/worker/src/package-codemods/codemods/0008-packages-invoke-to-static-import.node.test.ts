import { expect, test } from 'vitest'
import { packagesInvokeToStaticImportCodemod as codemod } from './0008-packages-invoke-to-static-import.ts'

function manifest(
	name = '@user/demo',
	dependencies?: Record<string, string> | Array<string>,
) {
	return `${JSON.stringify(
		{
			name,
			exports: { '.': './index.ts' },
			kody: {
				id: 'demo',
				description: 'Demo package for invoke-to-import codemod tests.',
				...(dependencies === undefined ? {} : { dependencies }),
			},
		},
		null,
		'\t',
	)}\n`
}

function missingSnippets(text: string | undefined, snippets: Array<string>) {
	return snippets.filter((snippet) => !text?.includes(snippet))
}

function kodyDependencies(files: Record<string, string>) {
	return JSON.parse(files['package.json']!).kody.dependencies
}

test('0008 rewrites literal invoke to a static import and records kody.dependencies', async () => {
	const files = {
		'package.json': manifest('@kentcdodds/demo'),
		'index.ts': [
			"import { packages } from 'kody:runtime'",
			'',
			'export default async function run(event) {',
			"\tconst direct = await packages.invoke('kody:@kentcdodds/github/request', { params: { event } })",
			"\tconst listed = await packages.invoke('kody:@kentcdodds/inbox/list')",
			'\treturn { direct, listed }',
			'}',
			'',
		].join('\n'),
	}

	expect(await codemod.detect(files)).toEqual([
		{ path: 'index.ts', message: expect.stringContaining('static') },
	])

	const result = await codemod.transform(files)
	expect(result).toMatchObject({
		changed: true,
		changedPaths: ['index.ts', 'package.json'],
		needsManual: [],
	})
	expect(
		missingSnippets(result.files['index.ts'], [
			'import request from "kody:@kentcdodds/github/request"',
			'import list from "kody:@kentcdodds/inbox/list"',
			'await request({ event })',
			'await list()',
		]),
	).toEqual([])
	expect(result.files['index.ts']).not.toContain('packages.invoke')
	expect(result.files['index.ts']).not.toContain("from 'kody:runtime'")
	expect(kodyDependencies(result.files)).toEqual({
		'@kentcdodds/github': '*',
		'@kentcdodds/inbox': '*',
	})

	expect(await codemod.transform(result.files)).toMatchObject({
		changed: false,
		changedPaths: [],
		needsManual: [],
	})
})

test('0008 rewrites computed specifiers to import(specifier) and leaves keyed invokes manual', async () => {
	const files = {
		'package.json': manifest(),
		'dynamic.ts': [
			"import { packages } from 'kody:runtime'",
			'',
			'export default async function run(name, params) {',
			'\treturn await packages.invoke(name, { params })',
			'}',
			'',
		].join('\n'),
		'keyed.ts': [
			"import { packages } from 'kody:runtime'",
			'',
			'export default async function run(event) {',
			"\treturn await packages.invoke('kody:@user/once/run', {",
			'\t\tparams: event,',
			"\t\tidempotencyKey: 'once:1',",
			'\t})',
			'}',
			'',
		].join('\n'),
	}

	const result = await codemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['dynamic.ts'])
	expect(result.files['dynamic.ts']).toContain(
		'return await (await import(name)).default(params)',
	)
	expect(result.files['dynamic.ts']).not.toContain('packages.invoke')
	expect(result.files['keyed.ts']).toBe(files['keyed.ts'])
	expect(result.needsManual).toEqual([
		{ path: 'keyed.ts', message: expect.stringContaining('idempotencyKey') },
	])
})

test('0008 rewrites Markdown fences without recording kody.dependencies from docs', async () => {
	const docsOnly = {
		'package.json': manifest('@docs-owner/demo'),
		'README.md': [
			'# Usage',
			'',
			'```ts',
			"import { packages } from 'kody:runtime'",
			'',
			"const result = await packages.invoke('kody:@docs-owner/github/request', { params: {} })",
			'```',
			'',
			'Call `packages.invoke("kody:@docs-owner/inbox/list", { params: {} })` after install.',
			'',
		].join('\n'),
	}

	const docsResult = await codemod.transform(docsOnly)
	expect(docsResult).toMatchObject({
		changed: true,
		changedPaths: ['README.md'],
		needsManual: [],
	})
	expect(
		missingSnippets(docsResult.files['README.md'], [
			'import request from "kody:@docs-owner/github/request"',
			'await request({})',
			'import list from "kody:@docs-owner/inbox/list"',
		]),
	).toEqual([])
	expect(docsResult.files['README.md']).not.toContain('packages.invoke')
	expect(docsResult.files['package.json']).toBe(docsOnly['package.json'])
	expect(kodyDependencies(docsResult.files)).toBeUndefined()

	const mixed = {
		'package.json': manifest('@user/demo'),
		'index.ts': [
			"import { packages } from 'kody:runtime'",
			'',
			'export default async function run() {',
			"\treturn await packages.invoke('kody:@user/helper/run')",
			'}',
			'',
		].join('\n'),
		'README.md': [
			'# Usage',
			'',
			'```ts',
			"await packages.invoke('kody:@docs-owner/inbox/list')",
			'```',
			'',
		].join('\n'),
	}

	const mixedResult = await codemod.transform(mixed)
	expect(mixedResult.changed).toBe(true)
	expect(mixedResult.changedPaths).toEqual([
		'index.ts',
		'package.json',
		'README.md',
	])
	expect(kodyDependencies(mixedResult.files)).toEqual({ '@user/helper': '*' })
	expect(mixedResult.files['README.md']).toContain(
		'import list from "kody:@docs-owner/inbox/list"',
	)
	expect(mixedResult.files['index.ts']).toContain('kody:@user/helper/run')
	expect(mixedResult.files['index.ts']).not.toContain('packages.invoke')
})

test('0008 reuses an existing static import', async () => {
	const files = {
		'package.json': manifest('@user/demo', { '@user/helper': '*' }),
		'index.ts': [
			"import helper from 'kody:@user/helper/run'",
			"import { packages } from 'kody:runtime'",
			'',
			"export default async function run() { return await packages.invoke('kody:@user/helper/run', { params: { ok: true } }) }",
			'',
		].join('\n'),
	}

	const result = await codemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['index.ts'])
	expect(result.files['index.ts']).toContain('await helper({ ok: true })')
	expect(result.files['index.ts']?.match(/import helper from/g)).toHaveLength(1)
	expect(kodyDependencies(result.files)).toEqual({ '@user/helper': '*' })
})

test('0008 rewrites static template specifiers and keeps other packages uses', async () => {
	const files = {
		'package.json': manifest('@user/demo'),
		'index.ts': [
			"import { storage, packages, secrets } from 'kody:runtime'",
			'',
			'export default async function run() {',
			'\tconst listed = await packages.invoke(`kody:@user/inbox/list`)',
			'\tvoid packages.check',
			'\treturn listed',
			'}',
			'',
		].join('\n'),
	}

	const result = await codemod.transform(files)
	expect(result.changed).toBe(true)
	expect(
		missingSnippets(result.files['index.ts'], [
			'import list from "kody:@user/inbox/list"',
			'await list()',
			"import { storage, packages, secrets } from 'kody:runtime'",
			'void packages.check',
		]),
	).toEqual([])
	expect(result.files['index.ts']).not.toContain('packages.invoke')
})

test('0008 leaves topic invokes manual and removes only unused packages specifiers', async () => {
	const files = {
		'package.json': manifest('@user/demo'),
		'topic.ts': [
			"import { packages } from 'kody:runtime'",
			'',
			'export default async function run() {',
			"\treturn await packages.invoke('kody:@user/inbox/list', { topic: 'mail' })",
			'}',
			'',
		].join('\n'),
		'multi.ts': [
			"import { storage, packages, secrets } from 'kody:runtime'",
			'',
			'export default async function run() {',
			"\treturn await packages.invoke('kody:@user/inbox/list')",
			'}',
			'',
		].join('\n'),
	}

	const result = await codemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['multi.ts', 'package.json'])
	expect(result.files['topic.ts']).toBe(files['topic.ts'])
	expect(result.needsManual).toEqual([
		{ path: 'topic.ts', message: expect.stringContaining('import') },
	])
	expect(result.files['multi.ts']).toContain(
		"import { storage, secrets } from 'kody:runtime'",
	)
	expect(result.files['multi.ts']).not.toMatch(/\{\s*,/)
	expect(result.files['multi.ts']).not.toContain('packages.invoke')
})
