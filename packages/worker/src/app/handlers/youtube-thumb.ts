import {
	isYoutubeVideoId,
	youtubeThumbnailSourceUrls,
} from '#universal/youtube-watch.ts'
import { resolveYoutubeWatchAllowedVideoIds } from '#app/youtube-watch-allowlist.ts'

const thumbCacheControl = 'public, max-age=86400, stale-while-revalidate=604800'

export function createYoutubeThumbHandler(env: Env) {
	return async ({
		params,
		request,
	}: {
		params: { videoId: string }
		request: Request
	}) => {
		if (request.method !== 'GET' && request.method !== 'HEAD') {
			return new Response('Method not allowed', { status: 405 })
		}
		const videoId = params.videoId
		if (!isYoutubeVideoId(videoId)) {
			return notFound()
		}
		const allowed = await resolveYoutubeWatchAllowedVideoIds({ env })
		if (!allowed.includes(videoId)) {
			return notFound()
		}

		try {
			const upstream = await fetchFirstYoutubeThumbnail(videoId)
			if (!upstream) return notFound()
			const bytes = await upstream.arrayBuffer()
			const contentType = upstream.headers.get('Content-Type') ?? 'image/jpeg'
			return new Response(request.method === 'HEAD' ? null : bytes, {
				headers: {
					'Cache-Control': thumbCacheControl,
					'Content-Length': String(bytes.byteLength),
					'Content-Type': contentType,
					'X-Content-Type-Options': 'nosniff',
				},
			})
		} catch {
			return notFound()
		}
	}
}

async function fetchFirstYoutubeThumbnail(
	videoId: string,
): Promise<Response | null> {
	const signal = AbortSignal.timeout(2_500)
	for (const url of youtubeThumbnailSourceUrls(videoId)) {
		const upstream = await fetch(url, { signal })
		if (upstream.ok) return upstream
	}
	return null
}

function notFound() {
	return new Response('Not found', {
		status: 404,
		headers: {
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
		},
	})
}
