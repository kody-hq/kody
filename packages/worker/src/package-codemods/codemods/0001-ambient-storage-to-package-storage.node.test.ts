import { expect, test } from 'vitest'
import { ambientStorageToPackageStorageCodemod as codemod } from './0001-ambient-storage-to-package-storage.ts'

function manifest(kodyId: string, app?: { entry: string }) {
	return `${JSON.stringify(
		{
			name: `@user/${kodyId}`,
			exports: { '.': './index.ts' },
			kody: {
				id: kodyId,
				description: 'Demo package for ambient storage codemod tests.',
				...(app ? { app } : {}),
			},
		},
		null,
		'\t',
	)}\n`
}

const importStorage = "import { storage } from 'kody:runtime'\n"

test('0001 rewrites member call sites, gates apps, verifies AST, and handles parse failures', async () => {
	const plain = {
		'package.json': manifest('demo'),
		'index.ts': `${importStorage}\nexport async function run() {\n\treturn storage.get('k')\n}\n`,
	}
	expect(await codemod.detect(plain)).toEqual([
		{
			path: 'index.ts',
			message: expect.stringContaining('ambient `storage`'),
		},
	])
	const plainTransform = await codemod.transform(plain)
	expect(plainTransform).toMatchObject({
		changed: true,
		changedPaths: ['index.ts'],
		needsManual: [],
	})
	const plainOutput = plainTransform.files['index.ts']
	expect(plainOutput).toContain("import { packageStorage } from 'kody:runtime'")
	expect(plainOutput).toContain("packageStorage().get('k')")
	expect(plainOutput).not.toContain('const storage = packageStorage()')
	expect(plainOutput).not.toMatch(/(?<!package)storage\.get/)
	const secondPass = await codemod.transform(plainTransform.files)
	expect(secondPass.changed).toBe(false)
	expect(secondPass.files['index.ts']).toBe(plainOutput)

	const rewrites: Array<{
		kodyId: string
		source: string
		contains: Array<string>
		excludes?: RegExp
	}> = [
		{
			kodyId: 'mixed',
			source:
				"import { kody, storage, packages } from 'kody:runtime'\nexport const value = storage.sql`select 1`\nexport const other = kody\nexport const pack = packages\n",
			contains: ['packageStorage().sql', 'kody', 'packages'],
			excludes: /import\s*\{[^}]*\bstorage\b/,
		},
		{
			kodyId: 'comment',
			source: `${importStorage}// const storage = packageStorage()\nexport const run = () => storage.get('k')\n`,
			contains: [
				"packageStorage().get('k')",
				'// const storage = packageStorage()',
			],
		},
		{
			kodyId: 'string',
			source: `${importStorage}const note = 'const storage = packageStorage()'\nexport const run = () => storage.get('k')\n`,
			contains: [
				"packageStorage().get('k')",
				"'const storage = packageStorage()'",
			],
		},
	]
	for (const { kodyId, source, contains, excludes } of rewrites) {
		const result = await codemod.transform({
			'package.json': manifest(kodyId),
			'lib.ts': source,
		})
		const output = result.files['lib.ts'] ?? ''
		expect({
			kodyId,
			changed: result.changed,
			missing: contains.filter((snippet) => !output.includes(snippet)),
		}).toEqual({ kodyId, changed: true, missing: [] })
		if (excludes) expect(output).not.toMatch(excludes)
	}

	const manual: Array<{
		kodyId: string
		source: string
		message: RegExp
		app?: { entry: string }
	}> = [
		{
			kodyId: 'alias',
			source:
				"import { storage as packageBucket } from 'kody:runtime'\nexport const value = packageBucket.get('k')\n",
			message: /alias/,
		},
		{
			kodyId: 'value',
			source: `${importStorage}export function wrap(helper) {\n\treturn helper(storage)\n}\n`,
			message: /member-expression/i,
		},
		{
			kodyId: 'app',
			source: `${importStorage}export const run = () => storage.get('k')\n`,
			message: /bucket identities/,
			app: { entry: './app.ts' },
		},
		{
			kodyId: 'bad',
			source: `${importStorage}export function broken( {\n`,
			message: /could not be parsed/,
		},
	]
	for (const { kodyId, source, message, app } of manual) {
		const files = { 'package.json': manifest(kodyId, app), 'lib.ts': source }
		const result = await codemod.transform(files)
		expect({ kodyId, ...result }).toMatchObject({
			kodyId,
			changed: false,
			files,
			needsManual: [
				{ path: 'lib.ts', message: expect.stringMatching(message) },
			],
		})
	}
	expect(
		await codemod.detect({
			'package.json': manifest('bad'),
			'bad.ts': `${importStorage}export function broken( {\n`,
		}),
	).toEqual([
		{ path: 'bad.ts', message: expect.stringContaining('could not be parsed') },
	])

	const clean = {
		'package.json': manifest('clean'),
		'clean.ts':
			"import { packageStorage } from 'kody:runtime'\nexport const run = () => packageStorage().get('k')\n",
	}
	expect(await codemod.detect(clean)).toEqual([])
	expect((await codemod.transform(clean)).changed).toBe(false)
})
