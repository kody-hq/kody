import { env } from 'cloudflare:test'
import { expect, test } from 'vitest'
import { publicOgPages } from '#universal/og-pages.ts'
import { renderPageOgImage } from './page-image.ts'

test('OG cards render in workerd, where satori shapes text with harfbuzz', async () => {
	const png = await renderPageOgImage({
		page: publicOgPages.home,
		theme: 'dark',
		assets: env.ASSETS,
	})
	expect(png.byteLength).toBeGreaterThan(10_000)
	expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
})
