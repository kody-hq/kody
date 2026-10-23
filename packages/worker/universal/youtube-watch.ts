const youtubeWatchSearchParam = 'youtubeId'
const youtubeThumbPathPrefix = '/youtube-thumb/'
const youtubeVideoIdPattern = /^[A-Za-z0-9_-]{11}$/
export const youtubeWatchSampleVideoId = 'QA0xYMAMjEg'
const youtubePlaylistIdPattern = /^PL[A-Za-z0-9_-]{10,}$/
export const youtubePlaylistFeedCacheSeconds = 60 * 60

const youtubeHostSuffixes = [
	'youtube.com',
	'youtube-nocookie.com',
	'youtu.be',
	'ytimg.com',
] as const

export function isYoutubeVideoId(value: string): boolean {
	return youtubeVideoIdPattern.test(value)
}

function isYoutubePlaylistId(value: string): boolean {
	return youtubePlaylistIdPattern.test(value)
}

export function youtubeWatchHref(videoId: string): string {
	return `/?${youtubeWatchSearchParam}=${videoId}`
}

export function youtubeThumbPath(videoId: string): string {
	return `${youtubeThumbPathPrefix}${videoId}`
}

const youtubeThumbnailFileNames = [
	'maxresdefault.jpg',
	'sddefault.jpg',
	'hqdefault.jpg',
] as const

export function youtubeThumbnailSourceUrls(videoId: string): Array<string> {
	return youtubeThumbnailFileNames.map((fileName) =>
		youtubeThumbnailUrl(videoId, fileName),
	)
}

function youtubeThumbnailUrl(
	videoId: string,
	fileName: (typeof youtubeThumbnailFileNames)[number],
): string {
	return `https://i.ytimg.com/vi/${videoId}/${fileName}`
}

export function youtubePlaylistFeedUrl(playlistId: string): string {
	return `https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(playlistId)}`
}

export function youtubeNocookieEmbedUrl(
	videoId: string,
	options?: { playlistId?: string },
): string {
	const params = new URLSearchParams({ autoplay: '1', rel: '0' })
	const playlistId = options?.playlistId?.trim()
	if (playlistId && isYoutubePlaylistId(playlistId)) {
		params.set('listType', 'playlist')
		params.set('list', playlistId)
	}
	return `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`
}

export function parseYoutubeVideoId(input: string): string | null {
	const trimmed = input.trim()
	if (!trimmed) return null
	if (isYoutubeVideoId(trimmed)) return trimmed

	const url = parseAbsoluteOrRelativeUrl(trimmed)
	if (!url) return null

	const relative = isAppRelativeHref(trimmed)
	if (!relative && !isYoutubeFamilyHost(url.hostname)) return null

	if (relative) {
		return (
			readVideoIdParam(url.searchParams.get(youtubeWatchSearchParam)) ??
			readYoutubeThumbPathId(url.pathname)
		)
	}

	const fromQuery =
		readVideoIdParam(url.searchParams.get('v')) ??
		readVideoIdParam(url.searchParams.get(youtubeWatchSearchParam))
	if (fromQuery) return fromQuery

	const segments = url.pathname.split('/').filter(Boolean)
	if (isYoutubeHost(url.hostname, 'youtu.be')) {
		const shortId = segments[0]
		return shortId && isYoutubeVideoId(shortId) ? shortId : null
	}

	for (let index = 0; index < segments.length - 1; index += 1) {
		const segment = segments[index]
		if (
			segment === 'embed' ||
			segment === 'shorts' ||
			segment === 'live' ||
			segment === 'vi'
		) {
			const next = segments[index + 1]
			const videoId = next?.replace(/\.(jpg|jpeg|png|webp)$/i, '')
			if (videoId && isYoutubeVideoId(videoId)) return videoId
		}
	}

	return null
}

export function parseYoutubeWatchSearch(search: string): string | null {
	const params = new URLSearchParams(
		search.startsWith('?') ? search.slice(1) : search,
	)
	return readVideoIdParam(params.get(youtubeWatchSearchParam))
}

export function stripYoutubeWatchSearch(
	pathname: string,
	search: string,
): string {
	const params = new URLSearchParams(
		search.startsWith('?') ? search.slice(1) : search,
	)
	params.delete(youtubeWatchSearchParam)
	const query = params.toString()
	return query ? `${pathname}?${query}` : pathname
}

export function parseYoutubePlaylistIdList(
	value: string | undefined,
): Array<string> {
	if (value === undefined) return []
	const trimmed = value.trim()
	if (!trimmed || trimmed === 'none') return []
	return uniqueStrings(
		trimmed
			.split(/[\s,]+/)
			.map((item) => item.trim())
			.filter(isYoutubePlaylistId),
	)
}

export function parseYoutubeVideoIdList(
	value: string | undefined,
): Array<string> {
	if (!value) return []
	return uniqueStrings(
		value
			.split(/[\s,]+/)
			.map((item) => parseYoutubeVideoId(item))
			.filter((item): item is string => item !== null),
	)
}

export function parseYoutubePlaylistFeedXml(xml: string): Array<string> {
	const ids: Array<string> = []
	const pattern = /<yt:videoId>([A-Za-z0-9_-]{11})<\/yt:videoId>/g
	for (const match of xml.matchAll(pattern)) {
		const videoId = match[1]
		if (videoId && isYoutubeVideoId(videoId)) ids.push(videoId)
	}
	return uniqueStrings(ids)
}

export function collectYoutubeVideoIdsFromHrefs(
	hrefs: ReadonlyArray<string | null | undefined>,
): Array<string> {
	return uniqueStrings(
		hrefs
			.map((href) => (href ? parseYoutubeVideoId(href) : null))
			.filter((item): item is string => item !== null),
	)
}

export function mergeYoutubeWatchAllowlist(input: {
	playlistVideoIds: ReadonlyArray<string>
	extraVideoIds: ReadonlyArray<string>
	hrefs: ReadonlyArray<string | null | undefined>
}): Array<string> {
	return uniqueStrings([
		...input.playlistVideoIds.filter(isYoutubeVideoId),
		...input.extraVideoIds.filter(isYoutubeVideoId),
		...collectYoutubeVideoIdsFromHrefs(input.hrefs),
	])
}

function readVideoIdParam(value: string | null): string | null {
	if (!value) return null
	return isYoutubeVideoId(value) ? value : null
}

function isAppRelativeHref(value: string): boolean {
	return value.startsWith('/') || value.startsWith('?')
}

function parseAbsoluteOrRelativeUrl(value: string): URL | null {
	try {
		if (isAppRelativeHref(value)) {
			return new URL(value, 'https://kody.codes')
		}
		return new URL(value)
	} catch {
		return null
	}
}

function isYoutubeFamilyHost(hostname: string): boolean {
	return youtubeHostSuffixes.some((suffix) => isYoutubeHost(hostname, suffix))
}

function readYoutubeThumbPathId(pathname: string): string | null {
	if (!pathname.startsWith(youtubeThumbPathPrefix)) return null
	const id = pathname.slice(youtubeThumbPathPrefix.length).split('/')[0]
	return id && isYoutubeVideoId(id) ? id : null
}

function isYoutubeHost(hostname: string, suffix: string): boolean {
	const host = hostname.toLowerCase()
	return host === suffix || host.endsWith(`.${suffix}`)
}

function uniqueStrings(values: ReadonlyArray<string>): Array<string> {
	return [...new Set(values)]
}
