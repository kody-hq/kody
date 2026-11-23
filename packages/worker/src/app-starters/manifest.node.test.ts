import { expect, test } from 'vitest'
import { validateAppStarterManifest } from './manifest.ts'

const validStarter = {
	name: 'App starter',
	description: 'A basic app with sign-in and storage wired up.',
	whenToUse: 'Recommend this for most new apps.',
	tags: ['app'],
	preview: 'public/starter-preview.png',
	capabilities: ['sign-in', 'storage'],
	customize: {
		themeTokens: 'src/styles/tokens.css',
		routes: 'src/routes',
		content: 'src/content',
	},
}

test('a complete kody.starter manifest validates', () => {
	expect(
		validateAppStarterManifest({ kody: { starter: validStarter } }),
	).toEqual({ ok: true, starter: validStarter })
})

test('a missing kody.starter names the key', () => {
	expect(validateAppStarterManifest({ kody: {} })).toEqual({
		ok: false,
		fieldErrors: [
			{ field: 'kody.starter', message: 'Add a kody.starter object.' },
		],
	})
})

test('invalid fields are each named', () => {
	const result = validateAppStarterManifest({
		kody: {
			starter: {
				...validStarter,
				whenToUse: undefined,
				preview: 'https://example.com/shot.png',
				customize: { themeTokens: '../tokens.css', routes: 'src/routes' },
				extra: true,
			},
		},
	})
	expect(result.ok).toBe(false)
	if (result.ok) return
	expect(result.fieldErrors.map((error) => error.field).sort()).toEqual([
		'kody.starter.customize.content',
		'kody.starter.customize.themeTokens',
		'kody.starter.extra',
		'kody.starter.preview',
		'kody.starter.whenToUse',
	])
})
