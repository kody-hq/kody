import { test, expect } from '@playwright/test'
import { buildSync } from 'esbuild'

for (const runtime of ['React', 'Redact'] as const) {
	test(`${runtime} retains filter controls while Query fetches and reuses cached results`, async ({
		page,
	}) => {
		const client = buildSync({
			stdin: {
				resolveDir: process.cwd(),
				contents: `
import {createElement as h} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {createRouter,createRootRoute,createRoute,createMemoryHistory,RouterProvider,Outlet} from '@tanstack/react-router';
import {createPageQuery,loadPageQuery,useFilteredPageQuery} from './packages/worker/start/page-query.ts';
import {isPresentationNavigation} from './packages/worker/start/presentation-navigation.ts';
import {RecordTableSearch} from './packages/worker/start/pages/record-table-controls.tsx';
const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
window.reads=[];window.loads=0;window.checks=0;
let release;const slow=new Promise(resolve=>{release=()=>resolve({rows:['slow result']})});window.release=()=>release();
const query=createPageQuery('list',async ({data})=>{window.reads.push(data.q);return data.q==='slow'?slow:{rows:[data.q||'initial']}});
let router;
const root=createRootRoute({beforeLoad:({location,matches})=>{
 const inPlaceNavigation=isPresentationNavigation({committed:router.state.resolvedLocation?{location:router.state.resolvedLocation,matches:router.state.matches}:null,location,matches,actorKey:'actor'});
 if(!inPlaceNavigation)window.checks++;
 return {actorKey:'actor',pageLocation:location,inPlaceNavigation};
},component:()=>h(Outlet)});
const list=createRoute({getParentRoute:()=>root,path:'/',staticData:{filterSearchKeys:['q']},validateSearch:s=>({q:typeof s.q==='string'?s.q:''}),beforeLoad:({search})=>({input:{q:search.q}}),shouldReload:({context})=>!context.inPlaceNavigation,loader:({context,preload})=>{window.loads++;return loadPageQuery(client,query(context.actorKey,context.input),preload)},component:()=>{
 const {actorKey,input}=list.useRouteContext();
 const result=useFilteredPageQuery(query(actorKey,input),[actorKey,'list']);
 if(!result.data)return null;
 return h('section',null,h(RecordTableSearch,{label:'Search',placeholder:'Search',value:input.q,onInput:q=>router.navigate({to:'/',search:{q},replace:true})}),h('p',{id:'rows'},result.data.rows.join(',')));
}});
router=createRouter({routeTree:root.addChildren([list]),history:createMemoryHistory({initialEntries:['/']}),context:{},defaultStaleReloadMode:'blocking'});
await router.load();
createRoot(document.getElementById('fixture')).render(h(QueryClientProvider,{client},h(RouterProvider,{router})));
window.go=q=>router.navigate({to:'/',search:{q},replace:true});
`,
			},
			alias:
				runtime === 'Redact'
					? {
							react: '@tanstack/redact',
							'react-dom/client': '@tanstack/redact/dom-client',
						}
					: {},
			jsx: 'automatic',
			bundle: true,
			write: false,
			format: 'esm',
			platform: 'browser',
		}).outputFiles![0]!.text
		await page.setContent('<div id="fixture"></div>')
		await page.addScriptTag({ content: client, type: 'module' })
		const search = page.getByRole('searchbox', { name: 'Search', exact: true })
		await expect(page.locator('#rows')).toHaveText('initial')
		await search.evaluate((element) =>
			element.setAttribute('data-original', 'yes'),
		)
		await search.fill('slow')
		await expect.poll(() => page.evaluate('window.reads')).toEqual(['', 'slow'])
		await expect(search).toHaveValue('slow')
		await expect(search).toBeFocused()
		await expect(search).toHaveAttribute('data-original', 'yes')
		await expect(page.locator('#rows')).toHaveText('initial')
		expect(await page.evaluate('window.loads')).toBe(1)
		expect(await page.evaluate('window.checks')).toBe(1)
		await page.evaluate('window.release()')
		await expect(page.locator('#rows')).toHaveText('slow result')
		await page.evaluate('window.go("")')
		await expect(page.locator('#rows')).toHaveText('initial')
		expect(await page.evaluate('window.reads')).toEqual(['', 'slow'])
		await expect(search).toHaveAttribute('data-original', 'yes')
	})
}
