import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
const styles = readFileSync('packages/worker/public/styles.css', 'utf8')
import {
	fileViewerKind,
	detectFileMediaType,
} from '../packages/worker/universal/file-viewers.ts'
let app: string, worker: string
const data = {
	name: 'Launch',
	enabled: true,
	empty: null,
	items: Array.from({ length: 12000 }, (_, index) => ({
		index,
		label: 'Item ' + index,
	})),
	html: '<img src=x onerror=alert(1)>',
}
test.beforeAll(async () => {
	const shared = {
		bundle: true,
		write: false,
		platform: 'browser' as const,
		alias: { '#universal': resolve('packages/worker/universal') },
		define: { 'process.env.NODE_ENV': '"production"' },
	}
	const workerBuild = await build({
		...shared,
		entryPoints: [
			'packages/worker/start/pages/file-viewers/json-preview.worker.ts',
		],
		format: 'esm',
	})
	worker = workerBuild.outputFiles![0]!.text
	const appBuild = await build({
		...shared,
		stdin: {
			contents: `import React from'react';import{createRoot}from'react-dom/client';import JsonFileViewer from'./packages/worker/start/pages/file-viewers/json-file-viewer.tsx';createRoot(document.getElementById('root')).render(<JsonFileViewer src="/asset.json" download="/asset.json?download" content={new URLSearchParams(location.search).has('draft')?' {"current":true}':undefined}/>);`,
			loader: 'tsx',
			resolveDir: process.cwd(),
		},
		format: 'iife',
		jsx: 'automatic',
		jsxImportSource: '@emotion/react',
		define: {
			...shared.define,
			'import.meta.url': '"https://json.test/app.js"',
		},
	})
	app = appBuild.outputFiles![0]!.text
})
test.beforeEach(async ({ page }) => {
	await page.route('https://json.test/**', (route) => {
		const url = new URL(route.request().url())
		return route.fulfill(
			url.pathname === '/app.js'
				? { contentType: 'application/javascript', body: app }
				: url.pathname === '/json-preview.worker.ts'
					? { contentType: 'application/javascript', body: worker }
					: url.pathname === '/asset.json'
						? {
								contentType: 'application/json',
								body: url.searchParams.has('invalid')
									? ' {"broken": <script>alert(1)</script>'
									: JSON.stringify(data, null, 2),
							}
						: {
								contentType: 'text/html',
								body: `<!doctype html><html><head><style>${styles}html,body,#root{height:100%;margin:0}#root{display:flex}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`,
							},
		)
	})
})
test('JSON detection handles extensions and vendor types', () => {
	expect(fileViewerKind('Launch', 'application/vnd.kody.page+json')).toBeNull()
	expect(fileViewerKind('data.json', 'text/plain')).toBe('json')
	expect(fileViewerKind('response', 'application/problem+json')).toBe('json')
	expect(detectFileMediaType('data.JSON', 'application/octet-stream')).toBe(
		'application/json',
	)
})
test('large JSON uses virtual source and batched, keyboard accessible tree rows', async ({
	page,
}) => {
	await page.goto('https://json.test/')
	const tree = page.getByRole('tree', { name: 'JSON tree' })
	await expect(tree).toBeVisible()
	await expect(tree).toContainText('Launch')
	await page.screenshot({ path: '.tmp/json-preview-tree.png' })
	const items = tree
		.getByRole('treeitem')
		.filter({ hasText: /items: \[12000\]/ })
	await items.focus()
	await items.press('ArrowRight')
	await expect(tree.locator('[data-json-path="/items/0"]')).toBeAttached()
	await expect.poll(() => tree.getByRole('treeitem').count()).toBeLessThan(80)
	await items.press('ArrowRight')
	await expect(tree.locator('[data-json-path="/items/0"]')).toBeFocused()
	await page.keyboard.press('ArrowRight')
	await expect(tree.locator('[data-json-path="/items/0/index"]')).toBeAttached()
	await page.keyboard.press('ArrowRight')
	await expect(tree.locator('[data-json-path="/items/0/index"]')).toBeFocused()
	await page.keyboard.press('ArrowLeft')
	await expect(tree.locator('[data-json-path="/items/0"]')).toBeFocused()
	await page.keyboard.press('End')
	await expect(tree.locator('[data-json-path="/html"]')).toBeFocused()
	expect(await page.locator('img').count()).toBe(0)
	await tree
		.getByRole('button', { name: 'Load next 500' })
		.scrollIntoViewIfNeeded()
	await tree.getByRole('button', { name: 'Load next 500' }).click()
	await expect.poll(() => tree.getByRole('treeitem').count()).toBeLessThan(80)
	await page.getByRole('button', { name: 'Raw', exact: true }).click()
	const source = page.getByRole('region', { name: 'JSON source' })
	await expect(source).toContainText('"name"')
	await page.screenshot({ path: '.tmp/json-preview-raw.png' })
	await expect
		.poll(() => source.locator('[data-json-line]').count())
		.toBeLessThan(80)
	const colors = await source
		.locator('code span')
		.evaluateAll((nodes) => [
			...new Set(nodes.map((node) => getComputedStyle(node).color)),
		])
	expect(colors.length).toBeGreaterThan(2)
	await source.evaluate((element) => (element.scrollTop = element.scrollHeight))
	await expect(source).toContainText('onerror=alert(1)')
	await expect
		.poll(() => source.locator('[data-json-line]').count())
		.toBeLessThan(80)
})
test('invalid JSON stays readable in raw mode', async ({ page }) => {
	await page.route('https://json.test/asset.json', (route) =>
		route.fulfill({
			contentType: 'application/json',
			body: '{"broken": <script>alert(1)</script>',
		}),
	)
	await page.goto('https://json.test/')
	await expect(page.getByRole('alert')).toContainText('Invalid JSON')
	await expect(
		page.getByRole('button', { name: 'Tree', exact: true }),
	).toBeDisabled()
	await expect(page.getByRole('region', { name: 'JSON source' })).toContainText(
		'<script>alert(1)</script>',
	)
	expect(await page.locator('script').count()).toBe(1)
})

test('current draft content is previewed without fetching the saved revision', async ({
	page,
}) => {
	const requests: string[] = []
	page.on('request', (request) => requests.push(request.url()))
	await page.goto('https://json.test/?draft')
	await expect(page.getByRole('tree')).toContainText('current: true')
	expect(requests.some((url) => url.includes('/asset.json'))).toBe(false)
})
test('very long minified strings remain virtualized and highlighted', async ({
	page,
}) => {
	await page.route('https://json.test/asset.json', (route) =>
		route.fulfill({
			contentType: 'application/json',
			body: JSON.stringify({ long: 'x'.repeat(2000000) }),
		}),
	)
	await page.goto('https://json.test/')
	await page.getByRole('button', { name: 'Raw', exact: true }).click()
	const source = page.getByRole('region', { name: 'JSON source' })
	await expect
		.poll(() => source.locator('[data-json-line]').count())
		.toBeLessThan(80)
	await expect(source).toContainText('"long"')
	expect(
		await source.evaluate((element) => element.scrollHeight),
	).toBeGreaterThan(20000)
})

test('JSON viewer uses the application dark theme', async ({ page }) => {
	await page.emulateMedia({ colorScheme: 'dark' })
	await page.goto('https://json.test/')
	await expect(page.getByRole('tree')).toContainText('Launch')
	await page.screenshot({ path: '.tmp/json-preview-dark.png' })
	await page.getByRole('button', { name: 'Raw', exact: true }).click()
	const source = page.getByRole('region', { name: 'JSON source' })
	await expect(source).toContainText('"name"')
	expect(
		await source
			.locator('code span')
			.evaluateAll((nodes) => [
				...new Set(nodes.map((node) => getComputedStyle(node).color)),
			]),
	).toHaveLength(5)
})
