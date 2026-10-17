import { test, expect } from '@playwright/test'
import { buildSync } from 'esbuild'

for (const runtime of ['Redact', 'React'] as const) {
	const reactPackage = runtime === 'React' ? 'react' : '@tanstack/redact'
	const domPackage =
		runtime === 'React' ? 'react-dom/client' : '@tanstack/redact/dom-client'
	for (const update of ['state', 'external-store', 'lazy-fallback'] as const) {
		test(`${runtime} replaces retained content when a ${update} update throws a not-found object`, async ({
			page,
		}) => {
			const errors: string[] = []
			page.on('pageerror', (error) => errors.push(error.message))
			const client = buildSync({
				stdin: {
					resolveDir: process.cwd(),
					contents: `
import {createElement as h,Component,Suspense,lazy,memo,useState,useSyncExternalStore,useLayoutEffect} from '${reactPackage}';
import {createRoot} from '${domPackage}';
let denied=false, setDenied;
const subscribers=new Set();
const subscribe=callback=>{subscribers.add(callback);return()=>subscribers.delete(callback)};
const snapshot=()=>denied;
window.catches=[];window.lifecycle=[];
class Boundary extends Component {
 state={error:0};
 static getDerivedStateFromProps(props,state){const resetKey=props.getResetKey();return state.error&&state.resetKey!==resetKey?{resetKey,error:0}:{resetKey}}
 static getDerivedStateFromError(error){return {error:[error]}}
 componentDidCatch(error){window.lifecycle.push('caught');window.catches.push(this.props.name);this.props.onCatch?.(error)}
 render(){return this.state.error?h(this.props.fallback,{error:this.state.error[0]}):this.props.children}
}

function Fallback({error}){useLayoutEffect(()=>{window.lifecycle.push('fallback-layout')},[]);if(!error.isNotFound)throw error;return h('p',{id:'denied'},'Not found')}
const LazyFallback=lazy(()=>new Promise(resolve=>{window.resolveFallback=()=>resolve({default:Fallback})}));
function GenericFallback({error}){throw error}
function Status(){const value=useSyncExternalStore(subscribe,snapshot,snapshot);return h('p',{id:'status'},value?'Denied':'Allowed')}
function Content(){const [state,setState]=useState(false);setDenied=setState;const external=useSyncExternalStore(subscribe,snapshot,snapshot);if(${JSON.stringify(update)}==='state'?state:external)throw {isNotFound:true};return h('article',{id:'private'},'Previously authorized content')}
const stableKey=()=>'/docs/admin-events-idle';
const StableContents=memo(()=>h(Content));
const Route=memo(()=>h(Boundary,{name:'outer',getResetKey:stableKey,fallback:GenericFallback},h(Boundary,{name:'not-found',getResetKey:stableKey,fallback:${JSON.stringify(update)}==='lazy-fallback'?LazyFallback:Fallback},h(StableContents))));
const root=createRoot(document.getElementById('fixture'),{onCaughtError(){}});
let revision=0;
window.rerender=()=>root.render(h('main',null,h(Status),h(Suspense,{fallback:h('p',{id:'pending'},'Loading denial')},h(Route,{revision:revision++}))));
window.rerender();
window.revoke=()=>{denied=true;for(const notify of subscribers)notify();if(${JSON.stringify(update)}==='state')setDenied(true)};
window.repeatRecovery=async()=>{window.resolveFallback?.();window.rerender();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))};
`,
				},
				bundle: true,
				write: false,
				format: 'iife',
				platform: 'browser',
			}).outputFiles[0]!.text
			await page.setContent('<div id="fixture"></div>')
			await page.addScriptTag({ content: client })
			await expect(page.locator('#private')).toBeVisible()
			await page.evaluate('window.revoke()')
			await expect(page.locator('#status')).toHaveText('Denied')
			if (update === 'lazy-fallback') {
				await expect(page.locator('#pending')).toBeVisible()
				await page.evaluate('window.resolveFallback()')
			}
			await expect(page.locator('#denied')).toHaveText('Not found')
			await expect(page.locator('#private')).toHaveCount(0)
			expect(await page.evaluate('window.catches')).toEqual(['not-found'])
			expect(await page.evaluate('window.lifecycle')).toEqual([
				'fallback-layout',
				'caught',
			])
			for (let attempt = 0; attempt < 2; attempt++) {
				await page.evaluate('window.repeatRecovery()')
				await expect(page.locator('#denied')).toHaveText('Not found')
				await expect(page.locator('#private')).toHaveCount(0)
				expect(await page.evaluate('window.catches')).toEqual(['not-found'])
				expect(await page.evaluate('window.lifecycle')).toEqual([
					'fallback-layout',
					'caught',
				])
			}
			expect(errors).toEqual([])
		})
	}

	for (const action of ['reset', 'state-reset', 'unmount'] as const) {
		test(`${runtime} can ${action} a route while its lazy error fallback is suspended`, async ({
			page,
		}) => {
			const errors: string[] = []
			page.on('pageerror', (error) => errors.push(error.message))
			const client = buildSync({
				stdin: {
					resolveDir: process.cwd(),
					contents: `
import {createElement as h,Component,Suspense,lazy,memo,useState,useSyncExternalStore} from '${reactPackage}';
import {createRoot} from '${domPackage}';
let denied=false, boundary;
const subscribers=new Set();
const subscribe=callback=>{subscribers.add(callback);return()=>subscribers.delete(callback)};
const snapshot=()=>denied;
window.catches=[];
class Boundary extends Component {
 state={error:0};
 static getDerivedStateFromProps(props,state){const resetKey=props.version;return state.error&&state.resetKey!==resetKey?{resetKey,error:0}:{resetKey}}
 static getDerivedStateFromError(error){return {error:[error]}}
 componentDidCatch(){window.catches.push('caught')}
 render(){return this.state.error?h(LazyFallback):this.props.children}
}
const LazyFallback=lazy(()=>new Promise(resolve=>{window.resolveFallback=()=>resolve({default:()=>h('p',{id:'denied'},'Not found')})}));
function Content(){if(useSyncExternalStore(subscribe,snapshot,snapshot))throw {isNotFound:true};return h('article',{id:'private'},'Authorized content')}
const rememberBoundary=instance=>{if(instance)boundary=instance};
const StableContents=memo(()=>h(Content));
const Route=memo(({version})=>h(Boundary,{version,ref:rememberBoundary},h(StableContents)));
function App(){const [version,setVersion]=useState(1);const [visible,setVisible]=useState(true);window.resetRoute=()=>{denied=false;for(const notify of subscribers)notify();setVersion(value=>value+1)};window.unmountRoute=()=>setVisible(false);return visible?h(Suspense,{fallback:h('p',{id:'pending'},'Loading denial')},h(Route,{version})):h('p',{id:'removed'},'Route removed')}
createRoot(document.getElementById('fixture'),{onCaughtError(){}}).render(h(App));
window.revoke=()=>{denied=true;for(const notify of subscribers)notify()};
window.resetBoundaryState=()=>{denied=false;for(const notify of subscribers)notify();boundary.setState({error:0})};
window.settleFallback=async()=>{window.resolveFallback();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))};
`,
				},
				bundle: true,
				write: false,
				format: 'iife',
				platform: 'browser',
			}).outputFiles[0]!.text
			await page.setContent('<div id="fixture"></div>')
			await page.addScriptTag({ content: client })
			await expect(page.locator('#private')).toBeVisible()
			await page.evaluate('window.revoke()')
			await expect(page.locator('#pending')).toBeVisible()
			await page.evaluate(
				action === 'reset'
					? 'window.resetRoute()'
					: action === 'state-reset'
						? 'window.resetBoundaryState()'
						: 'window.unmountRoute()',
			)
			if (action !== 'unmount') {
				await expect(page.locator('#private')).toBeVisible()
			} else {
				await expect(page.locator('#removed')).toBeVisible()
				await expect(page.locator('#private')).toHaveCount(0)
			}
			await expect(page.locator('#pending')).toHaveCount(0)
			await page.evaluate('window.settleFallback()')
			await expect(page.locator('#denied')).toHaveCount(0)
			await expect(page.locator('#pending')).toHaveCount(0)
			await expect(
				page.locator(action !== 'unmount' ? '#private' : '#removed'),
			).toBeVisible()
			expect(await page.evaluate('window.catches')).toEqual([])
			expect(errors).toEqual([])
		})
	}
}
