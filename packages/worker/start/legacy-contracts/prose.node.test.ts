import { jsx, jsxs } from '@emotion/react/jsx-runtime'
import { renderStartPage as renderToString } from '../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { proseCss } from '#universal/styles/style-primitives.ts'

test('prose lists wrap long inline code instead of stretching past the viewport', async () => {
	const html = await renderToString(
		jsx('div', {
			css: proseCss,
			children: jsx('ol', {
				children: jsx('li', {
					children: jsx('code', {
						children: 'https://www.googleapis.com/auth/gmail.compose',
					}),
				}),
			}),
		}),
	)

	expect(html).toContain('overflow-wrap:anywhere')
	expect(html).toContain('min-width:0')
	expect(html).toContain('white-space:pre')
	expect(html).toContain('overflow-wrap:normal')
})

test('prose tables keep column layout instead of wrapping the last cell to a sliver', async () => {
	const html = await renderToString(
		jsx('div', {
			css: proseCss,
			children: 'x',
		}),
	)

	expect(html).toContain('display:table')
	expect(html).toContain('[data-markdown-table-compact-last]')
})

test('prose headings with ids expose permalink anchors and scroll margin', async () => {
	const html = await renderToString(
		jsx('div', {
			css: proseCss,
			children: jsxs('h2', {
				id: 'example',
				'aria-label': 'Example section',
				children: [
					jsx('a', {
						href: '#example',
						'data-heading-permalink': '',
						'aria-label': 'Link to this section',
						children: jsx('span', {
							'data-heading-anchor': '',
							'aria-hidden': 'true',
							children: 'link',
						}),
					}),
					jsx('span', {
						'data-heading-text': '',
						children: 'Example section',
					}),
				],
			}),
		}),
	)

	expect(html).toContain('scroll-margin-top:5.5rem')
	expect(html).toContain('[data-heading-permalink]')
	expect(html).toContain('[data-heading-anchor]')
	expect(html).toContain('position:absolute')
	expect(html).toContain('opacity:0')
	expect(html).toContain('h2[id]')
	expect(html).not.toContain('h1[id]')
})
