import { test, expect } from '@playwright/test'
import { buildSync } from 'esbuild'
import { readFileSync } from 'node:fs'

for (const scenario of ['matching', 'mismatch', 'suppressed'] as const) {
	test(`Redact head opaque HTML hydration ${scenario}`, async ({ page }) => {
		const css =
			'@font-face{font-family:FixtureFont;src:url(https://font-fixture.test/font.woff2)}body{font-family:FixtureFont;color:rgb(10,20,30)}'
		const nextCss =
			scenario === 'matching' ? css : css.replace('10,20,30', '40,50,60')
		await page.route('https://font-fixture.test/font.woff2', (route) =>
			route.fulfill({
				contentType: 'font/woff2',
				body: readFileSync(
					'packages/worker/public/fonts/wix-madefor-text-latin.woff2',
				),
			}),
		)
		await page.setContent(
			`<html><head><style id="global">${css}</style><script id="once">window.fixtureScriptRuns=(window.fixtureScriptRuns||0)+1</script></head><body><p>Font hydration fixture</p></body></html>`,
		)
		await page.evaluate(async () => {
			await document.fonts.load('16px FixtureFont')
			await document.fonts.ready
			const style = document.getElementById('global') as HTMLStyleElement
			Object.assign(window, {
				fixtureStyleText: style.firstChild,
				fixtureSheet: style.sheet,
				fixtureScriptText: document.getElementById('once')!.firstChild,
				fixtureFontLoads: 0,
			})
			document.fonts.addEventListener('loading', () => {
				;(window as unknown as { fixtureFontLoads: number }).fixtureFontLoads++
			})
		})
		const client = buildSync({
			stdin: {
				resolveDir: process.cwd(),
				contents: `
import {createElement as h} from '@tanstack/redact';
import {hydrateRoot} from '@tanstack/redact/dom-client';
window.fixtureRecoveries=[];
hydrateRoot(document,h('html',null,h('head',null,h('style',{id:'global',suppressHydrationWarning:${scenario === 'suppressed'},dangerouslySetInnerHTML:{__html:${JSON.stringify(nextCss)}}}),h('script',{id:'once',dangerouslySetInnerHTML:{__html:'window.fixtureScriptRuns=(window.fixtureScriptRuns||0)+1'}})),h('body',null,h('p',null,'Font hydration fixture'))),{onRecoverableError:e=>window.fixtureRecoveries.push(e.message)});
setTimeout(()=>window.fixtureDone=true,100);
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
			const fixture = window as unknown as {
				fixtureStyleText: Node
				fixtureSheet: CSSStyleSheet
				fixtureScriptText: Node
				fixtureFontLoads: number
				fixtureScriptRuns: number
				fixtureRecoveries: string[]
			}
			const style = document.getElementById('global') as HTMLStyleElement
			return {
				sameText: style.firstChild === fixture.fixtureStyleText,
				sameSheet: style.sheet === fixture.fixtureSheet,
				sameScriptText:
					document.getElementById('once')!.firstChild ===
					fixture.fixtureScriptText,
				fontLoads: fixture.fixtureFontLoads,
				scriptRuns: fixture.fixtureScriptRuns,
				recoveries: fixture.fixtureRecoveries,
				color: getComputedStyle(document.body).color,
			}
		})
		expect(result.sameScriptText).toBe(true)
		expect(result.scriptRuns).toBe(1)
		if (scenario === 'mismatch') {
			expect(result.color).toBe('rgb(40, 50, 60)')
			expect(result.recoveries.length).toBeGreaterThan(0)
		} else {
			expect(result.sameText).toBe(true)
			expect(result.sameSheet).toBe(true)
			expect(result.fontLoads).toBe(0)
			expect(result.recoveries).toEqual([])
			expect(result.color).toBe('rgb(10, 20, 30)')
		}
	})
}
