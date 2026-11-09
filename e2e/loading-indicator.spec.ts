import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
let script: string
const css = readFileSync('packages/worker/public/styles.css', 'utf8')
	.split('\n.kody-loading {')
	.at(-1)!
test.beforeAll(async () => {
	const result = await build({
		stdin: {
			contents: `import React from'react';import{createRoot}from'react-dom/client';import{LoadingIndicator}from'./packages/worker/start/components/loading-indicator.tsx';createRoot(document.getElementById('root')).render(<LoadingIndicator label="Loading files"/>);`,
			resolveDir: process.cwd(),
			loader: 'tsx',
		},
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
		jsx: 'automatic',
		define: { 'process.env.NODE_ENV': '"production"' },
	})
	script = result.outputFiles[0]!.text
})
test('branded loader is centered, accessible, and respects reduced motion', async ({
	page,
}) => {
	await page.route('https://loader.test/**', (route) =>
		route.fulfill(
			new URL(route.request().url()).pathname === '/app.js'
				? { contentType: 'application/javascript', body: script }
				: {
						contentType: 'text/html',
						body: `<html><head><style>body{margin:0}#root{display:flex;height:100vh}.kody-loading {${css}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`,
					},
		),
	)
	await page.goto('https://loader.test/')
	const loader = page.getByRole('status', {
		name: 'Loading files',
		exact: true,
	})
	await expect(loader).toBeVisible()
	await expect(loader).toHaveText('')
	const mark = page.locator('svg'),
		bounds = (await mark.boundingBox())!,
		viewport = page.viewportSize()!
	expect(
		Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2),
	).toBeLessThan(1)
	expect(
		Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2),
	).toBeLessThan(1)
	await expect(mark.locator('path').first()).toHaveCSS(
		'animation-name',
		'kody-loading-trace',
	)
	await page.emulateMedia({ reducedMotion: 'reduce' })
	await expect(mark.locator('path').first()).toHaveCSS('animation-name', 'none')
	await page.screenshot({ path: '/tmp/kody-loader.png' })
})
