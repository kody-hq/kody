import {
	BLOG_IMAGE_CACHE_CONTROL,
	blogImageObject,
} from '#worker/blog/blog-image-store.ts'

function notFound() {
	return new Response('Not found', {
		status: 404,
		headers: { 'Cache-Control': 'no-store' },
	})
}

/**
 * `GET /images/blog/:slug/:file`: weekly blog screenshots from R2
 * (`COMMUNITY_ASSETS`, `blog-images/` prefix). Public, read-only, image
 * types only; the content type comes from the validated extension, never
 * from stored metadata.
 */
export function createBlogImageHandler(env: Pick<Env, 'COMMUNITY_ASSETS'>) {
	return async ({
		request,
		params,
	}: {
		request: Request
		params: { slug: string; file: string }
	}) => {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response('Method not allowed', {
				status: 405,
				headers: { Allow: 'GET, HEAD' },
			})
		}
		const target = blogImageObject(params)
		if (!target) return notFound()
		const object =
			request.method === 'HEAD'
				? await env.COMMUNITY_ASSETS.head(target.key)
				: await env.COMMUNITY_ASSETS.get(target.key)
		if (!object) return notFound()
		const headers: Record<string, string> = {
			'Cache-Control': BLOG_IMAGE_CACHE_CONTROL,
			'Content-Type': target.contentType,
			'X-Content-Type-Options': 'nosniff',
		}
		if (object.size != null) headers['Content-Length'] = String(object.size)
		if (object.httpEtag) headers.ETag = object.httpEtag
		const body =
			request.method === 'HEAD' || !('body' in object)
				? null
				: (object as R2ObjectBody).body
		return new Response(body, { headers })
	}
}
