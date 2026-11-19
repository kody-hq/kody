import { expect, test } from 'vitest'
import { ownerScopeFollowsRegistryCodemod } from './0011-owner-scope-follows-registry.ts'

const context = { packageName: '@team/alpha' }

function manifest(name: string) {
	return `${JSON.stringify({ name, kody: { dependencies: { '@personal/*': '*' } } }, null, '\t')}\n`
}

const movedFiles = {
	'package.json': manifest('@personal/alpha'),
	'src/index.ts': [
		"import { beta } from 'kody:@personal/beta'",
		"import { gamma } from 'kody:@personal/gamma/src/util.ts'",
		"import { other } from 'kody:@personalish/delta'",
		"const handle = '@personal'",
		"const email = 'me@personal.example'",
		'',
	].join('\n'),
	'README.md': 'Install `@personal/alpha`.\n',
	'notes.txt': 'Nothing scoped here.\n',
}

test('0011 rewrites every @oldScope/ reference to the registry scope', async () => {
	const result = await ownerScopeFollowsRegistryCodemod.transform(
		movedFiles,
		context,
	)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual([
		'package.json',
		'README.md',
		'src/index.ts',
	])
	expect(JSON.parse(result.files['package.json']!)).toEqual({
		name: '@team/alpha',
		kody: { dependencies: { '@team/*': '*' } },
	})
	expect(result.files['src/index.ts']).toBe(
		[
			"import { beta } from 'kody:@team/beta'",
			"import { gamma } from 'kody:@team/gamma/src/util.ts'",
			"import { other } from 'kody:@personalish/delta'",
			"const handle = '@personal'",
			"const email = 'me@personal.example'",
			'',
		].join('\n'),
	)
	expect(result.files['README.md']).toBe('Install `@team/alpha`.\n')
	expect(result.files['notes.txt']).toBe(movedFiles['notes.txt'])
	expect(result.needsManual).toEqual([])

	const again = await ownerScopeFollowsRegistryCodemod.transform(
		result.files,
		context,
	)
	expect(again.changed).toBe(false)
	expect(again.changedPaths).toEqual([])
})

test('0011 detect reports each file holding the old scope', async () => {
	expect(
		await ownerScopeFollowsRegistryCodemod.detect(movedFiles, context),
	).toEqual(
		['package.json', 'README.md', 'src/index.ts'].map((path) => ({
			path,
			message: expect.stringContaining('@personal/; rewrite to @team/'),
		})),
	)
})

test('0011 leaves packages alone when the scope already matches or is unknown', async () => {
	const cases: Array<Record<string, string>> = [
		{
			'package.json': manifest('@team/alpha'),
			'a.ts': "import 'kody:@team/b'",
		},
		{ 'package.json': manifest('alpha'), 'a.ts': "import 'kody:@personal/b'" },
		{ 'package.json': '{ not json', 'a.ts': "import 'kody:@personal/b'" },
		{ 'a.ts': "import 'kody:@personal/b'" },
	]
	for (const files of cases) {
		expect(
			await ownerScopeFollowsRegistryCodemod.detect(files, context),
		).toEqual([])
		const result = await ownerScopeFollowsRegistryCodemod.transform(
			files,
			context,
		)
		expect(result.changed).toBe(false)
		expect(result.files).toEqual(files)
	}
})
