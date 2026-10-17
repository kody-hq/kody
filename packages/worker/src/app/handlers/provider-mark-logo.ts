import {
	getPlatformProviderMarkBySlug,
	loadFittedProviderMarkLogo,
} from '#worker/integrations/provider-marks.ts'

/**
 * Public serving route for operator-curated provider brand marks. These are
 * not user assets — anyone who can see a saved-integration list may load the
 * mark.
 */
export function createProviderMarkLogoHandler(env: Env) {
	return async ({ params }: { params: { slug: string } }) => {
		const mark = await getPlatformProviderMarkBySlug({
			db: env.APP_DB,
			slug: params.slug,
		})
		if (!mark?.logoKey) {
			return new Response('Not found', { status: 404 })
		}
		const logo = await loadFittedProviderMarkLogo({
			env,
			mark,
		})
		if (!logo) {
			return new Response('Not found', { status: 404 })
		}
		return new Response(logo.body, {
			headers: {
				'Cache-Control': logo.cacheControl,
				'Content-Length': String(logo.size),
				'Content-Type': logo.contentType,
				ETag: logo.httpEtag,
				'X-Content-Type-Options': 'nosniff',
			},
		})
	}
}
