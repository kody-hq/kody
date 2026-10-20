import { expect, test } from 'vitest'
import { shortPackageAppSubdomainPathCodemod } from './0016-short-package-app-subdomain-path.ts'

test('0016 rewrites subdomain /packages mounts and preserves rest/query/hash', () => {
	const files = {
		'index.ts': [
			"const hosted = 'https://alice.kody.run/packages/demo/report?x=1'",
			"const hash = 'https://bob.kody.run/packages/notes#top'",
			"const leaf = 'https://carol.kody.run/packages/counter'",
			'',
		].join('\n'),
		'README.md': 'Open https://alice.kody.run/packages/demo.\n',
	}

	const result = shortPackageAppSubdomainPathCodemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['index.ts', 'README.md'])
	expect(result.files['index.ts']).toBe(
		[
			"const hosted = 'https://alice.kody.run/demo/report?x=1'",
			"const hash = 'https://bob.kody.run/notes#top'",
			"const leaf = 'https://carol.kody.run/counter'",
			'',
		].join('\n'),
	)
	expect(result.files['README.md']).toBe('Open https://alice.kody.run/demo.\n')
	expect(result.needsManual).toEqual([])

	const again = shortPackageAppSubdomainPathCodemod.transform(result.files)
	expect(again.changed).toBe(false)
	expect(again.changedPaths).toEqual([])
})

test('0016 leaves app-origin, Open API, apex, and nested hosts alone', () => {
	const files = {
		'keep.ts': [
			"const appOrigin = 'https://kody.codes/@alice/packages/demo'",
			"const openApi = 'https://kody.codes/v1/packages/pkg_123'",
			"const apex = 'https://kody.run/packages/demo'",
			"const nested = 'https://a.b.kody.run/packages/demo'",
			"const short = 'https://alice.kody.run/demo'",
			'',
		].join('\n'),
		'legacy.ts': "export const url = 'https://bob.kody.run/packages/x'\n",
		'bare.md': 'Mount at /packages/demo on the subdomain.\n',
		'logo.png': 'https://alice.kody.run/packages/demo pretend-binary',
	}

	const result = shortPackageAppSubdomainPathCodemod.transform(files)
	expect(result.changed).toBe(true)
	expect(result.changedPaths).toEqual(['legacy.ts'])
	expect(result.files['keep.ts']).toBe(files['keep.ts'])
	expect(result.files['legacy.ts']).toBe(
		"export const url = 'https://bob.kody.run/x'\n",
	)
	expect(result.files['bare.md']).toBe(files['bare.md'])
	expect(result.files['logo.png']).toBe(files['logo.png'])
	expect(result.needsManual).toEqual(
		expect.arrayContaining([
			{
				path: 'bare.md',
				message: expect.stringContaining('manually'),
			},
		]),
	)

	const findings = shortPackageAppSubdomainPathCodemod.detect(files)
	expect(findings).toEqual(
		expect.arrayContaining([
			{
				path: 'legacy.ts',
				message: expect.stringContaining(
					'rewrite to https://{user}.kody.run/{leaf}',
				),
			},
			{
				path: 'bare.md',
				message: expect.stringContaining('manually'),
			},
		]),
	)
	expect(findings.some((finding) => finding.path === 'logo.png')).toBe(false)
	expect(findings.some((finding) => finding.path === 'keep.ts')).toBe(false)
})

test('0016 detect reports rewrite and bare-mount findings on the same file', () => {
	const files = {
		'mixed.ts': [
			"const hosted = 'https://alice.kody.run/packages/demo'",
			"const bare = '/packages/other'",
			'',
		].join('\n'),
	}
	const findings = shortPackageAppSubdomainPathCodemod.detect(files)
	expect(findings).toEqual(
		expect.arrayContaining([
			{
				path: 'mixed.ts',
				message: expect.stringContaining(
					'rewrite to https://{user}.kody.run/{leaf}',
				),
			},
			{
				path: 'mixed.ts',
				message: expect.stringContaining('manually'),
			},
		]),
	)
	expect(
		findings.filter((finding) => finding.path === 'mixed.ts'),
	).toHaveLength(2)
})
