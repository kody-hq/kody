import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

let script: string
test.beforeAll(async () => {
	const result = await build({
		stdin: {
			contents: `import React from 'react';import{createRoot}from'react-dom/client';import{WorkspacePageEditor}from'./packages/worker/start/pages/workspace-page-editor.tsx';import Markdown from'./packages/worker/start/pages/file-viewers/markdown-file-viewer.tsx';import{workspaceMarkdownCss}from'./packages/worker/start/pages/workspace-prose.ts';const blocks=[{kind:'heading',text:'Shared heading'},{kind:'paragraph',text:'Shared paragraph.'},{kind:'quote',text:'Shared quote.'},{kind:'code',text:'const shared = true'}].map((block,i)=>({...block,id:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0')}));createRoot(document.getElementById('root')).render(<><section data-testid="page"><WorkspacePageEditor content={JSON.stringify({version:1,blocks})} files={[]} renderFile={()=>null}/></section><article css={workspaceMarkdownCss}><Markdown content={'# Shared heading\\n\\nShared paragraph.\\n\\n> Shared quote.\\n\\n~~~\\nconst shared = true\\n~~~'}/></article></>);`,
			loader: 'tsx',
			resolveDir: process.cwd(),
		},
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
		jsx: 'automatic',
		jsxImportSource: '@emotion/react',
		alias: { '#universal': resolve('packages/worker/universal') },
		define: { 'process.env.NODE_ENV': '"production"' },
	})
	script = result.outputFiles[0]!.text
})
test('equivalent Markdown and page blocks share typography and geometry', async ({
	page,
}) => {
	await page.route('https://prose.test/**', (route) =>
		route.fulfill({
			contentType: 'text/html',
			body: `<html><head><style>body{font:16px system-ui}section,article{width:840px}p{margin:1em 0}h2{font:700 1.5em serif}</style></head><body><div id="root"></div><script>${script}</script></body></html>`,
		}),
	)
	await page.goto('https://prose.test/')
	await expect(page.locator('article h2')).toBeVisible()
	const blocks = [
		['heading', 'h2'],
		['paragraph', 'article > p'],
		['quote', 'blockquote'],
		['code', 'pre'],
	]
	for (const [kind, selector] of blocks) {
		const values = await page
			.locator(
				`[data-kind="${kind}"] .block-text, ${selector === 'h2' ? 'article h2' : selector}`,
			)
			.evaluateAll((elements) =>
				elements.map((element) => {
					const style = getComputedStyle(element)
					return {
						font: style.fontSize,
						weight: style.fontWeight,
						family: style.fontFamily,
						line: style.lineHeight,
						height: element.getBoundingClientRect().height,
						border: style.borderInlineStartWidth,
					}
				}),
			)
		expect(values, kind).toHaveLength(2)
		expect(values[0], kind).toEqual(values[1])
	}
})
