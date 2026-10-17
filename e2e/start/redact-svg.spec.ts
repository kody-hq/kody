import { test, expect } from '@playwright/test'
import { buildSync } from 'esbuild'
import { createElement } from '@tanstack/redact'
import { renderToString } from '@tanstack/redact/server'

// Use the installed dependency on both sides, independent of the app's icon markup.
const client = buildSync({
	stdin: {
		resolveDir: process.cwd(),
		contents: `
import {createElement as h} from '@tanstack/redact';
import {hydrateRoot} from '@tanstack/redact/dom-client';
const tree = (ratio) => h('svg', {viewBox:'0 0 100 50',preserveAspectRatio:ratio},
 h('defs', null,
  h('linearGradient',{id:'gradient',gradientUnits:'userSpaceOnUse',gradientTransform:'rotate(20)'}),
  h('clipPath',{id:'clip',clipPathUnits:'objectBoundingBox'})),
 h('path',{d:'M0 0h10',strokeWidth:2,fillRule:'evenodd'}));
const root=hydrateRoot(document.getElementById('fixture'),tree('xMidYMid meet'),{
 onRecoverableError(error){window.__svgErrors.push(String(error));}
});
window.__updateSvg=()=>root.render(tree('none'));
`,
	},
	bundle: true,
	write: false,
	format: 'iife',
	platform: 'browser',
}).outputFiles[0]!.text

function tree() {
	return createElement(
		'svg',
		{ viewBox: '0 0 100 50', preserveAspectRatio: 'xMidYMid meet' },
		createElement(
			'defs',
			null,
			createElement('linearGradient', {
				id: 'gradient',
				gradientUnits: 'userSpaceOnUse',
				gradientTransform: 'rotate(20)',
			}),
			createElement('clipPath', {
				id: 'clip',
				clipPathUnits: 'objectBoundingBox',
			}),
		),
		createElement('path', {
			d: 'M0 0h10',
			strokeWidth: 2,
			fillRule: 'evenodd',
		}),
	)
}

test('Redact preserves SVG attribute names through HTML parsing, hydration and updates', async ({
	page,
}) => {
	const errors: string[] = []
	page.on('pageerror', (error) => errors.push(error.message))
	page.on('console', (message) => {
		if (message.type() === 'error') errors.push(message.text())
	})
	const html = renderToString(tree())
	expect(html).toContain('preserveAspectRatio="xMidYMid meet"')
	expect(html).toContain('clipPathUnits="objectBoundingBox"')
	await page.setContent(`<div id="fixture">${html}</div>`)
	await page.evaluate(
		'window.__svgErrors=[]; window.__originalSvg=document.querySelector("svg")',
	)
	await page.addScriptTag({ content: client })
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
			),
	)
	expect(
		await page.evaluate('document.querySelector("svg")===window.__originalSvg'),
	).toBe(true)
	expect(await page.evaluate('window.__svgErrors')).toEqual([])
	await page.evaluate('window.__updateSvg()')
	await expect(page.locator('svg')).toHaveAttribute(
		'preserveAspectRatio',
		'none',
	)
	expect(
		await page.locator('svg').evaluate((node) => node.getAttributeNames()),
	).not.toContain('preserveaspectratio')
	await expect(page.locator('linearGradient')).toHaveAttribute(
		'gradientUnits',
		'userSpaceOnUse',
	)
	await expect(page.locator('linearGradient')).toHaveAttribute(
		'gradientTransform',
		'rotate(20)',
	)
	await expect(page.locator('clipPath')).toHaveAttribute(
		'clipPathUnits',
		'objectBoundingBox',
	)
	await expect(page.locator('path')).toHaveAttribute('stroke-width', '2')
	await expect(page.locator('path')).toHaveAttribute('fill-rule', 'evenodd')
	expect(errors).toEqual([])
	expect(await page.evaluate('window.__svgErrors')).toEqual([])
})
