import { loadLandingHeroVideos } from '#app/landing-hero-videos.ts'
import { listDocWatchEmbeds } from '#universal/doc-youtube.ts'
import { landingHeroSourcePlaylistId } from '#universal/landing-hero-copy.ts'
import {
	mergeYoutubeWatchAllowlist,
	parseYoutubePlaylistFeedXml,
	parseYoutubePlaylistIdList,
	parseYoutubeVideoIdList,
	youtubePlaylistFeedCacheSeconds,
	youtubePlaylistFeedUrl,
	youtubeWatchSampleVideoId,
} from '#universal/youtube-watch.ts'
import { withAgentYoutubeVideoIds } from '#universal/with-agents.ts'
import { listBlogPosts } from '#worker/blog/catalog.ts'
import { guides } from '#worker/guides/catalog.ts'

export async function resolveYoutubeWatchAllowedVideoIds(input: {
	env: Env
	cache?: Cache
	/**
	 * Playlist Atom fetch plus the homepage hero chooser ids. Default true
	 * for thumbs and `?youtubeId=` SSR. Plain documents skip both: env extras
	 * and the sample id still allow Watch CTAs.
	 */
	loadPlaylists?: boolean
}): Promise<Array<string>> {
	const playlistIds = parseYoutubePlaylistIdList(
		input.env.YOUTUBE_ALLOWED_PLAYLIST_IDS,
	)
	const extraVideoIds = parseYoutubeVideoIdList(
		input.env.YOUTUBE_ALLOWED_VIDEO_IDS,
	)
	const loadPlaylists = input.loadPlaylists !== false
	const [playlistVideoIds, heroVideos] = await Promise.all([
		loadPlaylists
			? loadPlaylistVideoIds({
					playlistIds,
					cache: input.cache ?? readDefaultCache(),
				})
			: Promise.resolve([]),
		loadPlaylists
			? loadLandingHeroVideos({
					env: input.env,
					playlistId: landingHeroSourcePlaylistId,
				})
			: Promise.resolve([]),
	])
	return mergeYoutubeWatchAllowlist({
		playlistVideoIds,
		extraVideoIds: [
			...extraVideoIds,
			youtubeWatchSampleVideoId,
			...bundledDocWatchVideoIds(),
			...withAgentYoutubeVideoIds(),
			...heroVideos.map((video) => video.videoId),
		],
		hrefs: [],
	})
}

/**
 * Video ids from first-party `> [!WATCH]` blocks in guides and blog posts.
 * Unlisted films are often missing from the public playlist Atom feed, and
 * the thumb proxy 404s without an allowlist hit.
 */
export function bundledDocWatchVideoIds(): Array<string> {
	const ids: Array<string> = []
	for (const { body } of [...guides, ...listBlogPosts()]) {
		for (const embed of listDocWatchEmbeds(body)) {
			ids.push(embed.videoId)
		}
	}
	return ids
}

export async function loadPlaylistVideoIds(input: {
	playlistIds: ReadonlyArray<string>
	cache?: Cache
}): Promise<Array<string>> {
	if (input.playlistIds.length === 0) return []
	const nested = await Promise.all(
		input.playlistIds.map((playlistId) =>
			loadOnePlaylistVideoIds({
				playlistId,
				cache: input.cache,
			}),
		),
	)
	return nested.flat()
}

async function loadOnePlaylistVideoIds(input: {
	playlistId: string
	cache?: Cache
}): Promise<Array<string>> {
	const cacheRequest = new Request(
		`https://kody.codes/__cache/youtube-playlist/${input.playlistId}`,
	)
	if (input.cache) {
		const cached = await input.cache.match(cacheRequest).catch(() => undefined)
		if (cached) {
			const xml = await cached.text()
			return parseYoutubePlaylistFeedXml(xml)
		}
	}

	try {
		// workerd's `fetch` is not a bound function; call the global.
		const response = await fetch(youtubePlaylistFeedUrl(input.playlistId), {
			signal: AbortSignal.timeout(2_500),
		})
		if (!response.ok) return []
		const xml = await response.text()
		if (input.cache) {
			await input.cache
				.put(
					cacheRequest,
					new Response(xml, {
						headers: {
							'Cache-Control': `public, max-age=${String(youtubePlaylistFeedCacheSeconds)}`,
							'Content-Type': 'application/atom+xml',
						},
					}),
				)
				.catch(() => undefined)
		}
		return parseYoutubePlaylistFeedXml(xml)
	} catch {
		return []
	}
}

function readDefaultCache(): Cache | undefined {
	try {
		if (typeof caches === 'undefined') return undefined
		const store = caches as CacheStorage & { default?: Cache }
		return store.default
	} catch {
		return undefined
	}
}
