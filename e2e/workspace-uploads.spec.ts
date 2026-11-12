import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'
let script: string

test.beforeAll(async () => {
	const result = await build({
		stdin: {
			contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{WorkspaceUploads,useWorkspaceUploads}from'./packages/worker/start/components/workspace-uploads.tsx';function App(){const{enqueue}=useWorkspaceUploads();const[view,setView]=useState(false);return <><input aria-label="Choose files" type="file" multiple onChange={e=>enqueue([...e.target.files],{org:'jane',parentId:'11111111-1111-4111-8111-111111111111',destination:'Assets'})}/><button onClick={()=>setView(!view)}>Navigate</button>{view?'Another page':'Workspace'}</>}createRoot(document.getElementById('root')).render(<WorkspaceUploads><App/></WorkspaceUploads>);`,
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
				name: 'upload-fixtures',
				setup(builder) {
					builder.onResolve(
						{
							filter:
								/^(?:@tanstack\/react-router|@tanstack\/react-query|#start\/server\/files)$/,
						},
						(args) => ({ path: args.path, namespace: 'stub' }),
					)
					builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
						loader: 'js',
						contents: args.path.includes('react-router')
							? `export function useRouter(){return{invalidate:async()=>{}}}`
							: args.path.includes('react-query')
								? `export function useQueryClient(){return{invalidateQueries:async()=>{}}}`
								: `export async function saveFile({data,signal,fetch}){return (await fetch('/api/upload',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),signal})).json()}`,
					}))
				},
			},
		],
	})
	script = result.outputFiles[0]!.text
})
test.beforeEach(async ({ page }) => {
	await page.route('https://uploads.test/**', (route) =>
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
test('batch queue survives navigation, minimizes, retries with stable IDs, and reports failures', async ({
	page,
}) => {
	const requests: Array<{
		orgSlug: string
		input: {
			name: string
			parent_id: string
			file_id: string
			write_id: string
			encoding: string
			content: string
		}
	}> = []
	let failures = 0
	await page.route('https://uploads.test/api/upload', async (route) => {
		const data = route.request().postDataJSON()
		requests.push(data)
		if (data.input.name === 'retry.csv' && failures++ === 0)
			await route.fulfill({ json: { ok: false, message: 'Connection lost' } })
		else await route.fulfill({ json: { ok: true } })
	})
	await page.goto('https://uploads.test/')
	await page.getByLabel('Choose files').setInputFiles([
		{ name: 'one.txt', mimeType: 'text/plain', buffer: Buffer.from('first') },
		{
			name: 'retry.csv',
			mimeType: 'text/csv',
			buffer: Buffer.from('a,b\n1,2'),
		},
	])
	await expect(
		page.getByText('Connection lost', { exact: false }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Navigate', exact: true }).click()
	await expect(page.getByText('Another page')).toBeVisible()
	await page.getByRole('button', { name: 'Minimize uploads' }).click()
	await expect(
		page.getByRole('button', { name: 'Retry', exact: true }),
	).not.toBeVisible()
	await page.getByRole('button', { name: 'Show uploads', exact: true }).click()
	await page.getByRole('button', { name: 'Retry', exact: true }).click()
	await expect(
		page.getByRole('link', { name: 'Open', exact: true }),
	).toHaveCount(2)
	expect(requests).toHaveLength(3)
	expect(
		requests.every(
			(item) =>
				item.orgSlug === 'jane' &&
				item.input.parent_id === '11111111-1111-4111-8111-111111111111',
		),
	).toBe(true)
	const retries = requests.filter((item) => item.input.name === 'retry.csv')
	expect(retries[0]!.input.file_id).toBe(retries[1]!.input.file_id)
	expect(retries[0]!.input.write_id).toBe(retries[1]!.input.write_id)
	expect(
		requests.find((item) => item.input.name === 'one.txt')!.input.content,
	).toBe('first')
	await page.getByRole('button', { name: 'Clear', exact: true }).click()
	await expect(
		page.getByRole('region', { name: 'Uploads', exact: true }),
	).not.toBeVisible()
})
test('queue limits concurrency and canceling a queued file avoids sending it', async ({
	page,
}) => {
	const sent: string[] = []
	let release: () => void = () => {}
	const hold = new Promise<void>((resolve) => (release = resolve))
	await page.route('https://uploads.test/api/upload', async (route) => {
		sent.push(route.request().postDataJSON().input.name)
		await hold
		await route.fulfill({ json: { ok: true } })
	})
	await page.goto('https://uploads.test/')
	await page.getByLabel('Choose files').setInputFiles(
		['a', 'b', 'c'].map((name) => ({
			name: `${name}.txt`,
			mimeType: 'text/plain',
			buffer: Buffer.from(name),
		})),
	)
	await expect.poll(() => sent.length).toBe(2)
	await page.getByRole('button', { name: 'Cancel c.txt' }).click()
	release()
	await expect(
		page.getByRole('link', { name: 'Open', exact: true }),
	).toHaveCount(2)
	expect(sent).not.toContain('c.txt')
})
