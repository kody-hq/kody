import { expect, test } from 'vitest'
import { packageAppHostUrlsCodemod } from './0020-package-app-host-urls.ts'

const appManifest = JSON.stringify({
	name: '@alice/notes',
	kody: { app: { entry: './src/app.ts' } },
})
const context = { packageName: '@alice/notes' }

test('0020 rewrites full https URLs of the package’s own app, both path forms', async () => {
	const files = {
		'package.json': appManifest,
		'src/links.ts': [
			"export const home = 'https://alice.kody.run/notes'",
			"export const page = 'https://alice.kody.run/notes/admin/?tab=1#top'",
			"export const legacy = 'https://alice.kody.run/packages/notes/api'",
			'',
		].join('\n'),
		'README.md': 'Open https://alice.kody.run/notes/.\n',
	}

	const result = await packageAppHostUrlsCodemod.transform(files, context)
	expect(result.changedPaths).toEqual(['README.md', 'src/links.ts'])
	expect(result.files['src/links.ts']).toBe(
		[
			"export const home = 'https://notes--alice.kody.run'",
			"export const page = 'https://notes--alice.kody.run/admin/?tab=1#top'",
			"export const legacy = 'https://notes--alice.kody.run/api'",
			'',
		].join('\n'),
	)
	expect(result.files['README.md']).toBe(
		'Open https://notes--alice.kody.run/.\n',
	)
	expect(result.needsManual).toEqual([])

	const again = await packageAppHostUrlsCodemod.transform(result.files, context)
	expect(again.changed).toBe(false)
	expect(await packageAppHostUrlsCodemod.detect(result.files, context)).toEqual(
		[],
	)
})

test('0020 leaves other apps, other owners, and longer leaves alone', async () => {
	const files = {
		'package.json': appManifest,
		'src/links.ts': [
			"const sibling = 'https://alice.kody.run/podium/aie'",
			"const other = 'https://bob.kody.run/notes'",
			"const longer = 'https://alice.kody.run/notes-archive'",
			'const fallback = `https://alice.kody.run${appBasePath}`',
			'',
		].join('\n'),
	}
	const result = await packageAppHostUrlsCodemod.transform(files, context)
	expect(result.changed).toBe(false)
	expect(result.needsManual).toEqual([])
})

test('0020 does not rewrite a file that compares origins', async () => {
	const files = {
		'package.json': appManifest,
		'src/guard.ts': [
			"const app = 'https://alice.kody.run/notes'",
			'if (new URL(request.url).origin !== new URL(app).origin) throw new Error()',
			'',
		].join('\n'),
	}
	const result = await packageAppHostUrlsCodemod.transform(files, context)
	expect(result.changed).toBe(false)
	expect(result.files['src/guard.ts']).toBe(files['src/guard.ts'])
	expect(result.needsManual).toEqual([
		{ path: 'src/guard.ts', message: expect.stringContaining('by hand') },
	])
})

test('0020 flags scheme-less and http mentions it leaves behind', async () => {
	const files = {
		'package.json': appManifest,
		'src/label.ts': [
			"const href = 'https://alice.kody.run/notes'",
			"const label = 'alice.kody.run/notes'",
			'',
		].join('\n'),
	}
	const result = await packageAppHostUrlsCodemod.transform(files, context)
	expect(result.files['src/label.ts']).toBe(
		[
			"const href = 'https://notes--alice.kody.run'",
			"const label = 'alice.kody.run/notes'",
			'',
		].join('\n'),
	)
	expect(result.needsManual).toEqual([
		{ path: 'src/label.ts', message: expect.stringContaining('without https') },
	])
})

test('0020 skips packages with no app, profile packages, and names with no valid host label', async () => {
	const source = {
		'src/a.ts': [
			"const a = 'https://alice.kody.run/notes'",
			"const b = 'https://alice.kody.run/alice'",
			"const c = 'https://alice.kody.run/xn'",
			'',
		].join('\n'),
	}
	const noApp = await packageAppHostUrlsCodemod.transform(
		{ 'package.json': JSON.stringify({ name: '@alice/notes' }), ...source },
		context,
	)
	expect(noApp.changed).toBe(false)
	for (const packageName of ['@alice/alice', '@alice/xn']) {
		const result = await packageAppHostUrlsCodemod.transform(
			{
				'package.json': JSON.stringify({
					name: packageName,
					kody: { app: { entry: './src/app.ts' } },
				}),
				...source,
			},
			{ packageName },
		)
		expect(result.changed).toBe(false)
		expect(result.needsManual).toEqual([])
	}
})
