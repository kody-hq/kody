import { expect, test } from 'vitest'
import {
	BLOG_IMAGE_CACHE_CONTROL,
	blogImageObject,
} from '#worker/blog/blog-image-store.ts'
import { createBlogImageHandler } from './blog-image.ts'

const slug = 'kody-weekly-2026-11-13'
const key = `blog-images/${slug}/pr-5098-1a2b3c4d.webp`
const bytes = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4])

function fakeBucket(objects: Record<string, Uint8Array>) {
	const reads: Array<string> = []
	const meta = (k: string) => ({
		key: k,
		size: objects[k]!.byteLength,
		httpEtag: '"etag-1"',
	})
	return {
		reads,
		binding: {
			async get(k: string) {
				reads.push(k)
				if (!objects[k]) return null
				return { ...meta(k), body: new Response(objects[k] as BodyInit).body }
			},
			async head(k: string) {
				reads.push(k)
				return objects[k] ? meta(k) : null
			},
		} as unknown as R2Bucket,
	}
}

function call(
	bucket: R2Bucket,
	params: { slug: string; file: string },
	method = 'GET',
) {
	return createBlogImageHandler({ COMMUNITY_ASSETS: bucket })({
		request: new Request(
			`https://kody.codes/images/blog/${params.slug}/${params.file}`,
			{ method },
		),
		params,
	})
}

test('blogImageObject maps /images/blog paths to the blog-images/ R2 prefix', () => {
	expect(blogImageObject({ slug, file: 'pr-5098-1a2b3c4d.webp' })).toEqual({
		key,
		contentType: 'image/webp',
	})
	expect(blogImageObject({ slug, file: 'hero.jpg' })?.contentType).toBe(
		'image/jpeg',
	)
	expect(blogImageObject({ slug, file: 'hero.png' })?.contentType).toBe(
		'image/png',
	)
	for (const file of [
		'Hero.webp',
		'hero.svg',
		'hero.html',
		'../secret.webp',
		'a/b.webp',
		'.webp',
		'hero.webp.exe',
	]) {
		expect(blogImageObject({ slug, file })).toBeNull()
	}
	for (const bad of ['..', 'Kody-Weekly', 'a/b', '', '-x']) {
		expect(blogImageObject({ slug: bad, file: 'a.webp' })).toBeNull()
	}
})

test('serves an R2 blog image with immutable caching and a fixed image type', async () => {
	const bucket = fakeBucket({ [key]: bytes })
	const response = await call(bucket.binding, {
		slug,
		file: 'pr-5098-1a2b3c4d.webp',
	})
	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toBe('image/webp')
	expect(response.headers.get('Cache-Control')).toBe(BLOG_IMAGE_CACHE_CONTROL)
	expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
	expect(response.headers.get('Content-Length')).toBe(String(bytes.byteLength))
	expect(response.headers.get('ETag')).toBe('"etag-1"')
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
	expect(bucket.reads).toEqual([key])
})

test('HEAD returns headers without a body', async () => {
	const bucket = fakeBucket({ [key]: bytes })
	const response = await call(
		bucket.binding,
		{ slug, file: 'pr-5098-1a2b3c4d.webp' },
		'HEAD',
	)
	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Length')).toBe(String(bytes.byteLength))
	expect(response.body).toBeNull()
})

test('404s missing objects and invalid names without touching R2', async () => {
	const bucket = fakeBucket({ [key]: bytes })
	expect(
		(await call(bucket.binding, { slug, file: 'missing.webp' })).status,
	).toBe(404)
	expect(bucket.reads).toEqual([`blog-images/${slug}/missing.webp`])
	bucket.reads.length = 0
	const invalid = await call(bucket.binding, { slug, file: 'x.svg' })
	expect(invalid.status).toBe(404)
	expect(invalid.headers.get('Cache-Control')).toBe('no-store')
	expect(bucket.reads).toEqual([])
})

test('rejects writes', async () => {
	const bucket = fakeBucket({ [key]: bytes })
	const response = await call(
		bucket.binding,
		{ slug, file: 'pr-5098-1a2b3c4d.webp' },
		'POST',
	)
	expect(response.status).toBe(405)
	expect(bucket.reads).toEqual([])
})
