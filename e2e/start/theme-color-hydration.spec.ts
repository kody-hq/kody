import { test, expect } from '@playwright/test'
import { buildSync } from 'esbuild'
import { documentThemeColors } from '../../packages/worker/start/document-shell-meta.ts'

const light = documentThemeColors.light
const dark = documentThemeColors.dark
const extensionColor = '#010203'

for (const scenario of ['mismatch', 'suppressed'] as const) {
	test(`Redact theme-color meta hydration ${scenario}`, async ({ page }) => {
		// Compact head markup: whitespace text nodes between metas would
		// fail hydrate independently of theme-color content.
		await page.setContent(
			`<!doctype html><html lang="en"><head><meta name="theme-color" content="${light.content}" media="${light.media}"><meta name="theme-color" content="${dark.content}" media="${dark.media}"></head><body><main id="ok">ready</main></body></html>`,
		)
		await page.evaluate((mutated) => {
			document
				.querySelectorAll('meta[name="theme-color"]')[0]!
				.setAttribute('content', mutated)
		}, extensionColor)

		const suppress = scenario === 'suppressed'
		const client = buildSync({
			stdin: {
				resolveDir: process.cwd(),
				contents: `
import {createElement as h} from '@tanstack/redact';
import {hydrateRoot} from '@tanstack/redact/dom-client';
window.fixtureRecoveries=[];
hydrateRoot(
	document,
	h('html',{lang:'en',suppressHydrationWarning:true},
		h('head',null,
			h('meta',{name:'theme-color',content:${JSON.stringify(light.content)},media:${JSON.stringify(light.media)},suppressHydrationWarning:${suppress}}),
			h('meta',{name:'theme-color',content:${JSON.stringify(dark.content)},media:${JSON.stringify(dark.media)},suppressHydrationWarning:${suppress}}),
		),
		h('body',null,h('main',{id:'ok'},'ready')),
	),
	{onRecoverableError:e=>window.fixtureRecoveries.push(e.message)},
);
setTimeout(()=>window.fixtureDone=true,50);
`,
			},
			bundle: true,
			write: false,
			format: 'iife',
			platform: 'browser',
			define: { 'process.env.NODE_ENV': '"production"' },
		}).outputFiles[0]!.text

		await page.addScriptTag({ content: client })
		await page.waitForFunction(() =>
			Boolean((window as unknown as { fixtureDone: boolean }).fixtureDone),
		)

		const result = await page.evaluate(() => {
			const metas = [
				...document.querySelectorAll('meta[name="theme-color"]'),
			].map((meta) => ({
				content: meta.getAttribute('content'),
				media: meta.getAttribute('media'),
			}))
			return {
				recoveries: (window as unknown as { fixtureRecoveries: string[] })
					.fixtureRecoveries,
				metas,
				main: document.getElementById('ok')?.textContent,
			}
		})

		expect(result.main).toBe('ready')
		expect(result.metas[1]).toEqual({
			content: dark.content,
			media: dark.media,
		})

		if (scenario === 'mismatch') {
			expect(
				result.recoveries.some((message) =>
					message.startsWith('Hydration mismatch'),
				),
			).toBe(true)
			// Head metas recover in place, so Redact rewrites content back.
			expect(result.metas[0]?.content).toBe(light.content)
		} else {
			expect(result.recoveries).toEqual([])
			expect(result.metas[0]).toEqual({
				content: extensionColor,
				media: light.media,
			})
		}
	})
}
