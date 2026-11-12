import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'
let script: string
const modes = ['columns', 'icons', 'list', 'gallery'] as const
test.beforeAll(async () => {
	const result = await build({
		stdin: {
			contents: `import React from'react';import{renderToString}from'react-dom/server';import{hydrateRoot}from'react-dom/client';import{SidebarPreferencesProvider}from'./packages/worker/start/components/sidebar-preferences.tsx';import{parseSidebarPreferences}from'./packages/worker/universal/sidebar-preferences.ts';import{useFileBrowserPreferences}from'./packages/worker/start/components/use-file-browser-preferences.ts';window.views=[];function Probe(){const prefs=useFileBrowserPreferences();const value=prefs.ready?prefs.view:'pending';window.views.push(value);return <section data-testid="view" data-view={value} data-size={prefs.thumbnailSize}>{['columns','icons','list','gallery'].map(view=><button key={view} onClick={()=>prefs.changeView(view)}>{view}</button>)}</section>}const app=<SidebarPreferencesProvider value={parseSidebarPreferences(document.cookie)}><Probe/></SidebarPreferencesProvider>;const root=document.getElementById('root');root.innerHTML=renderToString(app);window.initialView=root.querySelector('section').dataset.view;hydrateRoot(root,app);`,
			loader: 'tsx',
			resolveDir: process.cwd(),
		},
		bundle: true,
		write: false,
		platform: 'browser',
		format: 'iife',
		jsx: 'automatic',
		alias: { '#universal': resolve('packages/worker/universal') },
		define: { 'process.env.NODE_ENV': '"production"' },
	})
	script = result.outputFiles[0]!.text
})
test.beforeEach(async ({ page }) => {
	await page.route('https://finder-preferences.test/**', (route) =>
		route.fulfill(
			new URL(route.request().url()).pathname === '/app.js'
				? { contentType: 'application/javascript', body: script }
				: {
						contentType: 'text/html',
						body: '<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>',
					},
		),
	)
})
for (const view of modes)
	test(`${view} is the first rendered view and survives reload`, async ({
		page,
	}) => {
		await page.context().addCookies([
			{
				name: 'kody-sidebar',
				url: 'https://finder-preferences.test/',
				value: encodeURIComponent(
					JSON.stringify({ files: { view, thumbnailSize: 180 } }),
				),
			},
		])
		await page.addInitScript((view) => {
			localStorage.setItem('kody.files.view', view)
			localStorage.setItem('kody.files.thumbnailSize', '180')
		}, view)
		const errors: string[] = []
		page.on('pageerror', (error) => errors.push(error.message))
		await page.goto('https://finder-preferences.test/')
		expect(
			await page.evaluate(
				() => (window as unknown as { initialView: string }).initialView,
			),
		).toBe(view)
		await expect(page.getByTestId('view')).toHaveAttribute('data-view', view)
		await expect(page.getByTestId('view')).toHaveAttribute('data-size', '180')
		expect(
			await page.evaluate(() =>
				(window as unknown as { views: string[] }).views.every(
					(value) =>
						value ===
						document.querySelector('section')!.getAttribute('data-view'),
				),
			),
		).toBe(true)
		await page.reload()
		expect(
			await page.evaluate(
				() => (window as unknown as { initialView: string }).initialView,
			),
		).toBe(view)
		expect(errors).toEqual([])
	})
test('legacy local storage migrates without rendering the default view', async ({
	page,
}) => {
	await page.addInitScript(() =>
		localStorage.setItem('kody.files.view', 'gallery'),
	)
	await page.goto('https://finder-preferences.test/')
	expect(
		await page.evaluate(
			() => (window as unknown as { initialView: string }).initialView,
		),
	).toBe('pending')
	await expect(page.getByTestId('view')).toHaveAttribute('data-view', 'gallery')
	expect(
		await page.evaluate(() => (window as unknown as { views: string[] }).views),
	).not.toContain('columns')
	await expect
		.poll(async () => {
			const cookie = (await page.context().cookies()).find(
				(cookie) => cookie.name === 'kody-sidebar',
			)
			return cookie
				? JSON.parse(decodeURIComponent(cookie.value)).files.view
				: undefined
		})
		.toBe('gallery')
	await page.reload()
	expect(
		await page.evaluate(
			() => (window as unknown as { initialView: string }).initialView,
		),
	).toBe('gallery')
})
test('switching modes persists synchronously for the next server render', async ({
	page,
}) => {
	await page.goto('https://finder-preferences.test/')
	await page.getByRole('button', { name: 'list', exact: true }).click()
	await page.reload()
	expect(
		await page.evaluate(
			() => (window as unknown as { initialView: string }).initialView,
		),
	).toBe('list')
	await expect(page.getByTestId('view')).toHaveAttribute('data-view', 'list')
})
