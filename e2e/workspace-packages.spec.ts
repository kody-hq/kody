import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'
let script: string
test.beforeAll(async () => {
	const base = {
		description: '',
		tags: [],
		updatedAt: '2026-11-05T12:00:00Z',
		createdAt: '2026-11-05T12:00:00Z',
		communityListingId: null,
		communityListingKodyId: null,
		communityPublishedAt: null,
		needsRepublish: false,
		hasPackage: true,
		hasApp: false,
		webhookCount: 0,
		jobCount: 0,
		iconUrl: null,
	}
	const items = [
		{ ...base, name: 'Launch board', kodyId: 'launch-board', hasApp: true },
		{ ...base, name: 'Notes', kodyId: 'notes' },
		{
			...base,
			name: 'Invoke only',
			kodyId: 'invoke-only',
			canOpenDetail: false,
		},
		{
			...base,
			name: 'Plain repository',
			kodyId: 'plain-repository',
			hasPackage: false,
		},
	]
	const result = await build({
		stdin: {
			contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{WorkspacePackages}from'./packages/worker/start/pages/workspace-packages.tsx';function App(){const[items,setItems]=useState(${JSON.stringify(items)});const[search,setSearch]=useState('');const[revoked,setRevoked]=useState(new URL(location.href).searchParams.has('revoked'));return <><input aria-label="Search" value={search} onChange={e=>setSearch(e.target.value)}/><WorkspacePackages orgSlug="jane" search={search} query={{data:{profile:{username:'jane'},packages:items},isPending:false,isError:revoked,isFetching:false,refetch:()=>{setRevoked(false);setItems([...items,{...items[1],name:'New repository',kodyId:'new-repository'}])}}}/></>}createRoot(document.getElementById('root')).render(<App/>);`,
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
		plugins: [
			{
				name: 'route-stubs',
				setup(builder) {
					builder.onResolve(
						{
							filter:
								/^(?:@tanstack\/react-router|#start\/server\/org-management)$|use-matched-page-scope\.ts$|site-link\.tsx$/,
						},
						(args) => ({ path: args.path, namespace: 'stub' }),
					)
					builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
						resolveDir: process.cwd(),
						loader: 'tsx',
						contents:
							args.path === '@tanstack/react-router'
								? `export function isNotFound(){return false} export function useRouter(){return {navigate:async({href})=>history.pushState({},'',href)}}`
								: args.path.includes('site-link')
									? `export function SiteLink({href,children,reloadDocument,...props}){return <a href={href} {...props}>{children}</a>}`
									: args.path.includes('org-management')
										? `export async function loadOrgRepositories(){throw Error('Not used by rendering fixture')}`
										: `export function useMatchedPageScope(){return {actorKey:'jane'}}`,
					}))
				},
			},
		],
	})
	script = result.outputFiles[0]!.text
})
test.beforeEach(async ({ page }) => {
	await page.route('https://packages.test/**', (route) =>
		route.fulfill(
			new URL(route.request().url()).pathname === '/app.js'
				? { contentType: 'application/javascript', body: script }
				: {
						contentType: 'text/html',
						body: '<html><body><div id="root"></div><script src="/app.js"></script></body></html>',
					},
		),
	)
})
test('the explorer lists readable repositories and filters by name', async ({
	page,
}) => {
	await page.goto('https://packages.test/')
	await expect(
		page.getByRole('link', { name: 'Launch board', exact: true }),
	).toHaveAttribute(
		'href',
		'/@jane/-/files?collection=packages&repo=launch-board',
	)
	await expect(
		page.getByRole('link', { name: 'Plain repository', exact: true }),
	).toBeVisible()
	await expect(page.getByText('Invoke only', { exact: true })).toHaveCount(0)
	const search = page.getByRole('textbox', { name: 'Search' })
	await search.fill(' Notes ')
	await expect(
		page.getByRole('link', { name: 'Notes', exact: true }),
	).toBeVisible()
	await expect(
		page.getByRole('link', { name: 'Launch board', exact: true }),
	).toHaveCount(0)
	await search.fill('missing')
	await expect(page.getByRole('status')).toHaveText('No matching repositories.')
})

test('a failed permission refresh hides retained repository data and offers retry', async ({
	page,
}) => {
	await page.goto('https://packages.test/?revoked=true')
	await expect(page.getByRole('status')).toHaveText(
		'Could not load repositories.',
	)
	await expect(page.getByText('Launch board', { exact: true })).toHaveCount(0)
	await page.getByRole('button', { name: 'Try again' }).click()
	await expect(
		page.getByRole('link', { name: 'New repository', exact: true }),
	).toBeVisible()
})
