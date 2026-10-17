import { test, expect } from '@playwright/test'
import { buildSync } from 'esbuild'

for (const runtime of ['React', 'Redact'] as const) {
	test(`${runtime} does not render a departed match while its replacement suspends`, async ({
		page,
	}) => {
		const client = buildSync({
			stdin: {
				resolveDir: process.cwd(),
				contents: `
import {createElement as h} from 'react';
import {createRoot} from 'react-dom/client';
import {createRouter,createRootRoute,createRoute,createMemoryHistory,RouterProvider,Outlet} from '@tanstack/react-router';
window.caught=[];
const rootRoute=createRootRoute({component:()=>h(Outlet)});
const home=createRoute({getParentRoute:()=>rootRoute,path:'/',component:()=>h('p',{id:'home'},'Home')});
let ready=false, release;
const waiting=new Promise(resolve=>{release=()=>{ready=true;resolve()}});
window.release=()=>release();
const next=createRoute({getParentRoute:()=>rootRoute,path:'/next',component:()=>{if(!ready)throw waiting;return h('p',{id:'next'},'Next')}});
const router=createRouter({routeTree:rootRoute.addChildren([home,next]),history:createMemoryHistory({initialEntries:['/']}),defaultOnCatch:error=>window.caught.push(error.message)});
await router.load();
createRoot(document.getElementById('fixture'),{onCaughtError:error=>window.caught.push(error.message)}).render(h(RouterProvider,{router}));
window.go=()=>router.navigate({to:'/next'});
`,
			},
			alias:
				runtime === 'Redact'
					? {
							react: '@tanstack/redact',
							'react-dom/client': '@tanstack/redact/dom-client',
						}
					: {},
			bundle: true,
			write: false,
			format: 'esm',
			platform: 'browser',
		}).outputFiles![0]!.text
		await page.setContent('<div id="fixture"></div>')
		await page.addScriptTag({ content: client, type: 'module' })
		await expect(page.locator('#home')).toBeVisible()
		await page.evaluate('window.go()')
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
				),
		)
		expect(await page.evaluate('window.caught')).toEqual([])
		await page.evaluate('window.release()')
		await expect(page.locator('#next')).toBeVisible()
		await expect(page.locator('#home')).toHaveCount(0)
		expect(await page.evaluate('window.caught')).toEqual([])
	})
}
