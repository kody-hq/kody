import { getPublicOgPage } from '#universal/og-pages.ts'
import { parseOgTheme } from '#worker/og/palette.ts'

export function createOgPageImageHandler(env: Env) {
	return async ({
		request,
		params,
	}: {
		request: Request
		params: { page: string }
	}) => {
		const page = getPublicOgPage(params.page)
		if (!page) {
			return new Response('Not found', { status: 404 })
		}

		const requestUrl = new URL(request.url)
		// `?theme=light` renders the pale variant; anything else falls back to
		// the default rather than erroring, since crawlers own these URLs.
		const theme = parseOgTheme(requestUrl.searchParams.get('theme'))
		// Homepage `?og=` is a distinct card. Unknown values render the
		// default home image. Other pages ignore the param.
		const homeOg =
			params.page === 'home' ? requestUrl.searchParams.get('og') : null

		// Lazy import (sanctioned exception to the no-inline-imports rule):
		// the OG renderer pulls in satori and @resvg/resvg-wasm plus two wasm
		// binaries, which would otherwise bloat isolate cold starts for a
		// route that is only hit by social-media crawlers.
		const { renderPageOgImage } = await import('#worker/og/page-image.ts')
		const png = await renderPageOgImage({
			page,
			theme,
			assets: env.ASSETS,
			homeOg,
		})

		return new Response(png, {
			status: 200,
			headers: {
				'Cache-Control': 'public, max-age=3600',
				'Content-Type': 'image/png',
			},
		})
	}
}
