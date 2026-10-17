import { afterEach, expect, test, vi } from 'vitest'
import {
	landingArtAttrs,
	publicAsset,
	publicAssetSrcSet,
} from './public-assets.ts'

afterEach(() => vi.unstubAllEnvs())

test('release public files use the immutable namespace, document and service URLs stay at root', () => {
	vi.stubEnv('BASE_URL', '/__start/0123456789012345678901234567890123456789/')
	for (const file of [
		'/page-init.js',
		'/fonts/wix-madefor-text-latin.woff2',
		'/site.webmanifest',
		'/favicon.ico',
		'/images/kody-mark.png',
		'/logo-64.webp',
	]) {
		expect(publicAsset(file)).toBe(
			`${import.meta.env.BASE_URL}${file.slice(1)}`,
		)
	}
	for (const url of [
		'/account',
		'/og/home.png',
		'/integrations/logos/slack',
		'/api/files/avatar',
		'https://example.com/image.png',
		'data:image/png;base64,abc',
	]) {
		expect(publicAsset(url)).toBe(url)
	}
	const art = landingArtAttrs('kody-keys')
	expect(art.src).toBe(`${import.meta.env.BASE_URL}images/kody-keys-480.webp`)
	expect(art.srcSet).toBe(
		`${import.meta.env.BASE_URL}images/kody-keys-480.webp 480w, ${import.meta.env.BASE_URL}images/kody-keys.webp 700w`,
	)
})

test('default build retains public URLs and responsive candidate descriptors', () => {
	vi.stubEnv('BASE_URL', '/')
	expect(publicAsset('/page-init.js')).toBe('/page-init.js')
	expect(publicAssetSrcSet('/images/a.webp 480w, /images/b.webp 960w')).toBe(
		'/images/a.webp 480w, /images/b.webp 960w',
	)
})
