import { expect, test, vi } from 'vitest'
import { listBlogPosts } from '#worker/blog/catalog.ts'
import { createBlogPostOgImageHandler } from './blog.ts'

const mocks = vi.hoisted(() => ({
	renderBlogPostOgImage: vi.fn(),
}))

vi.mock('#worker/blog/og-image.ts', () => ({
	renderBlogPostOgImage: (...args: Array<unknown>) =>
		mocks.renderBlogPostOgImage(...args),
}))

const tinyPng = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
	0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02,
	0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44,
	0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00,
	0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
	0x44, 0xae, 0x42, 0x60, 0x82,
])

test('blog post OG image renders PNG for a catalog post and 404s unknown slugs', async () => {
	mocks.renderBlogPostOgImage.mockResolvedValue(tinyPng)
	const handler = createBlogPostOgImageHandler({} as Env)
	const post = listBlogPosts().find((entry) => !entry.ogImage)
	expect(post).toBeDefined()

	const response = await handler({
		request: new Request(`https://example.com/blog/${post!.slug}/og.png`),
		params: { slug: post!.slug },
		url: new URL(`https://example.com/blog/${post!.slug}/og.png`),
	} as never)
	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toBe('image/png')
	expect(response.headers.get('Cache-Control')).toContain('max-age=3600')
	expect(mocks.renderBlogPostOgImage).toHaveBeenCalledWith(
		expect.objectContaining({
			title: post!.title,
			description: post!.description,
			date: post!.date,
			theme: 'dark',
		}),
	)
	expect(mocks.renderBlogPostOgImage.mock.calls[0]?.[0]).not.toHaveProperty(
		'imageDataUri',
	)

	const withOgArt = listBlogPosts().find(
		(candidate) => candidate.slug === 'openclaw-2-needs-a-home',
	)
	expect(withOgArt).toBeDefined()
	const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])
	const artHandler = createBlogPostOgImageHandler({
		ASSETS: {
			fetch: async () =>
				new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }),
		},
	} as unknown as Env)
	mocks.renderBlogPostOgImage.mockClear()
	const withArt = await artHandler({
		request: new Request(`https://example.com/blog/${withOgArt!.slug}/og.png`),
		params: { slug: withOgArt!.slug },
		url: new URL(`https://example.com/blog/${withOgArt!.slug}/og.png`),
	} as never)
	expect(withArt.status).toBe(200)
	expect(mocks.renderBlogPostOgImage).toHaveBeenCalledWith(
		expect.objectContaining({
			title: withOgArt!.title,
			imageDataUri: expect.stringMatching(/^data:image\/jpeg;base64,/),
		}),
	)

	// `?theme=light` is the only recognised override; junk falls back to dark.
	for (const [query, expected] of [
		['?theme=light', 'light'],
		['?theme=chartreuse', 'dark'],
	] as const) {
		mocks.renderBlogPostOgImage.mockClear()
		await handler({
			request: new Request(
				`https://example.com/blog/${post!.slug}/og.png${query}`,
			),
			params: { slug: post!.slug },
			url: new URL(`https://example.com/blog/${post!.slug}/og.png${query}`),
		} as never)
		expect(mocks.renderBlogPostOgImage).toHaveBeenCalledWith(
			expect.objectContaining({ theme: expected }),
		)
	}

	const missing = await handler({
		request: new Request('https://example.com/blog/does-not-exist/og.png'),
		params: { slug: 'does-not-exist' },
		url: new URL('https://example.com/blog/does-not-exist/og.png'),
	} as never)
	expect(missing.status).toBe(404)
})
