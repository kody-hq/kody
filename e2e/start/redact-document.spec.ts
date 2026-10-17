import { test, expect } from '@playwright/test'
import { buildSync } from 'esbuild'

function bundle(contents: string) {
	return buildSync({
		stdin: { resolveDir: process.cwd(), contents },
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
	}).outputFiles[0]!.text
}

test('Redact replaces and resets an error document without inserting a second html element', async ({
	page,
}) => {
	const errors: string[] = []
	page.on('pageerror', (error) => errors.push(error.message))
	const client = bundle(`
import {createElement as h,Component,useState} from '@tanstack/redact';
import {hydrateRoot} from '@tanstack/redact/dom-client';
let boundary;
class Boundary extends Component {
 state={error:null}; static getDerivedStateFromError(error){return {error}}
 render(){return this.state.error?h(Failure):this.props.children}
}
function Failure(){return h('html',null,h('head',null,h('title',null,'Failed')),h('body',null,h('main',{id:'failure'},'Recovered document')))}
function Content(){const [fail,setFail]=useState(false);window.fail=()=>setFail(true);if(fail)throw new Error('document failed');return h('main',{id:'content'},'Healthy')}
function Document(){return h('html',null,h('head',null,h('title',null,'Healthy')),h('body',null,h(Content)))}
hydrateRoot(document,h(Boundary,{ref:instance=>boundary=instance},h(Document)),{onCaughtError(){}});
window.resetDocument=()=>boundary.setState({error:null});
`)
	await page.setContent(
		'<!doctype html><html><head><title>Healthy</title></head><body><main id="content">Healthy</main></body></html>',
	)
	await page.addScriptTag({ content: client })
	for (let attempt = 0; attempt < 3; attempt++) {
		await expect(page.locator('#content')).toHaveText('Healthy')
		await page.evaluate('window.fail()')
		await expect(page.locator('#failure')).toHaveText('Recovered document')
		await expect(page.locator('html')).toHaveCount(1)
		await page.evaluate('window.resetDocument()')
	}
	await expect(page.locator('#content')).toHaveText('Healthy')
	expect(errors).toEqual([])
})

test('Redact preserves keyed DOM identity and detaches deleted refs before attaching replacements', async ({
	page,
}) => {
	const errors: string[] = []
	page.on('pageerror', (error) => errors.push(error.message))
	const client = bundle(`
import {createElement as h,useState} from '@tanstack/redact';
import {createRoot} from '@tanstack/redact/dom-client';
window.refs=[];
const refs={};for(const id of ['a','b','c'])refs[id]=node=>window.refs.push([id,node?'attach':'detach']);
function List(){const [items,setItems]=useState(['a','b']);window.reorder=()=>setItems(['b','a']);window.replace=()=>setItems(['b','c']);return h('div',null,...items.map(id=>h('input',{key:id,id,ref:refs[id],defaultValue:id})))}
createRoot(document.getElementById('fixture')).render(h(List));
`)
	await page.setContent('<div id="fixture"></div>')
	await page.addScriptTag({ content: client })
	await expect(page.locator('input')).toHaveCount(2)
	await page.locator('#b').fill('dirty')
	await page.evaluate(
		'window.originalB=document.getElementById("b");window.refs=[];window.reorder()',
	)
	await expect(page.locator('input').first()).toHaveAttribute('id', 'b')
	expect(await page.evaluate('window.refs')).toEqual([])
	await page.evaluate('window.replace()')
	await expect(page.locator('#c')).toHaveCount(1)
	expect(
		await page.evaluate('window.originalB===document.getElementById("b")'),
	).toBe(true)
	await expect(page.locator('#b')).toHaveValue('dirty')
	expect(await page.evaluate('window.refs')).toEqual([
		['a', 'detach'],
		['c', 'attach'],
	])
	expect(errors).toEqual([])
})

test('Redact rolls back a queued deletion when its replacement suspends', async ({
	page,
}) => {
	const errors: string[] = []
	page.on('pageerror', (error) => errors.push(error.message))
	const client = bundle(`
import {createElement as h,useState,useEffect,Suspense} from '@tanstack/redact';
import {createRoot} from '@tanstack/redact/dom-client';
window.cleanups=0;let ready=false;const wait=new Promise(resolve=>window.resolveReplacement=()=>{ready=true;resolve()});
function Original(){useEffect(()=>()=>{window.cleanups++},[]);return h('p',{id:'original'},'Original')}
function Replacement(){if(!ready)throw wait;return h('p',{id:'replacement'},'Replacement')}
function App(){const [replace,setReplace]=useState(false);window.replace=()=>setReplace(true);return h(Suspense,{fallback:h('p',{id:'pending'},'Pending')},replace?h(Replacement):h(Original))}
createRoot(document.getElementById('fixture')).render(h(App));
`)
	await page.setContent('<div id="fixture"></div>')
	await page.addScriptTag({ content: client })
	await expect(page.locator('#original')).toHaveText('Original')
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	)
	await page.evaluate('window.replace()')
	await expect(page.locator('#pending')).toBeVisible()
	expect(await page.evaluate('window.cleanups')).toBe(0)
	await page.evaluate('window.resolveReplacement()')
	await expect(page.locator('#replacement')).toHaveText('Replacement')
	await expect(page.locator('#original')).toHaveCount(0)
	await expect.poll(() => page.evaluate('window.cleanups')).toBe(1)
	expect(errors).toEqual([])
})

test('Redact treats noscript fallback markup as opaque during hydration and client rendering', async ({
	page,
}) => {
	const client = bundle(`
import {createElement as h,useState} from '@tanstack/redact';
import {hydrateRoot,createRoot} from '@tanstack/redact/dom-client';
window.hydrationErrors=[];
function Fallback(){throw new Error('noscript children must not render in the browser')}
function App(){const [count,setCount]=useState(0);return h('div',null,h('noscript',null,h(Fallback)),h('button',{onClick:()=>setCount(count+1)},String(count)))}
window.originalFallback=document.querySelector('noscript').firstChild;
window.originalButton=document.querySelector('button');
hydrateRoot(document.getElementById('fixture'),h(App),{onRecoverableError:error=>window.hydrationErrors.push(error.message)});
createRoot(document.getElementById('client')).render(h('noscript',null,h(Fallback)));
`)
	await page.setContent(
		'<div id="fixture"><div><noscript><div>Enable JavaScript</div></noscript><button>0</button></div></div><div id="client"></div>',
	)
	expect(
		await page
			.locator('noscript')
			.evaluate((node) => node.firstChild?.nodeType),
	).toBe(3)
	await page.addScriptTag({ content: client })
	await page.getByRole('button', { name: '0', exact: true }).click()
	await expect(
		page.getByRole('button', { name: '1', exact: true }),
	).toBeVisible()
	expect(await page.evaluate('window.hydrationErrors')).toEqual([])
	expect(
		await page.evaluate(
			'window.originalFallback === document.querySelector("#fixture noscript").firstChild',
		),
	).toBe(true)
	expect(
		await page.evaluate(
			'window.originalButton === document.querySelector("button")',
		),
	).toBe(true)
	await expect(page.locator('#client noscript')).toHaveCount(1)
	expect(
		await page
			.locator('#client noscript')
			.evaluate((node) => node.childNodes.length),
	).toBe(0)
})
