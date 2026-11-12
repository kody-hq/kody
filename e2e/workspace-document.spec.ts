import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { peleAsset } from './pele-asset.ts'
import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'

let script: string
test.beforeAll(async () => {
	const result = await build({
		stdin: {
			contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{WorkspacePageEditor}from'./packages/worker/start/pages/workspace-page-editor.tsx';function App(){const[content,setContent]=useState(JSON.stringify({version:1,blocks:[{id:'00000000-0000-4000-8000-000000000001',kind:'heading',text:'Launch checklist'},{id:'00000000-0000-4000-8000-000000000002',kind:'quote',text:'Review with Kent'},{id:'00000000-0000-4000-8000-000000000003',kind:'paragraph',text:'Notes for the team.'}]}));const[readonly,setReadonly]=useState(false);return <><button onClick={()=>setReadonly(!readonly)}>Toggle readonly</button><WorkspacePageEditor content={content} onChange={readonly?undefined:setContent} files={[]} renderFile={()=>null} loadLinkTitle={async()=> "Project plan"}/><output data-testid="page-json">{content}</output></>}createRoot(document.getElementById('root')).render(<App/>);`,
			resolveDir: process.cwd(),
			loader: 'tsx',
		},
		bundle: true,
		plugins: [peleAsset],
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
	await page.route('https://document.test/pele.js', (route) =>
		readFile(resolve('node_modules/pele/dist/pele.global.js')).then((body) =>
			route.fulfill({ contentType: 'application/javascript', body }),
		),
	)
	await page.route(/^https:\/\/document\.test\/(?!pele\.js)/, (route) =>
		route.fulfill(
			new URL(route.request().url()).pathname === '/editor.js'
				? { contentType: 'application/javascript', body: script }
				: {
						contentType: 'text/html',
						headers: {
							'content-security-policy':
								"default-src 'self'; script-src 'self' 'nonce-fixture'; frame-src 'self'; style-src 'unsafe-inline'",
						},
						body: '<html><head><meta property="csp-nonce" content="fixture"><style>body{font:16px system-ui;padding:60px;max-width:840px}output{display:none}</style></head><body><div id="root"></div><script src="/editor.js"></script></body></html>',
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

test('new page blocks keep their content when edited and viewed read-only', async ({
	page,
	context,
}) => {
	const add = async (kind: string) => {
		await page.getByRole('button', { name: 'Add block', exact: true }).click()
		await page.getByRole('option', { name: kind, exact: true }).click()
	}
	await add('Table')
	const table = page.locator('.tiptap table')
	await expect(table.getByRole('row')).toHaveCount(2)
	const header = table.getByRole('columnheader').first()
	await header.click()
	await page.keyboard.insertText('Owner')
	await expect(header).toHaveText('Owner')
	await page.keyboard.press('Tab')
	await page.keyboard.insertText('Status')
	await expect(table.getByRole('columnheader').nth(1)).toHaveText('Status')
	await page.getByRole('button', { name: 'Add column' }).click()
	await page.getByRole('button', { name: 'Add row' }).click()
	await expect(table.getByRole('row')).toHaveCount(3)
	await expect(table.getByRole('row').first().locator('th, td')).toHaveCount(3)
	const firstBodyCell = table.getByRole('row').nth(1).getByRole('cell').first()
	await firstBodyCell.click()
	await context.grantPermissions(['clipboard-read', 'clipboard-write'])
	await page.evaluate(() =>
		navigator.clipboard.writeText('Avery\tReady\nMilo\tDraft'),
	)
	await page.keyboard.press('ControlOrMeta+v')
	await expect(firstBodyCell).toHaveText('Avery')
	await expect(
		table.getByRole('row').last().getByRole('cell').nth(1),
	).toHaveText('Draft')

	await add('Callout')
	const callout = page.locator('[data-kind="callout"] .block-text')
	await callout.click()
	await page.keyboard.insertText('Review before sharing.')
	await expect(callout).toHaveText('Review before sharing.')
	await add('Collapsible section')
	await page
		.getByRole('textbox', { name: 'Section title' })
		.fill('More context')
	const section = page.locator('.tiptap details')
	const body = section.locator('.block-text')
	await body.click()
	await page.keyboard.insertText('Background')
	await expect(body).toHaveText('Background')

	await page.getByRole('button', { name: 'Toggle readonly' }).click()
	await expect(page.getByRole('button', { name: 'Add row' })).toHaveCount(0)
	await expect(header).toHaveText('Owner')
	await expect(table.getByRole('columnheader').nth(1)).toHaveText('Status')
	await expect(callout).toBeVisible()
	const summary = section.locator('summary')
	await expect(summary).toHaveText('More context')
	if (await body.isVisible()) await summary.click()
	await expect(body).toBeHidden()
	await summary.click()
	await expect(body).toBeVisible()
})

test('numbered items, contents, link cards and diagrams update in the editor', async ({
	page,
}) => {
	let rendererRequests = 0
	page.on('request', (request) => {
		if (new URL(request.url()).pathname === '/pele.js') rendererRequests++
	})
	const add = async (kind: string) => {
		await page.getByRole('button', { name: 'Add block', exact: true }).click()
		await page.getByRole('option', { name: kind, exact: true }).click()
	}
	await add('Numbered list')
	const numbered = page.locator('[data-kind="numbered"]')
	await numbered.first().locator('.block-text').click()
	await page.keyboard.insertText('Draft')
	await page.keyboard.press('Enter')
	await page.keyboard.insertText('Review')
	await expect(numbered.locator('.block-number')).toHaveText(['1.', '2.'])
	await expect(numbered.locator('.block-text')).toHaveText(['Draft', 'Review'])

	await add('Table of contents')
	const contents = page.getByRole('navigation', { name: 'Table of contents' })
	const heading = page.locator('[data-kind="heading"] .block-text')
	await contents.getByRole('link', { name: 'Launch checklist' }).click()
	await expect(page).toHaveURL(/#block-00000000-0000-4000-8000-000000000001$/)
	await heading.click()
	await page.keyboard.press('End')
	await page.keyboard.insertText(' draft')
	await expect(
		contents.getByRole('link', { name: 'Launch checklist draft' }),
	).toBeVisible()

	await add('Link preview')
	const url = page.locator('[aria-label="Link URL"]')
	await url.click()
	await page.keyboard.insertText('https://example.com/plan')
	await page.getByRole('button', { name: 'Fetch page title' }).click()
	await expect(page.getByRole('textbox', { name: 'Link title' })).toHaveValue(
		'Project plan',
	)
	await page.getByRole('button', { name: 'Done', exact: true }).click()
	const link = page.getByRole('link', { name: /Project plan/ })
	await expect(link).toHaveAttribute('href', 'https://example.com/plan')
	await expect(link).toHaveText('Project planexample.com')

	await add('Mermaid diagram')
	await expect(page.getByTitle('Mermaid diagram')).toHaveCount(0)
	expect(rendererRequests).toBe(0)
	const source = page.locator('[aria-label="Mermaid source"]')
	await source.click()
	await page.keyboard.insertText('flowchart LR')
	await page.keyboard.press('Enter')
	await page.keyboard.insertText('A[Draft] --> B[Publish]')
	const frame = page.frameLocator('iframe[title="Mermaid diagram"]')
	await expect(frame.locator('svg')).toBeVisible()
	await expect(frame.locator('svg').getByText('Publish')).toBeVisible()
	expect(rendererRequests).toBe(1)
	await page.getByRole('button', { name: 'Toggle readonly' }).click()
	await expect(source).toBeHidden()
	await expect(frame.locator('svg')).toBeVisible()
	await expect(link).toBeVisible()
})
