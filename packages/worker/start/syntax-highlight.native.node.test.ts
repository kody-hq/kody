import { jsx } from 'react/jsx-runtime'
import { renderStartPage } from './test-support/render-start-page.ts'
import { type ReactNode } from 'react'
const renderToString = (page: ReactNode) => renderStartPage(page, '/docs')
import { expect, test } from 'vitest'
import { plainHighlightedCode } from '#universal/highlighted-code.ts'
import { renderHighlightedCode } from './components/syntax-highlight.tsx'

test('paints token styles and escapes content', async () => {
	const html = await renderToString(
		jsx('div', {
			children: renderHighlightedCode({
				code: 'const secret = "<script>"',
				lang: 'typescript',
				plain: false,
				fg: '#24292e;--shiki-dark:#e6edf3',
				bg: '#fff;--shiki-dark:#0d1117',
				lines: [
					[
						{
							content: 'const',
							style: { color: '#d73a49', '--shiki-dark': '#ff7b72' },
						},
						{ content: ' secret = "' },
						{ content: '<script>', style: { color: '#032f62' } },
						{ content: '"' },
					],
				],
			}),
		}),
	)
	expect(html).toContain('class="shiki')
	expect(html).toContain('--shiki-dark:')
	expect(html).toContain('const')
	expect(html).toContain('&lt;script&gt;')
	expect(html).not.toContain('<script>')
})

test('plain payloads keep escaped text in the same wrapper', async () => {
	const html = await renderToString(
		jsx('div', {
			children: renderHighlightedCode(
				plainHighlightedCode('const x = 1', 'ts'),
			),
		}),
	)
	expect(html).toContain('class="shiki')
	expect(html).toContain('const x = 1')
	expect(html).not.toContain('--shiki-dark:')
})
