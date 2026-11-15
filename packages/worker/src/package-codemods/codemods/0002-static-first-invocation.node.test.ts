import { expect, test } from 'vitest'
import { staticFirstInvocationCodemod as codemod } from './0002-static-first-invocation.ts'

const packageContext = { packageName: '@user/demo' }

const manifest = `${JSON.stringify(
	{
		name: '@user/demo',
		exports: { '.': './index.ts' },
		kody: {
			id: 'demo',
			description: 'Demo package for static-first invocation codemod tests.',
		},
	},
	null,
	'\t',
)}\n`

function source(...lines: Array<string>) {
	return [...lines, ''].join('\n')
}

function manual(path: string, snippet: string) {
	return { path, message: expect.stringContaining(snippet) }
}

test('0002 rewrites invokeChecked member calls and leaves non-targets alone', async () => {
	const files = {
		'package.json': manifest,
		'index.ts': source(
			"import { packages } from 'kody:runtime'",
			'',
			'export default async function run() {',
			"\tconst direct = await packages.invokeChecked({ kodyId: 'github', exportName: './request', params: {} })",
			"\tconst optional = await packages?.invokeChecked({ kodyId: 'github', exportName: './request', params: {} })",
			'\treturn { direct, optional }',
			'}',
		),
	}

	expect(await codemod.detect(files, packageContext)).toEqual([
		manual('index.ts', '`packages.invokeChecked`'),
	])
	const result = await codemod.transform(files, packageContext)
	expect(result).toMatchObject({
		changed: true,
		changedPaths: ['index.ts'],
		needsManual: [],
	})
	const output = result.files['index.ts']
	expect(output).toContain(
		'await packages.invoke("kody:@user/github", { exportName:',
	)
	expect(output).toContain(
		'await packages?.invoke("kody:@user/github", { exportName:',
	)
	expect(output).not.toContain('invokeChecked')
	expect(output).not.toContain("kodyId: 'github'")
	const rerun = await codemod.transform(result.files, packageContext)
	expect(rerun.changed).toBe(false)
	expect(rerun.files).toEqual(result.files)

	const untouched = {
		'package.json': manifest,
		'README.md':
			'Historical note: `packages.invokeChecked` used to be the recommendation.\n',
		'index.ts': source(
			'const other = { invokeChecked: () => 1 }',
			'export default async function run() {',
			'\treturn other.invokeChecked()',
			'}',
		),
	}
	expect(await codemod.detect(untouched, packageContext)).toEqual([])
	expect(await codemod.transform(untouched, packageContext)).toMatchObject({
		changed: false,
		files: untouched,
	})
})

test('0002 reports needsManual and leaves files unchanged for non-migratable calls', async () => {
	const cases: Array<{
		name: string
		files: Record<string, string>
		needsManual: Array<ReturnType<typeof manual>>
	}> = [
		{
			name: '0006 needs manual repair',
			files: {
				'index.ts': source(
					"import { packages } from 'kody:runtime'",
					'export default async function run(input) {',
					'\treturn packages.invokeChecked(input)',
					'}',
				),
			},
			needsManual: [manual('index.ts', 'cannot be migrated safely')],
		},
		{
			name: 'check and dynamic imports',
			files: {
				'index.ts': source(
					"import { packages } from 'kody:runtime'",
					'',
					'export default async function run() {',
					"\tconst contract = await packages.check({ kodyId: 'github', exportName: './request' })",
					"\tconst dynamicModule = await import('kody:@kentcdodds/github/request')",
					'\treturn { contract, dynamicType: typeof dynamicModule.default }',
					'}',
				),
			},
			needsManual: [
				manual('index.ts', 'literal dynamic `import("kody:@...")`'),
				manual('index.ts', '`packages.check`'),
			],
		},
		{
			name: 'parse failure',
			files: {
				'broken.ts': source(
					"import { packages } from 'kody:runtime'",
					'export default async function run( {', // malformed on purpose
					"\treturn await packages.invokeChecked({ kodyId: 'github', exportName: './request' })",
					'}',
				),
			},
			needsManual: [manual('broken.ts', 'could not be parsed')],
		},
	]
	for (const { name, files, needsManual } of cases) {
		const input = { 'package.json': manifest, ...files }
		expect({
			name,
			...(await codemod.transform(input, packageContext)),
		}).toMatchObject({
			name,
			changed: false,
			changedPaths: [],
			files: input,
			needsManual,
		})
	}

	const mixedFiles = {
		'package.json': manifest,
		'auto.ts': source(
			"import { packages } from 'kody:runtime'",
			'export default async function auto() {',
			"\treturn await packages.invokeChecked({ kodyId: 'skills', exportName: './skill-get', params: { id: 'x' } })",
			'}',
		),
		'manual.ts': source(
			"import { packages } from 'kody:runtime'",
			'export default async function manual() {',
			"\treturn await packages.check({ kodyId: 'skills', exportName: './skill-get' })",
			'}',
		),
	}
	const mixedResult = await codemod.transform(mixedFiles, packageContext)
	expect(mixedResult).toMatchObject({
		changed: true,
		changedPaths: ['auto.ts'],
		needsManual: [manual('manual.ts', '`packages.check`')],
	})
	expect(mixedResult.files['auto.ts']).toContain(
		'packages.invoke("kody:@user/skills", { exportName:',
	)
	expect(mixedResult.files['auto.ts']).not.toContain('invokeChecked')
	expect(mixedResult.files['manual.ts']).toBe(mixedFiles['manual.ts'])
})
