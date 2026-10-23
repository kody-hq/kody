import { expect, test } from '../playwright-utils.ts'
import { heroBaseImage } from '../../packages/worker/universal/landing-images.ts'

test('SSR preserves document metadata and critical resource ordering', async ({
	browser,
	baseURL,
}) => {
	const context = await browser.newContext({
		baseURL,
		javaScriptEnabled: false,
	})
	try {
		const page = await context.newPage()
		for (const path of ['/', '/pricing']) {
			const response = await page.goto(path)
			expect(response?.status()).toBe(200)
			await expect(page.locator('head meta[charset]')).toHaveAttribute(
				'charset',
				'utf-8',
			)
			await expect(
				page.locator(
					'head link[rel="icon"][href="/favicon-32x32.png"][media="(prefers-color-scheme: light)"]',
				),
			).toHaveAttribute('sizes', '32x32')
			await expect(
				page.locator(
					'head link[rel="icon"][href="/favicon-16x16.png"][media="(prefers-color-scheme: light)"]',
				),
			).toHaveAttribute('sizes', '16x16')
			await expect(
				page.locator(
					'head link[rel="icon"][href="/favicon-32x32-dark.png"][media="(prefers-color-scheme: dark)"]',
				),
			).toHaveAttribute('sizes', '32x32')
			await expect(
				page.locator(
					'head link[rel="icon"][href="/favicon-16x16-dark.png"][media="(prefers-color-scheme: dark)"]',
				),
			).toHaveAttribute('sizes', '16x16')
			await expect(
				page.locator('head link[rel="icon"][href="/favicon.ico"]'),
			).toHaveAttribute('sizes', '32x32')
			// Chromium picks the last matching icon link; the scheme-aware SVG
			// has to win over the light-only ICO and PNGs.
			await expect(
				page.locator('head link[rel="icon"]').last(),
			).toHaveAttribute('href', '/favicon.svg')
			await expect(
				page.locator(
					'head link[rel="apple-touch-icon"][href="/apple-touch-icon.png"]',
				),
			).toHaveAttribute('sizes', '180x180')
			await expect(
				page.locator('head link[rel="icon"][type="image/svg+xml"]'),
			).toHaveAttribute('href', '/favicon.svg')
			await expect(page.locator('head link[rel="manifest"]')).toHaveAttribute(
				'href',
				'/site.webmanifest',
			)
			await expect(
				page.locator(
					'head meta[name="theme-color"][media="(prefers-color-scheme: light)"]',
				),
			).toHaveAttribute('content', '#e6e8ea')
			await expect(
				page.locator(
					'head meta[name="theme-color"][media="(prefers-color-scheme: dark)"]',
				),
			).toHaveAttribute('content', '#111417')
			const resources = await page
				.locator(
					'head > script[src], head > link[rel="preload"], head > link[rel="modulepreload"]',
				)
				.evaluateAll((nodes) =>
					nodes.map((node) => ({
						tag: node.tagName,
						src: node.getAttribute('src'),
						rel: node.getAttribute('rel'),
						as: node.getAttribute('as'),
						href: node.getAttribute('href'),
						crossOrigin: node.getAttribute('crossorigin'),
					})),
				)
			const init = resources.findIndex((node) => node.src === '/page-init.js')
			const fonts = resources
				.map((node, index) => ({ ...node, index }))
				.filter((node) => node.as === 'font')
			expect(init).toBeGreaterThanOrEqual(0)
			expect(fonts).toHaveLength(2)
			for (const font of fonts) {
				expect(font.index).toBeGreaterThan(init)
				expect(font.crossOrigin).toBe('anonymous')
				const moduleIndex = resources.findIndex(
					(node) => node.rel === 'modulepreload',
				)
				if (moduleIndex >= 0) expect(font.index).toBeLessThan(moduleIndex)
			}
			const hero = page.locator('head link[rel="preload"][as="image"]')
			if (path === '/') {
				await expect(hero).toHaveAttribute('href', heroBaseImage.src)
				await expect(hero).toHaveAttribute('imagesrcset', heroBaseImage.srcSet)
				await expect(hero).toHaveAttribute('imagesizes', heroBaseImage.sizes)
				await expect(hero).toHaveAttribute('fetchpriority', 'high')
			} else await expect(hero).toHaveCount(0)
		}
	} finally {
		await context.close()
	}
})

test('homepage SSR includes nonce-authorized SoftwareApplication JSON-LD only on home', async ({
	page,
}) => {
	const response = await page.goto('/')
	const structured = page.locator('head script[type="application/ld+json"]')
	await expect(structured).toHaveCount(1)
	const data = JSON.parse((await structured.textContent())!)
	expect(data).toMatchObject({
		'@type': 'SoftwareApplication',
		url: 'https://kody.codes',
		offers: { price: '0', priceCurrency: 'USD' },
	})
	expect(data.sameAs).toContain('https://github.com/kody-hq/kody')
	const nonce = await structured.evaluate(
		(node: HTMLScriptElement) => node.nonce,
	)
	expect(nonce).not.toBe('')
	expect(response?.headers()['content-security-policy']).toContain(
		`'nonce-${nonce}'`,
	)
	await page.goto('/pricing')
	await expect(
		page.locator('head script[type="application/ld+json"]'),
	).toHaveCount(0)
})
