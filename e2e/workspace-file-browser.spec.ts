import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'
let script: string
const files = [
	{ id: 'a', name: 'Assets', mediaType: 'application/vnd.kody.directory' },
	{
		id: 'b',
		name: 'Brand',
		parentId: 'a',
		mediaType: 'application/vnd.kody.directory',
	},
	{ id: 'c', name: 'Mark.png', parentId: 'b', mediaType: 'image/png' },
	{ id: 'd', name: 'Notes.txt', mediaType: 'text/plain' },
	{
		id: 'empty',
		name: 'Empty folder',
		parentId: 'a',
		mediaType: 'application/vnd.kody.directory',
	},
]
test.beforeAll(async () => {
	const result = await build({
		stdin: {
			contents: `import React,{useState,useRef,useSyncExternalStore}from'react';import{createRoot}from'react-dom/client';import{WorkspaceFileBrowser,WorkspaceIconGrid,packagesFolder}from'./packages/worker/start/pages/workspace-file-browser.tsx';import{useFileItemHotkeys}from'./packages/worker/start/components/use-file-item-hotkeys.ts';import{workspaceUploadTarget}from'./packages/worker/start/components/workspace-upload-target.ts';import{WorkspaceGallery}from'./packages/worker/start/pages/workspace-gallery.tsx';import{WorkspaceViewControls,ThumbnailSizeControl}from'./packages/worker/start/pages/workspace-view-controls.tsx';const files=${JSON.stringify(files)}.concat(new URLSearchParams(location.search).has('large')?Array.from({length:5000},(_,index)=>({id:'large-'+index,name:'File '+index+'.txt',mediaType:'text/plain'})):[]).map(file=>({...file,revisionId:null,access:{write:true}}));function App(){const query=useSyncExternalStore(cb=>{window.addEventListener('popstate',cb);return()=>window.removeEventListener('popstate',cb)},()=>location.search);const params=new URLSearchParams(query);const active=params.get('active')??undefined;const track=params.has('history');const[size,setSize]=useState(132);const[view,setView]=useState(new URL(location.href).searchParams.has('icons')?'icons':'columns');const root=useRef(null);const[drop,setDrop]=useState('');const[action,setAction]=useState('');const[renaming,setRenaming]=useState(null);useFileItemHotkeys({target:root,onOpen:id=>setAction('open:'+id),onRename:id=>{setAction('rename:'+id);if(params.has('inline'))setRenaming(id)}});const props={files,orgSlug:'jane',renderIcon:()=>null};return <><input aria-label="Outside browser"/><output aria-label="File action">{action}</output><output aria-label="Drop destination">{drop}</output><div ref={root} style={{display:'flex',flexDirection:'column',height:700}} onDrop={event=>{event.preventDefault();const target=workspaceUploadTarget(event.target,files,'b');setDrop(target?target.id??'root':'blocked')}}><input aria-label="Browser search"/>{view==='icons'&&<ThumbnailSizeControl size={size} onChange={setSize}/>}<WorkspaceViewControls view={view} changeView={setView} browserRoot={root}/>{view==='icons'?<WorkspaceIconGrid {...props} thumbnailSize={size}/>:view==='gallery'?<WorkspaceGallery {...props} activeId={active} onSelect={id=>{if(track){const next=new URL(location.href);next.searchParams.set('active',id);history.pushState(null,'',next);dispatchEvent(new PopStateEvent('popstate'))}}} renderPreview={file=><p>Gallery content: {file.name}</p>}/>:view==='list'?<p>Detailed list content</p>:<WorkspaceFileBrowser {...props} systemFolder={params.has('packages')?packagesFolder:undefined} renamingId={renaming} onRenameDone={()=>setRenaming(null)} onCommitRename={async(id,name)=>{setAction('saved:'+id+':'+name);return true}} rootId={active==='root'?undefined:active??(params.has('nested')?'b':undefined)} selectionKey={track?active:undefined} onSelectionChange={track?(id)=>{const next=new URL(location.href);next.searchParams.set('active',id??'root');history.pushState(null,'',next);dispatchEvent(new PopStateEvent('popstate'))}:undefined} renderPreview={file=><p>Preview content: {file.name}</p>}/>}</div></>}createRoot(document.getElementById('root')).render(<App/>);`,
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
				name: 'browser-fixtures',
				setup(builder) {
					builder.onResolve(
						{ filter: /@tanstack\/react-router|site-link\.tsx$/ },
						(args) => ({ path: args.path, namespace: 'stub' }),
					)
					builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
						loader: 'tsx',
						resolveDir: process.cwd(),
						contents: args.path.includes('react-router')
							? `export function useRouter(){return{navigate:({href})=>location.href=href}}`
							: `export function SiteLink({href,children,...props}){return <a href={href} {...props}>{children}</a>}`,
					}))
				},
			},
		],
	})
	script = result.outputFiles[0]!.text
})
test.beforeEach(async ({ page }) => {
	await page.route('https://browser.test/**', (route) =>
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
test('columns show direct children, retain ancestors, and preview a selected file', async ({
	page,
}) => {
	await page.goto('https://browser.test/')
	const root = page.getByRole('navigation', {
		name: 'Workspace root',
		exact: true,
	})
	await expect(
		root.getByRole('link', { name: 'Brand', exact: true }),
	).toHaveCount(0)
	await root.getByRole('link', { name: 'Assets', exact: true }).click()
	await page
		.getByRole('navigation', { name: 'Assets', exact: true })
		.getByRole('link', { name: 'Brand', exact: true })
		.click()
	await page
		.getByRole('navigation', { name: 'Brand', exact: true })
		.getByRole('link', { name: 'Mark.png', exact: true })
		.click()
	await expect(
		page.getByRole('region', { name: 'Preview Mark.png', exact: true }),
	).toContainText('Preview content: Mark.png')
	await root.getByRole('link', { name: 'Notes.txt', exact: true }).click()
	await expect(
		page.getByRole('navigation', { name: 'Brand', exact: true }),
	).toHaveCount(0)
	await expect(
		page.getByRole('region', { name: 'Preview Notes.txt', exact: true }),
	).toBeVisible()
})
test('a nested folder opens with its ancestors and can switch to a root sibling', async ({
	page,
}) => {
	await page.goto('https://browser.test/?nested')
	await expect(
		page.getByRole('navigation', { name: 'Brand', exact: true }),
	).toBeVisible()
	await page
		.getByRole('navigation', { name: 'Workspace root', exact: true })
		.getByRole('link', { name: 'Notes.txt', exact: true })
		.click()
	await expect(
		page.getByRole('region', { name: 'Preview Notes.txt', exact: true }),
	).toBeVisible()
	await expect(
		page.getByRole('navigation', { name: 'Brand', exact: true }),
	).toHaveCount(0)
})

test('column keyboard navigation moves focus and selection without leaving the browser', async ({
	page,
}) => {
	await page.goto('https://browser.test/')
	const root = page.getByRole('navigation', {
		name: 'Workspace root',
		exact: true,
	})
	await root.getByRole('link', { name: 'Assets', exact: true }).focus()
	await page.keyboard.press('End')
	await expect(
		root.getByRole('link', { name: 'Notes.txt', exact: true }),
	).toBeFocused()
	await page.keyboard.press('Home')
	await expect(
		root.getByRole('link', { name: 'Assets', exact: true }),
	).toBeFocused()
	await page.keyboard.press('ArrowRight')
	await expect(
		page
			.getByRole('navigation', { name: 'Assets', exact: true })
			.getByRole('link', { name: 'Brand', exact: true }),
	).toBeFocused()
	await page.keyboard.press('ArrowLeft')
	await expect(
		root.getByRole('link', { name: 'Assets', exact: true }),
	).toBeFocused()
})
test('icon view supports arrow keys and one tab stop for file tiles', async ({
	page,
}) => {
	await page.goto('https://browser.test/?icons')
	const grid = page.getByLabel('Workspace icons')
	await grid.getByRole('link', { name: 'Assets', exact: true }).focus()
	await page.keyboard.press('ArrowRight')
	await expect(
		grid.getByRole('link', { name: 'Brand', exact: true }),
	).toBeFocused()
	await page.keyboard.press('End')
	await expect(
		grid.getByRole('link', { name: 'Empty folder', exact: true }),
	).toBeFocused()
	await expect(grid.locator('[data-browser-item][tabindex="0"]')).toHaveCount(1)
})

test('TanStack view shortcuts are scoped to the browser and ignore text inputs', async ({
	page,
}) => {
	await page.goto('https://browser.test/')
	const button = page.getByRole('button', { name: 'Columns', exact: true })
	await button.focus()
	const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
	await page.keyboard.press(`${mod}+Alt+2`)
	await expect(
		page.getByRole('button', { name: 'Icons', exact: true }),
	).toHaveAttribute('aria-pressed', 'true')
	await page.getByLabel('Browser search').focus()
	await page.keyboard.press(`${mod}+Alt+3`)
	await expect(
		page.getByRole('button', { name: 'Icons', exact: true }),
	).toHaveAttribute('aria-pressed', 'true')
	await page.getByLabel('Outside browser').focus()
	await page.keyboard.press(`${mod}+Alt+1`)
	await expect(
		page.getByRole('button', { name: 'Icons', exact: true }),
	).toHaveAttribute('aria-pressed', 'true')
	await button.focus()
	await page.keyboard.press(`${mod}+Alt+3`)
	await expect(page.getByText('Detailed list content')).toBeVisible()
	await button.focus()
	await page.keyboard.press(`${mod}+Alt+4`)
	await expect(
		page.getByRole('button', { name: 'Gallery', exact: true }),
	).toHaveAttribute('aria-pressed', 'true')
})

test('one right arrow selects the next column and displays its children', async ({
	page,
}) => {
	await page.goto('https://browser.test/')
	const root = page.getByRole('navigation', {
		name: 'Workspace root',
		exact: true,
	})
	await root.getByRole('link', { name: 'Assets', exact: true }).focus()
	await page.keyboard.press('ArrowRight')
	const brand = page
		.getByRole('navigation', { name: 'Assets', exact: true })
		.getByRole('link', { name: 'Brand', exact: true })
	await expect(brand).toBeFocused()
	await expect(brand).toHaveAttribute('aria-current', 'true')
	await expect(
		page
			.getByRole('navigation', { name: 'Brand', exact: true })
			.getByRole('link', { name: 'Mark.png', exact: true }),
	).toBeVisible()
	await expect(brand).toHaveCSS('outline-style', 'none')
})
test('empty folders have previews and a blank column selects its parent', async ({
	page,
}) => {
	await page.goto('https://browser.test/')
	await page
		.getByRole('navigation', { name: 'Workspace root', exact: true })
		.getByRole('link', { name: 'Assets', exact: true })
		.click()
	await page
		.getByRole('navigation', { name: 'Assets', exact: true })
		.getByRole('link', { name: 'Empty folder', exact: true })
		.click()
	await expect(
		page.getByRole('region', { name: 'Preview Empty folder', exact: true }),
	).toContainText('This folder is empty')
	await expect(
		page.getByRole('navigation', { name: 'Empty folder', exact: true }),
	).toHaveCount(0)
	const assets = page.getByRole('navigation', { name: 'Assets', exact: true })
	await assets.click({ position: { x: 20, y: 200 } })
	await expect(
		page.getByRole('navigation', { name: 'Empty folder', exact: true }),
	).toHaveCount(0)
	await expect(
		page
			.getByRole('navigation', { name: 'Workspace root', exact: true })
			.getByRole('link', { name: 'Assets', exact: true }),
	).toHaveAttribute('aria-current', 'true')
})

test('blank root space restores root keyboard navigation', async ({ page }) => {
	await page.goto('https://browser.test/')
	const root = page.getByRole('navigation', {
		name: 'Workspace root',
		exact: true,
	})
	await root.getByRole('link', { name: 'Assets', exact: true }).click()
	await root.click({ position: { x: 20, y: 250 } })
	await expect(root).toBeFocused()
	await expect(
		page.getByRole('navigation', { name: 'Assets', exact: true }),
	).toHaveCount(0)
	await page.keyboard.press('ArrowDown')
	await expect(
		root.getByRole('link', { name: 'Assets', exact: true }),
	).toBeFocused()
	await expect(
		page.getByRole('navigation', { name: 'Assets', exact: true }),
	).toBeVisible()
})

test('uploads target the nearest column, folder, file parent, and explicit root', async ({
	page,
}) => {
	await page.goto('https://browser.test/?packages')
	const destination = page.getByLabel('Drop destination')
	async function drop(selector: string) {
		await page.locator(selector).dispatchEvent('drop', {
			dataTransfer: await page.evaluateHandle(() => {
				const transfer = new DataTransfer()
				transfer.items.add(new File(['fixture'], 'drop.txt'))
				return transfer
			}),
		})
	}
	await drop('nav[aria-label="Workspace root"]')
	await expect(destination).toHaveText('root')
	await drop('[data-workspace-item="a"]')
	await expect(destination).toHaveText('a')
	await page.locator('[data-workspace-item="a"]').click()
	await drop('nav[aria-label="Assets"]')
	await expect(destination).toHaveText('a')
	await drop('[data-workspace-item="empty"]')
	await expect(destination).toHaveText('empty')
	await page.locator('[data-workspace-item="b"]').click()
	await drop('[data-workspace-item="c"]')
	await expect(destination).toHaveText('b')
	await drop('[data-system-directory="packages"]')
	await expect(destination).toHaveText('blocked')
})

test('active file survives reload and browser history restores the selected columns', async ({
	page,
}) => {
	await page.goto('https://browser.test/?history')
	await page.locator('[data-workspace-item="a"]').click()
	await expect(page).toHaveURL(/active=a/)
	await page.locator('[data-workspace-item="b"]').click()
	await page.locator('[data-workspace-item="c"]').click()
	await expect(page).toHaveURL(/active=c/)
	await page.reload()
	await expect(
		page.getByRole('region', { name: 'Preview Mark.png' }),
	).toBeVisible()
	await expect(
		page.locator('[data-workspace-item="c"]').first(),
	).toHaveAttribute('aria-current', 'true')
	await page.goBack()
	await expect(page).toHaveURL(/active=b/)
	await expect(
		page.locator('[data-workspace-item="b"]').first(),
	).toHaveAttribute('aria-current', 'true')
	await page.goForward()
	await expect(
		page.getByRole('region', { name: 'Preview Mark.png' }),
	).toBeVisible()
	await page
		.locator('nav[aria-label="Workspace root"]')
		.click({ position: { x: 100, y: 400 } })
	await expect(page).toHaveURL(/active=root/)
	await page.reload()
	await expect(page.getByRole('navigation')).toHaveCount(1)
})

test('focused file shortcuts open or rename without hijacking text inputs', async ({
	page,
}) => {
	await page.goto('https://browser.test/')
	const item = page.locator('[data-browser-item="d"]')
	const action = page.getByLabel('File action')
	await item.focus()
	await item.press('Enter')
	await expect(action).toHaveText('rename:d')
	await item.press('Space')
	await expect(action).toHaveText('open:d')
	await item.press('Enter')
	await item.press('ControlOrMeta+o')
	await expect(action).toHaveText('open:d')
	await item.press('Enter')
	await item.press('ControlOrMeta+ArrowDown')
	await expect(action).toHaveText('open:d')
	await page.getByLabel('Browser search').fill('hello')
	await page.getByLabel('Browser search').press('Enter')
	await expect(action).toHaveText('open:d')
	await page.getByLabel('Browser search').press('Space')
	await expect(page.getByLabel('Browser search')).toHaveValue('hello ')
})

test('column rename edits inline, saves on Enter, and cancels on Escape', async ({
	page,
}) => {
	await page.goto('https://browser.test/?inline')
	const item = page.locator('[data-browser-item="d"]')
	await item.focus()
	await item.press('Enter')
	const input = page.getByRole('textbox', { name: 'Rename file' })
	await expect(input).toBeFocused()
	await input.fill('Updated.txt')
	await input.press('Enter')
	await expect(input).toHaveCount(0)
	await expect(page.getByLabel('File action')).toHaveText('saved:d:Updated.txt')
	await item.press('Enter')
	await input.fill('Canceled.txt')
	await input.press('Escape')
	await expect(input).toHaveCount(0)
	await expect(page.getByLabel('File action')).toHaveText('rename:d')
	await item.press('Enter')
	await input.fill('')
	await input.press('Enter')
	await expect(page.getByRole('alert')).toHaveText('Enter a name')
})

test('large column and icon views window their DOM and reach unloaded items by keyboard', async ({
	page,
}) => {
	await page.goto('https://browser.test/?large')
	await expect
		.poll(() => page.locator('[data-browser-item]').count())
		.toBeLessThan(100)
	await page.locator('[data-browser-item="a"]').press('End')
	await expect(page.locator('[data-browser-item="large-4999"]')).toBeFocused()
	await expect
		.poll(() => page.locator('[data-browser-item]').count())
		.toBeLessThan(100)
	await page.getByRole('button', { name: 'Icons', exact: true }).click()
	await page.locator('[data-browser-item="a"]').press('End')
	await expect(page.locator('[data-browser-item="large-4999"]')).toBeFocused()
	await expect
		.poll(() => page.locator('[data-browser-item]').count())
		.toBeLessThan(200)
	await page.setViewportSize({ width: 440, height: 800 })
	await expect(page.locator('[data-browser-item="large-4999"]')).toBeFocused()
	await page.locator('[data-browser-item="large-4999"]').press('Home')
	await expect(page.locator('[data-browser-item="a"]')).toBeFocused()
})

test('thumbnail size changes virtual grid density without losing keyboard access', async ({
	page,
}) => {
	await page.goto('https://browser.test/?icons&large')
	const slider = page.getByRole('slider', { name: 'Thumbnail size' })
	await slider.focus()
	await slider.press('End')
	await expect(slider).toHaveValue('220')
	await page.locator('[data-browser-item="a"]').press('End')
	await expect(page.locator('[data-browser-item="large-4999"]')).toBeFocused()
	await expect
		.poll(() => page.locator('[data-browser-item]').count())
		.toBeLessThan(150)
	const focusedItem = await page
		.locator('[data-browser-item="large-4999"]')
		.elementHandle()
	const previousWidth = (await focusedItem!.boundingBox())!.width
	await slider.press('Home')
	await expect(slider).toHaveValue('84')
	await expect
		.poll(
			async () =>
				(await page.locator('[data-browser-item="large-4999"]').boundingBox())
					?.width ?? Infinity,
		)
		.toBeLessThan(previousWidth)
	// Resizing must move the existing item, not remount its focused link.
	expect(await focusedItem!.evaluate((item) => item.isConnected)).toBe(true)
	await page.locator('[data-browser-item="large-4999"]').press('Home')
	await expect(page.locator('[data-browser-item="a"]')).toBeFocused()
})
test('gallery filmstrip restores selection, virtualizes, and supports horizontal keyboard navigation', async ({
	page,
}) => {
	await page.goto('https://browser.test/?history&large&active=d')
	await page.getByRole('button', { name: 'Gallery', exact: true }).click()
	await expect(
		page.getByText('Gallery content: Notes.txt', { exact: true }),
	).toBeVisible()
	const strip = page.getByRole('group', { name: 'Gallery filmstrip' })
	await strip
		.getByRole('button', { name: 'Notes.txt', exact: true })
		.press('End')
	await expect(
		strip.getByRole('button', { name: 'File 4999.txt', exact: true }),
	).toBeFocused()
	await expect(page).toHaveURL(/active=large-4999/)
	await expect
		.poll(() => strip.locator('[data-browser-item]').count())
		.toBeLessThan(50)
	await page.setViewportSize({ width: 440, height: 800 })
	await expect(
		strip.getByRole('button', { name: 'File 4999.txt', exact: true }),
	).toBeInViewport({ ratio: 1 })
	await strip
		.getByRole('button', { name: 'File 4999.txt', exact: true })
		.press('ArrowLeft')
	await expect(
		page.getByText('Gallery content: File 4998.txt', { exact: true }),
	).toBeVisible()
	await page.goBack()
	await expect(page).toHaveURL(/active=large-4999/)
	await expect(
		page.getByText('Gallery content: File 4999.txt', { exact: true }),
	).toBeVisible()
})

test('filmstrip virtualizes horizontal pointer scrolling through thousands of files', async ({
	page,
}) => {
	await page.goto('https://browser.test/?history&large&active=d')
	await page.getByRole('button', { name: 'Gallery', exact: true }).click()
	const strip = page.getByRole('group', { name: 'Gallery filmstrip' })
	const items = strip.locator('[data-browser-item]')
	await expect(
		strip.getByRole('button', { name: 'File 0.txt', exact: true }),
	).toBeAttached()
	await strip.hover()
	await page.mouse.wheel(10000, 0)
	await expect
		.poll(() => strip.evaluate((element) => element.scrollLeft))
		.toBeGreaterThan(5000)
	await expect(
		strip.getByRole('button', { name: 'File 0.txt', exact: true }),
	).toHaveCount(0)
	await expect.poll(() => items.count()).toBeLessThan(50)
	await expect.poll(() => items.count()).toBeGreaterThan(5)
	await expect(
		strip.getByRole('button', { name: 'Notes.txt', exact: true }),
	).toHaveAttribute('aria-pressed', 'true')
	await page.mouse.wheel(1000000, 0)
	await expect(
		strip.getByRole('button', { name: 'File 4999.txt', exact: true }),
	).toBeInViewport()
	await expect.poll(() => items.count()).toBeLessThan(50)
})
