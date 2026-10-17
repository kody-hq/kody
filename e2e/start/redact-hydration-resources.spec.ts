import { test, expect } from '@playwright/test'
import { buildSync } from 'esbuild'

function bundle(contents: string) {
	return buildSync({
		stdin: { resolveDir: process.cwd(), contents },
		bundle: true,
		write: false,
		format: 'iife',
		platform: 'browser',
		define: { 'process.env.NODE_ENV': '"production"' },
	}).outputFiles[0]!.text
}

for (const mode of ['hydrate', 'mount'])
	for (const sourceFirst of [true, false]) {
		test(`Redact ${mode} leaves offscreen images lazy with sourceFirst=${sourceFirst}`, async ({
			page,
		}) => {
			const requests: string[] = []
			const errors: string[] = []
			page.on('pageerror', (error) => errors.push(error.message))
			await page.route('https://lazy-image.test/**', (route) =>
				route.fulfill({
					contentType: 'image/svg+xml',
					body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
				}),
			)
			page.on('request', (request) => {
				if (request.url().startsWith('https://lazy-image.test/'))
					requests.push(request.url())
			})
			const props = sourceFirst
				? {
						src: 'https://lazy-image.test/thumb.svg',
						loading: 'lazy',
						width: 100,
						height: 100,
					}
				: {
						loading: 'lazy',
						width: 100,
						height: 100,
						src: 'https://lazy-image.test/thumb.svg',
					}
			const client = bundle(`
import {createElement as h} from '@tanstack/redact';
import {createRoot,hydrateRoot} from '@tanstack/redact/dom-client';
const node=h('img',${JSON.stringify(props)});const root=document.getElementById('fixture');
${mode === 'hydrate' ? 'hydrateRoot(root,node)' : 'createRoot(root).render(node)'};
`)
			const image =
				mode === 'hydrate'
					? '<img src="https://lazy-image.test/thumb.svg" loading="lazy" width="100" height="100">'
					: ''
			await page.setContent(
				`<div style="height:20000px"></div><div id="fixture">${image}</div>`,
			)
			// Allow the browser's lazy-load decision to run before and after hydration.
			await page.waitForTimeout(300)
			expect(requests).toEqual([])
			await page.addScriptTag({ content: client })
			await page.waitForTimeout(500)
			expect(requests).toEqual([])
			await page.locator('img').scrollIntoViewIfNeeded()
			await expect.poll(() => requests.length).toBe(1)
			expect(errors).toEqual([])
		})
	}

test('Redact markup validation does not construct custom elements a second time', async ({
	page,
}) => {
	const errors: string[] = []
	page.on('pageerror', (error) => errors.push(error.message))
	const markup = '<validation-resource></validation-resource>'
	await page.setContent(`<div id="fixture"><div>${markup}</div></div>`)
	await page.evaluate(() => {
		let constructions = 0
		Object.defineProperty(window, 'validationConstructions', {
			get: () => constructions,
		})
		customElements.define(
			'validation-resource',
			class extends HTMLElement {
				constructor() {
					super()
					constructions++
				}
			},
		)
	})
	expect(await page.evaluate('window.validationConstructions')).toBe(1)
	const client = bundle(`
import {createElement as h} from '@tanstack/redact';
import {hydrateRoot} from '@tanstack/redact/dom-client';
hydrateRoot(document.getElementById('fixture'),h('div',{dangerouslySetInnerHTML:{__html:${JSON.stringify(markup)}}}));
`)
	await page.addScriptTag({ content: client })
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	)
	expect(await page.evaluate('window.validationConstructions')).toBe(1)
	expect(errors).toEqual([])
})

test('Redact inert probes still detect real attribute mismatches', async ({
	page,
}) => {
	await page.setContent('<div id="fixture"><p title="server">Content</p></div>')
	const client = bundle(`
import {createElement as h} from '@tanstack/redact';
import {hydrateRoot} from '@tanstack/redact/dom-client';
window.hydrationErrors=[];
hydrateRoot(document.getElementById('fixture'),h('p',{title:'client'},'Content'),{onRecoverableError:error=>window.hydrationErrors.push(String(error))});
`)
	await page.addScriptTag({ content: client })
	await expect(page.locator('p')).toHaveAttribute('title', 'client')
	expect(await page.evaluate('window.hydrationErrors.length')).toBeGreaterThan(
		0,
	)
})
