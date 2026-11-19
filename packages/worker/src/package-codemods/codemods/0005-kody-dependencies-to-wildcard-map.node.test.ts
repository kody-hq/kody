import { expect, test } from 'vitest'
import { kodyDependenciesToWildcardMapCodemod } from './0005-kody-dependencies-to-wildcard-map.ts'

function manifest(kodyExtra: Record<string, unknown> = {}) {
	return `${JSON.stringify(
		{
			name: '@user/demo',
			exports: { '.': './index.ts' },
			kody: {
				id: 'demo',
				description: 'Demo package for kody.dependencies map codemod tests.',
				...kodyExtra,
			},
		},
		null,
		'\t',
	)}\n`
}

test('0005 rewrites array and latest-alias maps to name-to-* and is idempotent', async () => {
	const arrayFiles = {
		'package.json': manifest({
			dependencies: ['@user/helper', '@other/lib'],
		}),
		'index.ts': 'export const ready = true\n',
	}
	const arrayDetect =
		await kodyDependenciesToWildcardMapCodemod.detect(arrayFiles)
	expect(arrayDetect).toEqual([
		{
			path: 'package.json',
			message: expect.stringContaining('array-shaped'),
		},
	])
	const arrayTransform =
		await kodyDependenciesToWildcardMapCodemod.transform(arrayFiles)
	expect(arrayTransform.changed).toBe(true)
	expect(arrayTransform.changedPaths).toEqual(['package.json'])
	expect(arrayTransform.needsManual).toEqual([])
	expect(
		JSON.parse(arrayTransform.files['package.json']!).kody.dependencies,
	).toEqual({
		'@other/lib': '*',
		'@user/helper': '*',
	})
	expect(arrayTransform.files['index.ts']).toBe(arrayFiles['index.ts'])

	const secondPass = await kodyDependenciesToWildcardMapCodemod.transform(
		arrayTransform.files,
	)
	expect(secondPass.changed).toBe(false)
	expect(secondPass.files['package.json']).toBe(
		arrayTransform.files['package.json'],
	)
	expect(
		await kodyDependenciesToWildcardMapCodemod.detect(arrayTransform.files),
	).toEqual([])

	const aliasFiles = {
		'package.json': manifest({
			dependencies: {
				'@user/helper': 'latest',
				'@other/lib': '*',
			},
		}),
	}
	const aliasDetect =
		await kodyDependenciesToWildcardMapCodemod.detect(aliasFiles)
	expect(aliasDetect).toEqual([
		{
			path: 'package.json',
			message: expect.stringContaining('normalizes to "*"'),
		},
	])
	const aliasTransform =
		await kodyDependenciesToWildcardMapCodemod.transform(aliasFiles)
	expect(aliasTransform.changed).toBe(true)
	expect(
		JSON.parse(aliasTransform.files['package.json']!).kody.dependencies,
	).toEqual({
		'@other/lib': '*',
		'@user/helper': '*',
	})

	const emptyArray = {
		'package.json': manifest({ dependencies: [] }),
	}
	const emptyTransform =
		await kodyDependenciesToWildcardMapCodemod.transform(emptyArray)
	expect(emptyTransform.changed).toBe(true)
	expect(
		JSON.parse(emptyTransform.files['package.json']!).kody.dependencies,
	).toEqual({})

	const alreadyMigrated = {
		'package.json': manifest({
			dependencies: { '@user/helper': '*' },
		}),
	}
	expect(
		await kodyDependenciesToWildcardMapCodemod.detect(alreadyMigrated),
	).toEqual([])
	expect(
		await kodyDependenciesToWildcardMapCodemod.transform(alreadyMigrated)
			.changed,
	).toBe(false)
})

test('0005 leaves unsupported shapes for manual review and skips missing manifests', async () => {
	const semverFiles = {
		'package.json': manifest({
			dependencies: { '@user/helper': '^1.2.3' },
		}),
	}
	expect(
		await kodyDependenciesToWildcardMapCodemod.detect(semverFiles),
	).toEqual([
		{
			path: 'package.json',
			message: expect.stringContaining('review and update manually'),
		},
	])
	const semverTransform =
		await kodyDependenciesToWildcardMapCodemod.transform(semverFiles)
	expect(semverTransform.changed).toBe(false)
	expect(semverTransform.files['package.json']).toBe(
		semverFiles['package.json'],
	)
	expect(semverTransform.needsManual).toEqual([
		{
			path: 'package.json',
			message: expect.stringContaining('review and update manually'),
		},
	])

	const invalidName = {
		'package.json': manifest({
			dependencies: ['helper', '@user/ok'],
		}),
	}
	const invalidNameTransform =
		await kodyDependenciesToWildcardMapCodemod.transform(invalidName)
	expect(invalidNameTransform.changed).toBe(false)
	expect(invalidNameTransform.needsManual).toEqual([
		{
			path: 'package.json',
			message: expect.stringContaining('not scoped package names'),
		},
	])

	const noManifest = {
		'index.ts': 'export const ready = true\n',
	}
	expect(await kodyDependenciesToWildcardMapCodemod.detect(noManifest)).toEqual(
		[
			{
				path: 'package.json',
				message: expect.stringContaining('missing or not valid JSON'),
			},
		],
	)

	const noKody = {
		'package.json': `${JSON.stringify({ name: '@user/demo' }, null, '\t')}\n`,
	}
	expect(await kodyDependenciesToWildcardMapCodemod.detect(noKody)).toEqual([])
	expect(
		await kodyDependenciesToWildcardMapCodemod.transform(noKody).changed,
	).toBe(false)
})
