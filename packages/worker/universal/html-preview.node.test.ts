import { test, expect } from 'vitest'
import {
	htmlPreviewBootstrap,
	htmlPreviewCsp,
	htmlPreviewPath,
} from './html-preview.ts'
test('preview bootstrap accepts only the trusted parent and keeps opaque origins', () => {
	const wrapper = htmlPreviewBootstrap('https://kody.test')
	expect(wrapper).toContain('event.source !== parent')
	expect(wrapper).toContain('event.origin !== "https://kody.test"')
	expect(wrapper).toContain('sandbox="allow-scripts"')
	expect(htmlPreviewCsp).toContain("connect-src 'none'")
	expect(htmlPreviewCsp).toContain("frame-src 'none'")
	expect(htmlPreviewCsp).not.toContain('allow-same-origin')
	expect(htmlPreviewPath('a/b')).toBe('/html-preview/a%2Fb')
})
