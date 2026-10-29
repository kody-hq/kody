import { expect, test } from 'vitest'
import { tokenizeSnippet, tokenizeSnippets } from './tokenize.ts'

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

test('highlighting preserves source text across lines, aliases, and embedded languages', () => {
	for (const lang of [
		'ts',
		'typescript',
		'js',
		'javascript',
		'jsx',
		'tsx',
		'bash',
		'shellscript',
		'dotenv',
		'xml',
		'yaml',
		'json',
		'python',
		'rust',
		'go',
	]) {
		const code = 'const text = "<&>"\n\n// next line\n'
		const result = tokenizeSnippet({ code, lang })
		expect(result.plain, lang).toBe(false)
		expect(
			result.lines
				.map((line) => line.map((span) => span.content).join(''))
				.join('\n'),
			lang,
		).toBe(code)
	}
	const html = tokenizeSnippet({
		code: '<script>const value = 42</script>',
		lang: 'html',
	})
	expect(
		html.lines
			.flat()
			.some((span) => span.content.includes('const') && span.style),
	).toBe(true)
})

test('prototype-like language names stay plain without aborting the batch', () => {
	const snippets = ['constructor', 'toString', '__proto__'].map((lang) => ({
		code: 'const value = 42',
		lang,
	}))
	const results = tokenizeSnippets([
		...snippets,
		{ code: 'const value = 42', lang: 'ts' },
	])
	expect(results.slice(0, 3)).toEqual(
		snippets.map((snippet) => ({ ...snippet, plain: true, lines: [] })),
	)
	expect(results[3]?.plain).toBe(false)
})
