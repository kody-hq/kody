import { test, expect } from '@playwright/test'
import { build } from 'esbuild'
import { resolve } from 'node:path'
let script: string
const stubs: Record<string, string> = {
	'workspace-uploads.tsx': `export function WorkspaceUploads({children}){return children}`,
	'@tanstack/react-router': `export function useMatches(){return[{staticData:{navigation:{item:'files'}}}]}export function Outlet(){return <section data-testid="content" style={{height:'100vh',flex:1}}>Content</section>}`,
	'__root.tsx': `export function useShellData(){return {session:{username:'jane',email:'jane@example.com',roles:[],organizations:[],featureFlags:{}}}}`,
	'workspace-layout-policy.ts': `export function workspaceLayoutNavigation(){return {rail:'workspace'}}`,
	'account-management-components.tsx': `export function ShellWorkspaceSwitcher(){return <div style={{height:48,padding:'0 16px'}}><span>J</span><span data-rail-label>@jane</span></div>}export function ShellNavigation(){return <nav data-account-nav><a href="#" style={{display:'flex',alignItems:'center',gap:8,padding:'8px 12px'}}><svg data-testid="rail-icon" width="16" height="16"><path d="M0 0h16v16H0z"/></svg><span data-rail-label>Overview</span></a></nav>}`,
	'account-management-link-nav.tsx': `export const accountManagementNarrowMq='@media(max-width:600px)'`,
	'brand-context-menu.tsx': `export function BrandContextMenu({children}){return children}`,
	'demo-indicator.tsx': `export function DemoIndicator(){return null}`,
	'org-switcher.tsx': `export function AccountMenu(){return <button aria-label="Account">J</button>}`,
	'site-link.tsx': `export function SiteLink({href,children,...props}){return <a href={href} {...props}>{children}</a>}`,
}
test.beforeAll(async () => {
	const result = await build({
		stdin: {
			contents: `import React from'react';import{createRoot}from'react-dom/client';import{WorkspaceLayout}from'./packages/worker/start/components/workspace-layout.tsx';import{WorkspaceExplorerLayout}from'./packages/worker/start/components/workspace-explorer-layout.tsx';const sidebar=<><div style={{display:'flex',alignItems:'center',padding:'2px 0',height:28,boxSizing:'content-box'}}><button style={{height:28}}>Files</button></div><input aria-label="Find files"/><a href="#">Launch</a></>;createRoot(document.getElementById('root')).render(new URL(location.href).searchParams.has('outer')?<WorkspaceLayout/>:<div style={{height:'100vh',display:'flex'}}><WorkspaceExplorerLayout sidebar={sidebar}>{toggle=><section aria-label="Document" style={{padding:'10px 32px',flex:1}}><div data-workspace-toolbar><button aria-label="Share" style={{height:28,border:0}}>Share</button>{toggle}</div>Content</section>}</WorkspaceExplorerLayout></div>);`,
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
				name: 'sidebar-fixtures',
				setup(builder) {
					builder.onResolve(
						{
							filter:
								/^(?:@tanstack\/react-router)$|(?:__root\.tsx|workspace-layout-policy\.ts|account-management-components\.tsx|account-management-link-nav\.tsx|workspace-uploads\.tsx|brand-context-menu\.tsx|demo-indicator\.tsx|org-switcher\.tsx|site-link\.tsx)$/,
						},
						(args) => ({ path: args.path, namespace: 'stub' }),
					)
					builder.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
						loader: 'tsx',
						resolveDir: process.cwd(),
						contents: stubs[args.path] ?? stubs[args.path.split('/').at(-1)!],
					}))
				},
			},
		],
	})
	script = result.outputFiles[0]!.text
})
test.beforeEach(async ({ page }) => {
	await page.route('https://sidebars.test/**', (route) =>
		route.fulfill(
			new URL(route.request().url()).pathname === '/app.js'
				? { contentType: 'application/javascript', body: script }
				: {
						contentType: 'text/html',
						body: '<!doctype html><html><head><style>body{margin:0;font:14px system-ui}button{font:inherit}</style></head><body><div id="root"></div><script src="/app.js"></script></body></html>',
					},
		),
	)
})
test('file explorer resizes within limits, persists, and reveals over full-width content', async ({
	page,
}) => {
	await page.goto('https://sidebars.test/')
	const separator = page.getByRole('separator', {
		name: 'Resize file explorer',
	})
	await expect(separator).toHaveAttribute('aria-valuenow', '232')
	await separator.press('End')
	await expect(separator).toHaveAttribute('aria-valuenow', '360')
	await separator.press('Home')
	await expect(separator).toHaveAttribute('aria-valuenow', '180')
	const box = (await separator.boundingBox())!
	await page.mouse.move(box.x + 3, box.y + 100)
	await page.mouse.down()
	await page.mouse.move(box.x + 700, box.y + 100)
	await page.mouse.up()
	await expect(separator).toHaveAttribute('aria-valuenow', '360')
	await page
		.getByRole('button', { name: 'Hide file explorer', exact: true })
		.click()
	await expect(
		page.getByRole('complementary', { name: 'File explorer' }),
	).toBeHidden()
	await expect
		.poll(
			async () =>
				(await page.getByRole('region', { name: 'Document' }).boundingBox())!.x,
		)
		.toBe(0)
	await page
		.getByRole('button', { name: 'Show file explorer', exact: true })
		.click()
	const panel = page.getByRole('complementary', { name: 'File explorer' })
	await expect(panel).toBeVisible()
	await expect(panel).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
	expect(
		(await page.getByRole('region', { name: 'Document' }).boundingBox())!.x,
	).toBe(0)
	const pin = (await page
			.getByRole('button', { name: 'Keep file explorer open' })
			.boundingBox())!,
		share = (await page
			.getByRole('button', { name: 'Share', exact: true })
			.boundingBox())!
	expect(
		Math.abs(pin.y + pin.height / 2 - share.y - share.height / 2),
	).toBeLessThan(1)
	await page.getByRole('textbox', { name: 'Find files' }).focus()
	await page.keyboard.press('Escape')
	await expect(panel).toBeHidden()
	await page.reload()
	await expect(
		page.getByRole('button', { name: 'Show file explorer' }),
	).toBeVisible()
	await page.getByRole('button', { name: 'Show file explorer' }).click()
	await page.getByRole('button', { name: 'Keep file explorer open' }).click()
	await expect(
		page.getByRole('separator', { name: 'Resize file explorer' }),
	).toHaveAttribute('aria-valuenow', '360')
	await page.reload()
	await expect(
		page.getByRole('button', { name: 'Hide file explorer' }),
	).toBeVisible()
})
test('compact workspace rail centers its icons and uses 150ms/300ms hover intent', async ({
	page,
}) => {
	await page.clock.install({ time: new Date('2026-11-05T12:00:00Z') })
	await page.goto('https://sidebars.test/?outer')
	await page.clock.pauseAt(new Date('2026-11-05T12:00:10Z'))
	const rail = page.getByRole('complementary', {
			name: 'Workspace navigation',
		}),
		icon = page.getByTestId('rail-icon')
	const before = (await icon.boundingBox())!
	const bar = page.getByRole('group', { name: 'Sidebar mode' })
	const pinnedBar = (await bar.boundingBox())!
	await page.getByRole('button', { name: 'Hide sidebar' }).click()
	await page.mouse.move(900, 300)
	await expect(rail).toHaveCSS('width', '52px')
	await expect(page.getByRole('group', { name: 'Sidebar mode' })).toBeHidden()
	const after = (await icon.boundingBox())!
	expect(after.x).toBeCloseTo(before.x - 8, 1)
	await expect(page.getByText('Overview', { exact: true })).toHaveCSS(
		'opacity',
		'0',
	)
	await page.mouse.move(30, 150)
	await page.clock.runFor(149)
	await expect(rail).not.toHaveAttribute('data-rail-expanded', 'true')
	await page.clock.runFor(1)
	await expect(rail).toHaveAttribute('data-rail-expanded', 'true')
	await expect(page.getByRole('group', { name: 'Sidebar mode' })).toBeVisible()
	const floatingBar = (await bar.boundingBox())!
	expect(floatingBar.x).toBeCloseTo(pinnedBar.x, 1)
	expect(floatingBar.width).toBeCloseTo(pinnedBar.width, 1)
	expect((await page.getByTestId('content').boundingBox())!.x).toBe(52)
	await page.mouse.move(900, 300)
	await page.clock.runFor(299)
	await expect(rail).toHaveAttribute('data-rail-expanded', 'true')
	await page.clock.runFor(1)
	await expect(rail).not.toHaveAttribute('data-rail-expanded', 'true')
	await page.emulateMedia({ reducedMotion: 'reduce' })
	await expect(rail).toHaveCSS('transition-duration', '0s')
	await page.reload()
	await expect(rail).toHaveAttribute('data-rail-compact', 'true')
	await page.setViewportSize({ width: 500, height: 900 })
	await expect(page.getByText('Overview', { exact: true })).toHaveCSS(
		'opacity',
		'1',
	)
})

test('sidebar modes persist and Keep open overrides responsive collapse', async ({
	page,
}) => {
	await page.goto('https://sidebars.test/?outer')
	const rail = page.getByRole('complementary', { name: 'Workspace navigation' })
	const lock = page.getByRole('button', { name: 'Keep sidebar open' })
	await lock.click()
	await expect(lock).toHaveAttribute('aria-pressed', 'true')
	await page.setViewportSize({ width: 900, height: 900 })
	await expect(rail).not.toHaveAttribute('data-rail-compact', 'true')
	await page.reload()
	await expect(rail).not.toHaveAttribute('data-rail-compact', 'true')
	await page.getByRole('button', { name: 'Automatic sidebar' }).click()
	await page.mouse.move(700, 300)
	await expect(rail).toHaveAttribute('data-rail-compact', 'true')
	await page.setViewportSize({ width: 1280, height: 900 })
	await expect(rail).not.toHaveAttribute('data-rail-compact', 'true')
})

test('responsive collapse restores the wide-window preferences', async ({
	page,
}) => {
	await page.goto('https://sidebars.test/?outer')
	const rail = page.getByRole('complementary', { name: 'Workspace navigation' })
	await expect(rail).not.toHaveAttribute('data-rail-compact', 'true')
	await page.setViewportSize({ width: 1100, height: 900 })
	await expect(rail).toHaveAttribute('data-rail-compact', 'true')
	await page.setViewportSize({ width: 1280, height: 900 })
	await expect(rail).not.toHaveAttribute('data-rail-compact', 'true')
	await page.goto('https://sidebars.test/')
	await expect(
		page.getByRole('button', { name: 'Hide file explorer' }),
	).toBeVisible()
	await page.setViewportSize({ width: 850, height: 900 })
	await expect(
		page.getByRole('button', { name: 'Show file explorer' }),
	).toBeVisible()
	await page.setViewportSize({ width: 1280, height: 900 })
	await expect(
		page.getByRole('button', { name: 'Hide file explorer' }),
	).toBeVisible()
})

test('responsive sidebar hydrates at a narrow width with the app renderer', async ({
	page,
}) => {
	const result = await build({
		stdin: {
			contents: `import React from'react';import{hydrateRoot}from'react-dom/client';import'@tanstack/redact/_all';import{useResponsiveSidebar}from'./packages/worker/start/components/use-responsive-sidebar.ts';function Probe(){const{collapsed}=useResponsiveSidebar(false,'(max-width:1200px)');return <div data-testid="compact">{String(collapsed)}</div>}hydrateRoot(document.getElementById('root'),<Probe/>);`,
			resolveDir: process.cwd(),
			loader: 'tsx',
		},
		bundle: true,
		write: false,
		platform: 'browser',
		format: 'iife',
		jsx: 'automatic',
		alias: {
			'react/jsx-runtime': '@tanstack/redact/jsx-runtime',
			react: '@tanstack/redact',
			'react-dom/client': '@tanstack/redact/dom-client',
		},
		define: { 'process.env.NODE_ENV': '"development"' },
	})
	const errors: string[] = []
	page.on('pageerror', (error) => errors.push(error.message))
	await page.route('https://sidebar-hydration.test/**', (route) =>
		route.fulfill(
			new URL(route.request().url()).pathname === '/app.js'
				? {
						contentType: 'application/javascript',
						body: result.outputFiles[0]!.text,
					}
				: {
						contentType: 'text/html',
						body: '<!doctype html><html><body><div id="root"><div data-testid="compact">false</div></div><script src="/app.js"></script></body></html>',
					},
		),
	)
	await page.setViewportSize({ width: 850, height: 900 })
	await page.goto('https://sidebar-hydration.test/')
	await expect(page.getByTestId('compact')).toHaveText('true')
	expect(errors).toEqual([])
})

test('saved sidebar preferences are present in server markup and survive hydration', async ({
	page,
}) => {
	const result = await build({
		stdin: {
			contents: `import React from'react';import{renderToString}from'react-dom/server';import{hydrateRoot}from'react-dom/client';import{SidebarPreferencesProvider}from'./packages/worker/start/components/sidebar-preferences.tsx';import{parseSidebarPreferences}from'./packages/worker/universal/sidebar-preferences.ts';import{useWorkspaceRail}from'./packages/worker/start/components/use-workspace-rail.ts';import{WorkspaceExplorerLayout}from'./packages/worker/start/components/workspace-explorer-layout.tsx';const initial=parseSidebarPreferences(document.cookie);function Probe(){const rail=useWorkspaceRail();return <div data-testid="rail" data-compact={rail.compact}><WorkspaceExplorerLayout sidebar={<span>Files</span>}>{()=><section aria-label="Document">Content</section>}</WorkspaceExplorerLayout></div>}const app=<SidebarPreferencesProvider value={initial}><Probe/></SidebarPreferencesProvider>;const root=document.getElementById('root');root.innerHTML=renderToString(app);window.initialSidebar={compact:root.querySelector('[data-testid=rail]').dataset.compact,width:root.querySelector('[role=separator]').getAttribute('aria-valuenow')};hydrateRoot(root,app);`,
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
	})
	await page.context().addCookies([
		{
			name: 'kody-sidebar',
			value: encodeURIComponent(
				JSON.stringify({
					mode: 'compact',
					explorer: { width: 310, hidden: false },
					viewport: 1400,
				}),
			),
			url: 'https://saved-sidebars.test/',
		},
	])
	const errors: string[] = []
	page.on('pageerror', (error) => errors.push(error.message))
	await page.route('https://saved-sidebars.test/**', (route) =>
		route.fulfill(
			new URL(route.request().url()).pathname === '/app.js'
				? {
						contentType: 'application/javascript',
						body: result.outputFiles[0]!.text,
					}
				: {
						contentType: 'text/html',
						body: '<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>',
					},
		),
	)
	await page.setViewportSize({ width: 1400, height: 900 })
	await page.goto('https://saved-sidebars.test/')
	expect(
		await page.evaluate(
			() =>
				(
					window as unknown as {
						initialSidebar: { compact: string; width: string }
					}
				).initialSidebar,
		),
	).toEqual({
		compact: 'true',
		width: '310',
	})
	await expect(page.getByTestId('rail')).toHaveAttribute('data-compact', 'true')
	await expect(page.getByRole('separator')).toHaveAttribute(
		'aria-valuenow',
		'310',
	)
	expect(errors).toEqual([])
})
