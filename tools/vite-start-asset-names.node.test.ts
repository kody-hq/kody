import { expect, test } from 'vitest'
import { startChunkFileNames } from './vite-start-asset-names.ts'

test.each([
	'_app.@{$username}',
	'_app.@{$orgSlug}_.-.credentials',
	'docs.$slug',
	'entry',
])('route chunk %s has no URL-escaped filename characters', (name) => {
	const pattern = startChunkFileNames({ name })
	const emitted = pattern.replace('[hash]', 'abc123')
	expect(new URL(emitted, 'https://example.com/').pathname).toBe(
		'/' + encodeURI(emitted),
	)
	expect(emitted).toMatch(/^assets\/[a-zA-Z0-9._-]+\.js$/)
	expect(encodeURIComponent(emitted.split('/').at(-1)!)).toBe(
		emitted.split('/').at(-1),
	)
})
