import { expect, test } from 'vitest'
import { readSharedTokenUsage, sharedAppTokenNames } from './shared-tokens.ts'

test('a theme declaring every shared token for light and dark passes', () => {
	const declarations = sharedAppTokenNames.map((name) => `${name}: 0;`).join('')
	const css = `:root{${declarations}}@media (prefers-color-scheme: dark){:root{--color-bg:#000;}}`
	expect(readSharedTokenUsage(css)).toEqual({ missing: [], hasDark: true })
})

test('missing tokens and a missing dark theme are reported', () => {
	expect(
		readSharedTokenUsage(':root{color-scheme: light dark;--color-bg:#fff;}'),
	).toEqual({
		missing: sharedAppTokenNames.filter((name) => name !== '--color-bg'),
		hasDark: false,
	})
})

test('a class-based dark theme counts as dark', () => {
	expect(
		readSharedTokenUsage(':root{--color-bg:#fff;}.dark{--color-bg:#000;}')
			.hasDark,
	).toBe(true)
})

test('a class that only starts with dark does not count as dark', () => {
	expect(
		readSharedTokenUsage(':root{--color-bg:#fff;}.dark-mode-toggle{color:red;}')
			.hasDark,
	).toBe(false)
})
