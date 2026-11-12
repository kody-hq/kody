import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
let script: string
const root = '11111111-1111-4111-8111-111111111111',
	child = '22222222-2222-4222-8222-222222222222'
test.beforeAll(async () => {
	const result = await build({
		stdin: {
			contents: `import React from 'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{PublicFileShell}from'./packages/worker/start/pages/public-file-shell.tsx';const params=new URLSearchParams(location.search);const root='${root}',child='${child}';const files=[{id:root,name:'Launch',mediaType:'application/vnd.kody.directory'},{id:child,name:'Brief.md',parentId:root,mediaType:'text/markdown'}];const file=params.has('folder')?files[0]:files[1];createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><PublicFileShell scope={{orgSlug:'team',rootId:root,token:'a'.repeat(64)}} file={file} files={files} openUse={params.has('use')}><article style={{padding:32}}><h1>Launch brief</h1><p>Shared source material.</p></article></PublicFileShell></QueryClientProvider>)`,
			resolveDir: process.cwd(),
			loader: 'tsx',
		},
		bundle: true,
		write: false,
		platform: 'browser',
		format: 'iife',
		jsx: 'automatic',
		jsxImportSource: '@emotion/react',
		alias: { '#universal': resolve('packages/worker/universal') },
		define: { 'process.env.NODE_ENV': '"production"' },
		plugins: [
			{
				name: 'fixture',
				setup(b) {
					b.onResolve(
						{ filter: /^#start\/server\/|site-link\.tsx$/ },
						(args) => ({ path: args.path, namespace: 'fixture' }),
					)
					b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({
						loader: 'tsx',
						resolveDir: process.cwd(),
						contents: args.path.includes('site-link')
							? 'export function SiteLink({href,children,...props}){return <a href={href} {...props}>{children}</a>}'
							: `let failed=false;export async function readWebsiteSessionInfo(){return location.search.includes('signedin')?{username:'viewer'}:null}export async function preparePublicFileCopy(){return {ticket:'ticket',count:3,name:'Brief.md',destination:'viewer',fileId:'copy'}}export async function copyPublicFileStep({data}){await new Promise(r=>setTimeout(r,20));if(data.index===1&&!failed){failed=true;throw new Error('Connection interrupted. Try again.')}return {ok:true}}`,
					}))
				},
			},
		],
	})
	script = result.outputFiles[0]!.text
})
test.beforeEach(async ({ page }) => {
	await page.route('https://sharing.test/**', (route) =>
		route.fulfill(
			new URL(route.request().url()).pathname === '/app.js'
				? { contentType: 'application/javascript', body: script }
				: {
						contentType: 'text/html',
						body: `<!doctype html><html lang="en"><head><title>Shared Launch</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{--color-text:#17191d;--color-text-muted:#555b66;--color-background:#fff;--color-surface:#f7f8fa;--color-border:#d9dce1;--color-border-subtle:#eceef1;--color-primary:#126835;--color-on-primary:#fff;--color-primary-hover:#0e5229;--color-primary-text:#126835;--color-primary-softest:#e4f2e9;--color-danger:#b42318}body{margin:0;font-family:Arial,sans-serif}button{font:inherit}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>`,
					},
		),
	)
})
test('visitors can read and download before signing in, and sign-in returns to the selected copy flow', async ({
	page,
}) => {
	await page.goto('https://sharing.test/')
	await expect(
		page.getByRole('heading', { name: 'Launch brief' }),
	).toBeVisible()
	await expect(
		page.getByRole('navigation', { name: 'Shared file path' }),
	).toContainText('Brief.md')
	await expect(
		page.getByRole('link', { name: 'Download', exact: true }),
	).toHaveAttribute(
		'href',
		new RegExp(`/shared-file-assets/.+/${child}\\?download=true$`),
	)
	await page.getByRole('button', { name: 'Use in Kody', exact: true }).click()
	const signIn = page.getByRole('link', { name: 'Sign in to save a copy' })
	const href = await signIn.getAttribute('href')
	expect(
		new URL(href!, 'https://sharing.test').searchParams.get('redirectTo'),
	).toContain(`item=${child}&use=true`)
	await page.getByRole('button', { name: 'Close use in Kody' }).press('Escape')
	await expect(page.getByRole('dialog')).toHaveCount(0)
	await expect(
		page.getByRole('button', { name: 'Use in Kody', exact: true }),
	).toBeFocused()
})
test('copy failures retain progress and retry the remaining items', async ({
	page,
}) => {
	await page.goto('https://sharing.test/?signedin&use')
	await page
		.getByRole('button', { name: 'Save a copy in Kody', exact: true })
		.click()
	const alert = page.getByRole('alert')
	await expect(alert).toContainText('1 item saved.')
	await expect(alert).toContainText('Connection interrupted. Try again.')
	await page.getByRole('button', { name: 'Retry remaining items' }).click()
	await expect(page.getByRole('status')).toContainText('Saved 3 items')
	await expect(
		page.getByRole('link', { name: 'Open copy in Kody' }),
	).toHaveAttribute('href', '/@viewer/-/files?file=copy')
})
test('folder navigation and mobile visitor actions remain accessible', async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 780 })
	await page.goto('https://sharing.test/?folder')
	await expect(
		page.getByRole('heading', { name: 'Launch', exact: true }),
	).toBeVisible()
	await expect(
		page.getByRole('heading', { name: 'Launch brief', exact: true }),
	).toHaveCount(0)
	await expect(
		page.getByRole('link', { name: 'Download', exact: true }),
	).toHaveCount(0)
	const childLink = page.getByRole('link', { name: 'Brief.md' })
	await expect(childLink).toBeVisible()
	await expect(childLink).toHaveAttribute('href', new RegExp(`item=${child}`))
	await page.getByRole('button', { name: 'Use in Kody', exact: true }).click()
	await expect(
		page.getByRole('link', { name: 'Sign in to save a copy' }),
	).toBeVisible()
	const box = await page.getByRole('dialog').boundingBox()
	expect(box!.x).toBeGreaterThanOrEqual(0)
	expect(box!.x + box!.width).toBeLessThanOrEqual(390)
	const audit = await new AxeBuilder({ page }).analyze()
	expect(
		audit.violations.filter(
			(v) => v.impact === 'critical' || v.impact === 'serious',
		),
	).toEqual([])
})
