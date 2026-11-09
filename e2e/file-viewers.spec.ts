import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildOfficeViewerAssets } from '../tools/vite-office-viewers.ts'
import {
	officePreviewHtml,
	officePreviewPolicy,
} from '../packages/worker/universal/office-preview.ts'
import {
	parseFileRange,
	fileAssetPolicy,
} from '../packages/worker/universal/file-assets.ts'
let assets: Awaited<ReturnType<typeof buildOfficeViewerAssets>>
let app: string
const formats = {
	docx: [
		'launch.docx',
		'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	],
	xlsx: [
		'launch.xlsx',
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	],
	pptx: [
		'launch.pptx',
		'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	],
	zip: ['launch.zip', 'application/zip'],
	pdf: ['launch.pdf', 'application/pdf'],
	image: ['mark.svg', 'image/svg+xml'],
	audio: ['tone.wav', 'audio/wav'],
	video: ['launch.webm', 'video/webm'],
} as const

test.beforeAll(async () => {
	assets = await buildOfficeViewerAssets()
	const manifest = Object.fromEntries(
		[...assets].map(([kind, asset]) => [kind, '/' + asset.name]),
	)
	const result = await build({
		stdin: {
			contents: `import React from'react';import{createRoot}from'react-dom/client';import{FileViewer}from'./packages/worker/start/pages/file-viewers/file-viewer.tsx';const formats=${JSON.stringify(formats)};const format=new URL(location.href).searchParams.get('kind')||'image';const[name,mediaType]=formats[format];createRoot(document.getElementById('root')).render(<FileViewer orgSlug="viewer" fileId="00000000-0000-4000-8000-000000000001" revisionId="00000000-0000-4000-8000-000000000002" name={name} mediaType={mediaType}/>);`,
			resolveDir: process.cwd(),
			loader: 'tsx',
		},
		bundle: true,
		write: false,
		metafile: true,
		format: 'iife',
		platform: 'browser',
		jsx: 'automatic',
		jsxImportSource: '@emotion/react',
		alias: { '#universal': resolve('packages/worker/universal') },
		define: { 'process.env.NODE_ENV': '"production"' },
		plugins: [
			{
				name: 'office-manifest',
				setup(builder) {
					builder.onResolve(
						{ filter: /^virtual:kody-office-viewers$/ },
						() => ({ path: 'manifest', namespace: 'office' }),
					)
					builder.onLoad({ filter: /.*/, namespace: 'office' }, () => ({
						contents: 'export default ' + JSON.stringify(manifest),
						loader: 'js',
					}))
				},
			},
		],
	})
	app = result.outputFiles[0]!.text
	// Office engines are separate assets, never imports of the viewer shell.
	expect(
		Object.keys(result.metafile!.inputs).some((input) =>
			/node_modules\/(jszip|read-excel-file)\//.test(input),
		),
	).toBe(false)
})
for (const kind of Object.keys(formats) as Array<keyof typeof formats>)
	test(`${kind} loads only its selected renderer and displays the original file`, async ({
		page,
	}) => {
		const [name, type] = formats[kind],
			requests: string[] = []
		const file = readFileSync(resolve('e2e/fixtures/files', name))
		await page.route('https://viewers.test/**', async (route) => {
			const request = route.request(),
				url = new URL(request.url())
			requests.push(url.pathname)
			if (url.pathname === '/app.js')
				return route.fulfill({
					contentType: 'application/javascript',
					body: app,
				})
			const asset = [...assets.values()].find(
				(asset) => '/' + asset.name === url.pathname,
			)
			if (asset)
				return route.fulfill({
					contentType: 'application/javascript',
					body: Buffer.from(asset.script),
				})
			if (url.pathname.startsWith('/office-preview/')) {
				const script = url.searchParams.get('script')!
				return route.fulfill({
					contentType: 'text/html',
					headers: {
						'Content-Security-Policy': officePreviewPolicy(url.origin, script),
					},
					body: officePreviewHtml(url.origin, script),
				})
			}
			if (url.pathname.startsWith('/file-assets/')) {
				const range = parseFileRange(
					request.headers()['range'] ?? null,
					file.length,
				)
				if (range === false)
					return route.fulfill({
						status: 416,
						headers: { 'Content-Range': `bytes */${file.length}` },
					})
				const body = range
					? file.subarray(range.offset, range.offset + range.length)
					: file
				return route.fulfill({
					status: range ? 206 : 200,
					contentType: type,
					headers: {
						'Accept-Ranges': 'bytes',
						'Content-Length': String(body.length),
						'Content-Security-Policy': fileAssetPolicy(type),
						...(range
							? {
									'Content-Range': `bytes ${range.offset}-${range.offset + range.length - 1}/${file.length}`,
								}
							: {}),
					},
					body,
				})
			}
			return route.fulfill({
				contentType: 'text/html',
				body: '<html><head><style>html,body,#root{margin:0;height:100%;font:14px system-ui}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
			})
		})
		await page.goto('https://viewers.test/?kind=' + kind)
		if (kind === 'docx')
			await expect(
				page.frameLocator('iframe').getByText('Launch review', { exact: true }),
			).toBeVisible()
		else if (kind === 'xlsx') {
			const frame = page.frameLocator('iframe')
			await expect(
				frame.getByRole('cell', { name: 'Jane', exact: true }),
			).toBeVisible()
			await frame.getByRole('button', { name: 'Budget', exact: true }).click()
			await expect(
				frame.getByRole('cell', { name: 'Storage', exact: true }),
			).toBeVisible()
		} else if (kind === 'pptx') {
			const frame = page.frameLocator('iframe')
			await expect(
				frame.getByText('Launch review', { exact: true }),
			).toBeVisible()
			await frame.getByRole('button', { name: 'Next', exact: true }).click()
			await expect(frame.getByText('Next steps', { exact: true })).toBeVisible()
		} else if (kind === 'zip') {
			const archive = page.getByRole('region', { name: 'Archive contents' })
			await archive
				.getByRole('button', { name: 'Open folder assets', exact: true })
				.click()
			await expect(
				archive.getByRole('cell', { name: 'notes.txt', exact: true }),
			).toBeVisible()
			await archive
				.getByRole('button', { name: 'Archive', exact: true })
				.click()
			await expect(
				archive.getByRole('cell', { name: 'README.txt', exact: true }),
			).toBeVisible()
		} else if (kind === 'image')
			await expect
				.poll(() =>
					page
						.getByRole('img', { name })
						.evaluate((image) => (image as HTMLImageElement).naturalWidth),
				)
				.toBe(400)
		else if (kind === 'audio' || kind === 'video')
			await expect
				.poll(() =>
					page
						.locator(kind === 'audio' ? 'audio' : 'video')
						.evaluate((media) => (media as HTMLMediaElement).duration),
				)
				.toBeCloseTo(1, 1)

		if (kind === 'docx' || kind === 'pptx')
			await expect(
				page.frameLocator('iframe').getByText('Preview only', { exact: true }),
			).toBeVisible()

		if (kind === 'docx' || kind === 'xlsx' || kind === 'pptx') {
			const frame = page.frameLocator('iframe')
			await page.emulateMedia({ colorScheme: 'dark' })
			await expect(frame.locator('body')).toHaveCSS(
				'background-color',
				'rgb(17, 20, 23)',
			)
			await expect(frame.locator('body')).toHaveCSS(
				'color',
				'rgb(234, 237, 240)',
			)
			await expect(
				frame.locator(kind === 'xlsx' ? 'table' : '.office-content'),
			).toHaveCSS('background-color', 'rgb(27, 30, 35)')
			await page.emulateMedia({ colorScheme: 'light' })
			await expect(frame.locator('body')).toHaveCSS(
				'background-color',
				'rgb(247, 248, 250)',
			)
			await expect(frame.locator('body')).toHaveCSS('color', 'rgb(23, 27, 32)')
		}

		const engineRequests = requests.filter((path) =>
			path.startsWith('/office-viewers/'),
		)
		if (kind === 'docx' || kind === 'xlsx' || kind === 'pptx') {
			expect(engineRequests).toEqual(['/' + assets.get(kind)!.name])
			const host = page
				.frames()
				.find((frame) => frame.url().includes('/office-preview/'))!
			expect(
				await host.evaluate(() => {
					try {
						void parent.document.body
						return false
					} catch {
						return true
					}
				}),
			).toBe(true)
			expect(
				await host.evaluate(() => {
					try {
						void localStorage.length
						return false
					} catch {
						return true
					}
				}),
			).toBe(true)
		} else expect(engineRequests).toEqual([])
		if (kind === 'pdf')
			await expect(page.locator('iframe')).toHaveAttribute(
				'src',
				/\/file-assets\//,
			)
	})
