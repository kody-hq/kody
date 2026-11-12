import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'

let script: string
test.beforeAll(async () => {
	const result = await build({
		stdin: {
			contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{WorkspacePageEditor}from'./packages/worker/start/pages/workspace-page-editor.tsx';function App(){const[content,setContent]=useState(JSON.stringify({version:1,blocks:[{id:'00000000-0000-4000-8000-000000000001',kind:'heading',text:'Launch checklist'},{id:'00000000-0000-4000-8000-000000000002',kind:'quote',text:'Review with Kent'},{id:'00000000-0000-4000-8000-000000000003',kind:'paragraph',text:'Notes for the team.'}]}));const[readonly,setReadonly]=useState(false);return <><button onClick={()=>setReadonly(!readonly)}>Toggle readonly</button><WorkspacePageEditor content={content} onChange={readonly?undefined:setContent} files={[]} renderFile={()=>null}/><output data-testid="page-json">{content}</output></>}createRoot(document.getElementById('root')).render(<App/>);`,
			resolveDir: process.cwd(),
			loader: 'tsx',
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
test.beforeEach(async ({ page }) => {
	await page.route('https://document.test/**', (route) =>
		route.fulfill(
			new URL(route.request().url()).pathname === '/editor.js'
				? { contentType: 'application/javascript', body: script }
				: {
						contentType: 'text/html',
						body: '<html><head><style>body{font:16px system-ui;padding:60px;max-width:840px}output{display:none}</style></head><body><div id="root"></div><script src="/editor.js"></script></body></html>',
					},
		),
	)
	await page.goto('https://document.test/')
	await expect(
		page.getByRole('textbox', { name: 'Page content' }),
	).toBeVisible()
})
test('native selection, copy, cross-block deletion, and undo preserve a single document', async ({
	page,
	context,
}) => {
	const editor = page.getByRole('textbox', { name: 'Page content' })
	const original = await page.getByTestId('page-json').textContent()
	await editor.click()
	await editor.press('ControlOrMeta+a')
	expect(
		await page.evaluate(() => window.getSelection()?.toString()),
	).toContain('Launch checklist\nReview with Kent\nNotes for the team.')
	await context.grantPermissions(['clipboard-read', 'clipboard-write'])
	await editor.press('ControlOrMeta+c')
	const copied = await page.evaluate(() => navigator.clipboard.readText())
	expect(copied).toContain('Launch checklist')
	expect(copied).toContain('Review with Kent')
	expect(copied).toContain('Notes for the team.')
	expect(copied).not.toContain('⠿')
	const start = await page.locator('.block-text').nth(0).boundingBox()
	const end = await page.locator('.block-text').nth(1).boundingBox()
	await page.mouse.move(start!.x + 1, start!.y + start!.height / 2)
	await page.mouse.down()
	await page.mouse.move(end!.x + end!.width - 2, end!.y + end!.height / 2, {
		steps: 12,
	})
	await page.mouse.up()
	expect(
		await page.evaluate(() => window.getSelection()?.toString()),
	).toContain('Review with Kent')
	await editor.press('Backspace')
	await expect(page.getByTestId('page-json')).not.toHaveText(original!)
	await editor.press('ControlOrMeta+z')
	await expect(page.getByTestId('page-json')).toHaveText(original!)
})
test('block controls, splitting, shortcuts, and read-only mode keep working', async ({
	page,
}) => {
	await page
		.getByRole('button', { name: 'Block 2 actions', exact: true })
		.click()
	await page.getByRole('menuitem', { name: 'Turn into…', exact: true }).click()
	await page.getByRole('option', { name: /Bulleted list/ }).click()
	await expect
		.poll(
			async () =>
				JSON.parse((await page.getByTestId('page-json').textContent())!)
					.blocks[1].kind,
		)
		.toBe('bullet')
	const editor = page.getByRole('textbox', { name: 'Page content' })
	await expect(editor).toBeFocused()
	await editor
		.getByText('Notes for the team.', { exact: true })
		.evaluate((paragraph) => {
			const range = document.createRange()
			range.selectNodeContents(paragraph)
			range.collapse(false)
			const selection = window.getSelection()
			selection?.removeAllRanges()
			selection?.addRange(range)
		})
	await page.keyboard.press('Enter')
	await page.keyboard.press('/')
	await page.getByRole('option', { name: /Quote/ }).click()
	await expect
		.poll(
			async () =>
				JSON.parse(
					(await page.getByTestId('page-json').textContent())!,
				).blocks.at(-1).kind,
		)
		.toBe('quote')
	const blocks = JSON.parse(
		(await page.getByTestId('page-json').textContent())!,
	).blocks
	expect(new Set(blocks.map((block: { id: string }) => block.id)).size).toBe(
		blocks.length,
	)
	expect(blocks.at(-1).kind).toBe('quote')
	await page.getByRole('button', { name: 'Toggle readonly' }).click()
	await expect(editor).toHaveAttribute('contenteditable', 'false')
	await expect(
		page.getByRole('button', { name: 'Block 2 actions', exact: true }),
	).toHaveCount(0)
})
