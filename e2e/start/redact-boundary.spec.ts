import { test, expect } from '@playwright/test'
import { buildSync } from 'esbuild'

const client = buildSync({
	stdin: {
		resolveDir: process.cwd(),
		contents: `
import {createElement as h,Component,Suspense} from '@tanstack/redact';
import {createRoot} from '@tanstack/redact/dom-client';
window.catches=[];
let failing=true, outer, pending=null, ready=false;
class Boundary extends Component {
 state={error:null};
 static getDerivedStateFromError(error){return {error}}
 componentDidCatch(error){window.catches.push([this.props.name,error.message])}
 render(){return this.state.error?h(this.props.fallback,{error:this.state.error}):this.props.children}
}
function Throw(){if(failing)throw new Error('original failure');return h('p',{id:'healthy'},'Healthy')}
function Rethrow({error}){throw error}
function Recovered({error}){return h('p',{id:'recovered'},error.message)}
function WaitingFallback({error}){if(!ready)throw pending;return h('p',{id:'resolved'},error.message)}
const root=createRoot(document.getElementById('fixture'),{onCaughtError(){}});
function tree(){return h(Boundary,{ref:instance=>outer=instance,name:'outer',fallback:Recovered},h(Boundary,{name:'inner',fallback:Rethrow},h(Throw)))}
window.startError=()=>root.render(tree());
window.resetError=()=>{failing=false;outer.setState({error:null})};
window.failAgain=()=>{failing=true;root.render(tree())};
window.startSuspense=()=>{
 failing=true;
 pending=new Promise(resolve=>window.resolveFallback=()=>{ready=true;resolve()});
 root.render(h(Suspense,{fallback:h('p',{id:'pending'},'Pending')},h(Boundary,{name:'waiting',fallback:WaitingFallback},h(Throw))))
};
`,
	},
	bundle: true,
	write: false,
	format: 'iife',
	platform: 'browser',
}).outputFiles[0]!.text

test('Redact forwards failing error fallbacks and lets reset boundaries capture again', async ({
	page,
}) => {
	const errors: string[] = []
	page.on('pageerror', (error) => errors.push(error.message))
	await page.setContent('<div id="fixture"></div>')
	await page.addScriptTag({ content: client })
	await page.evaluate('window.startError()')
	for (let attempt = 0; attempt < 3; attempt++) {
		await expect(page.locator('#recovered')).toHaveText('original failure')
		expect(await page.evaluate('window.catches')).toEqual(
			Array.from({ length: attempt + 1 }, () => ['outer', 'original failure']),
		)
		await page.evaluate('window.resetError()')
		await expect(page.locator('#healthy')).toHaveText('Healthy')
		if (attempt < 2) await page.evaluate('window.failAgain()')
	}
	expect(errors).toEqual([])
})

test('Redact sends a suspending error fallback to Suspense and retries it after resolution', async ({
	page,
}) => {
	const errors: string[] = []
	page.on('pageerror', (error) => errors.push(error.message))
	await page.setContent('<div id="fixture"></div>')
	await page.addScriptTag({ content: client })
	await page.evaluate('window.startSuspense()')
	await expect(page.locator('#pending')).toHaveText('Pending')
	await page.evaluate('window.resolveFallback()')
	await expect(page.locator('#resolved')).toHaveText('original failure')
	await expect(page.locator('#pending')).toHaveCount(0)
	expect(await page.evaluate('window.catches')).toEqual([
		['waiting', 'original failure'],
	])
	expect(errors).toEqual([])
})
