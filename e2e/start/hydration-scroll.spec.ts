import { build } from 'esbuild'
import { expect, test } from '@playwright/test'

for (const library of ['react', 'redact'] as const) {
	test(`${library} preserves application scroll ownership during and immediately after hydration`, async ({
		page,
	}) => {
		const react = library === 'react' ? 'react' : '@tanstack/redact'
		const client =
			library === 'react' ? 'react-dom/client' : '@tanstack/redact/dom-client'
		const { outputFiles } = await build({
			stdin: {
				resolveDir: process.cwd(),
				contents: `
					import {createElement, useLayoutEffect} from '${react}';
					import {hydrateRoot} from '${client}';
					function App() {
						useLayoutEffect(() => {
							window.scrollTo(0, 20);
							window.__hydrationScrollReady = true;
						}, []);
						return createElement('div', {style: {height: 3000}}, 'Scroll fixture');
					}
					hydrateRoot(document.getElementById('root'), createElement(App));
				`,
			},
			bundle: true,
			write: false,
			format: 'iife',
			platform: 'browser',
			define: { 'process.env.NODE_ENV': '"production"' },
		})
		await page.setContent(
			'<div id="root"><div style="height:3000px">Scroll fixture</div></div>',
		)
		await page.evaluate(() => {
			window.scrollTo(0, 100)
			Object.assign(window, { originalScrollTo: window.scrollTo })
		})
		await page.addScriptTag({ content: outputFiles[0]!.text })
		await page.waitForFunction(() => '__hydrationScrollReady' in window)
		expect(await page.evaluate(() => window.scrollY)).toBe(20)
		expect(
			await page.evaluate(
				() =>
					window.scrollTo ===
					(window as unknown as { originalScrollTo: typeof window.scrollTo })
						.originalScrollTo,
			),
		).toBe(true)
		await page.mouse.wheel(0, 300)
		await expect
			.poll(() => page.evaluate(() => window.scrollY))
			.toBeGreaterThan(20)
		// A real user scroll must not disable the next application navigation.
		expect(
			await page.evaluate(() => {
				window.scrollTo({ top: 0, behavior: 'instant' })
				return window.scrollY
			}),
		).toBe(0)
	})
}
