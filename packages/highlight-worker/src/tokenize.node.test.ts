import { expect, test } from 'vitest'
import { tokenizeSnippet } from './tokenize.ts'

test('tokenizes known languages with dual-theme styles', () => {
	const ts = tokenizeSnippet({ code: 'const secret = "<script>"', lang: 'ts' })
	expect(ts.plain).toBe(false)
	expect(ts.lang).toBe('ts')
	expect(ts.code).toContain('<script>')
	const styles = ts.lines
		.flat()
		.flatMap((span) => Object.values(span.style ?? {}))
	expect(
		styles.some((value) => value.includes('#') || value.startsWith('var')),
	).toBe(true)

	const json = tokenizeSnippet({ code: '{"ok": true}', lang: 'json' })
	expect(json.plain).toBe(false)
	expect(json.lines.flat().some((span) => span.content.includes('ok'))).toBe(
		true,
	)
})

test('unknown languages and oversized snippets stay plaintext', () => {
	const unknown = tokenizeSnippet({ code: 'SELECT 1', lang: 'not-a-real-lang' })
	expect(unknown).toEqual({
		code: 'SELECT 1',
		lang: 'not-a-real-lang',
		plain: true,
		lines: [],
	})

	const huge = tokenizeSnippet({
		code: 'x'.repeat(50_001),
		lang: 'ts',
	})
	expect(huge.plain).toBe(true)
	expect(huge.lines).toEqual([])
})
