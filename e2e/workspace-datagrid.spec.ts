import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'
let script: string

test.beforeAll(async () => {
	const result = await build({
		stdin: {
			contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{RecordTable,RecordTableSearch}from'./packages/worker/start/pages/record-table.tsx';const rows=Array.from({length:5000},(_,i)=>({id:'item-'+i,href:'#'+i,values:{name:'File '+String(i).padStart(4,'0'),type:i%2?'Image':'Text',size:i},cells:{name:'File '+String(i).padStart(4,'0'),type:i%2?'Image':'Text',size:i}}));function App(){const compact=new URLSearchParams(location.search).has('compact');const[toolbar,setToolbar]=useState(null);const[state,setState]=useState({sorting:[{id:'name',desc:false}],columnFilters:[],globalFilter:'',pagination:{pageIndex:0,pageSize:25}});return <div style={{height:600,display:'flex',flexDirection:'column'}}>{compact&&<header ref={setToolbar} style={{height:36,display:'flex'}}/>}<RecordTable toolbarContainer={compact?toolbar:undefined} compactToolbar={compact} dense mode="none" ariaLabel="Files" rows={new URLSearchParams(location.search).has('natural')?[{id:'folder',values:{name:'Folder'},cells:{name:'Folder'}},...[[900,'2026-12-01'],[20,'2025-12-31'],[10000,'2026-01-02']].map(([size,date],i)=>({id:'natural-'+i,href:'#'+i,values:{name:'Natural '+i,size,updated:Date.parse(date)},cells:{name:'Natural '+i,size:size+' B',updated:date}}))]:rows} columns={[{key:'name',label:'Name',primary:true},{key:'type',label:'Type'},{key:'size',label:'Size',align:'end',sortType:'number'},{key:'updated',label:'Modified',sortType:'number'}]} toolbar={<RecordTableSearch variant={compact?'plain':undefined} label="Search files" placeholder="Search files" value={state.globalFilter} onInput={value=>setState(s=>({...s,globalFilter:value}))}/>} dataControls={{scrollMode:'virtual',visibilityKey:'test-files',state,onStateChange:patch=>setState(s=>({...s,...patch}))}}/></div>}createRoot(document.getElementById('root')).render(<App/>);`,
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
				name: 'site-link-stub',
				setup(builder) {
					builder.onResolve({ filter: /site-link\.tsx$/ }, (args) => ({
						path: args.path,
						namespace: 'stub',
					}))
					builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
						loader: 'tsx',
						resolveDir: process.cwd(),
						contents: `export function SiteLink({href,children,resetScroll,...props}){return <a href={href} {...props}>{children}</a>}`,
					}))
				},
			},
		],
	})
	script = result.outputFiles[0]!.text
})
test.beforeEach(async ({ page }) => {
	await page.route('https://datagrid.test/**', (route) =>
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
test('virtual table reaches every row without pagination and keeps sorting, search, and saved columns', async ({
	page,
}) => {
	await page.goto('https://datagrid.test/')
	await expect(
		page.getByRole('table', { name: 'Files', exact: true }),
	).toHaveAttribute('aria-rowcount', '5001')
	await expect
		.poll(() => page.locator('tbody tr[data-index]').count())
		.toBeLessThan(80)
	await expect(page.getByRole('button', { name: 'Next page' })).toHaveCount(0)
	await page.locator('[data-browser-item="item-0"]').press('End')
	await expect(page.locator('[data-browser-item="item-4999"]')).toBeFocused()
	await expect(page.locator('[data-browser-item="item-4999"]')).toBeInViewport({
		ratio: 1,
	})
	await expect
		.poll(() => page.locator('tbody tr[data-index]').count())
		.toBeLessThan(80)
	await page.getByRole('button', { name: 'Columns', exact: true }).click()
	await page.getByRole('checkbox', { name: 'Size', exact: true }).uncheck()
	await expect(
		page.getByRole('columnheader', { name: 'Size', exact: true }),
	).toHaveCount(0)
	await page.keyboard.press('Escape')
	await page.reload()
	await expect(
		page.getByRole('columnheader', { name: 'Size', exact: true }),
	).toHaveCount(0)
	await page.getByRole('button', { name: 'Name', exact: true }).click()
	await expect(
		page.getByRole('columnheader', { name: /Name/ }),
	).toHaveAttribute('aria-sort', 'descending')
	await page.getByRole('searchbox', { name: 'Search files' }).fill('File 4999')
	await expect(
		page.getByRole('table', { name: 'Files', exact: true }),
	).toHaveAttribute('aria-rowcount', '2')
	await expect(
		page.getByRole('link', { name: 'File 4999', exact: true }),
	).toBeVisible()
})

test('compact datagrid search and icon controls render in the supplied header', async ({
	page,
}) => {
	await page.goto('https://datagrid.test/?compact')
	const header = page.locator('header')
	const search = header.getByRole('searchbox', { name: 'Search files' })
	await expect(search).toBeVisible()
	await expect(search).toHaveCSS('border-top-width', '0px')
	await expect(search).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
	const columns = header.getByRole('button', { name: 'Columns', exact: true })
	await expect(columns).toHaveText('')
	await expect(columns.locator('svg')).toHaveCount(1)
	await search.fill('File 4999')
	await expect(
		page.getByRole('link', { name: 'File 4999', exact: true }),
	).toBeVisible()
	await columns.click()
	await expect(
		page.getByRole('checkbox', { name: 'Size', exact: true }),
	).toBeVisible()
	await expect(
		page
			.getByRole('region', { name: 'Files', exact: true })
			.getByRole('searchbox'),
	).toHaveCount(0)
})

test('sizes and dates sort by raw numbers even when the first row has no metadata', async ({
	page,
}) => {
	await page.goto('https://datagrid.test/?natural')
	const names = () => page.locator('tbody tr a').allTextContents()
	await page.getByRole('button', { name: /^Size/ }).click()
	await expect.poll(names).toEqual(['Natural 1', 'Natural 0', 'Natural 2'])
	await page.getByRole('button', { name: /^Size/ }).click()
	await expect.poll(names).toEqual(['Natural 2', 'Natural 0', 'Natural 1'])
	await page.getByRole('button', { name: /^Modified/ }).click()
	await expect.poll(names).toEqual(['Natural 1', 'Natural 2', 'Natural 0'])
	await page.getByRole('button', { name: /^Modified/ }).click()
	await expect.poll(names).toEqual(['Natural 0', 'Natural 2', 'Natural 1'])
})
