import { expect, test } from 'vitest'
import {
	collectYoutubeVideoIdsFromHrefs,
	mergeYoutubeWatchAllowlist,
	parseYoutubePlaylistFeedXml,
	parseYoutubePlaylistIdList,
	parseYoutubeVideoId,
	parseYoutubeVideoIdList,
	parseYoutubeWatchSearch,
	stripYoutubeWatchSearch,
	youtubeThumbPath,
	youtubeWatchHref,
} from './youtube-watch.ts'

const videoId = 'QA0xYMAMjEg'

test('parseYoutubeVideoId accepts watch, short, embed, thumb, and raw ids and ignores non-YouTube hosts', () => {
	const accepted = [
		videoId,
		`https://www.youtube.com/watch?v=${videoId}&list=PLV5CVI1eNcJhP4nrJt85L7PxHjebFpDfY`,
		`https://youtu.be/${videoId}`,
		`https://www.youtube.com/embed/${videoId}`,
		`https://www.youtube-nocookie.com/embed/${videoId}?rel=0`,
		`https://www.youtube.com/shorts/${videoId}`,
		`/?youtubeId=${videoId}`,
		`/blog?youtubeId=${videoId}`,
		youtubeThumbPath(videoId),
		`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
	]
	expect(
		accepted.filter((input) => parseYoutubeVideoId(input) !== videoId),
	).toEqual([])
	const rejected = [
		'https://example.com/watch?v=nope',
		'not-a-video-id',
		`https://example.test/?video=${videoId}`,
		`https://example.test/?youtubeId=${videoId}`,
		`https://notyoutube.com/watch?v=${videoId}`,
		`https://kody.codes/?youtubeId=${videoId}`,
		`/?video=${videoId}`,
	]
	expect(
		rejected.filter((input) => parseYoutubeVideoId(input) !== null),
	).toEqual([])
})

test('watch search helpers read and strip only the youtubeId param', () => {
	expect(parseYoutubeWatchSearch(`?youtubeId=${videoId}&utm=1`)).toBe(videoId)
	expect(parseYoutubeWatchSearch('?utm=1')).toBeNull()
	expect(parseYoutubeWatchSearch(`?video=${videoId}`)).toBeNull()
	expect(stripYoutubeWatchSearch('/', `?youtubeId=${videoId}&utm=1`)).toBe(
		'/?utm=1',
	)
	expect(stripYoutubeWatchSearch('/blog', `?youtubeId=${videoId}`)).toBe(
		'/blog',
	)
})

test('playlist and extra-id lists ignore junk and treat none as empty', () => {
	expect(parseYoutubePlaylistIdList(undefined)).toEqual([])
	expect(parseYoutubePlaylistIdList('none')).toEqual([])
	expect(
		parseYoutubePlaylistIdList(
			'PLV5CVI1eNcJhP4nrJt85L7PxHjebFpDfY, not-a-list, PLV5CVI1eNcJhP4nrJt85L7PxHjebFpDfY',
		),
	).toEqual(['PLV5CVI1eNcJhP4nrJt85L7PxHjebFpDfY'])
	expect(parseYoutubeVideoIdList(`${videoId}, nope, ${videoId}`)).toEqual([
		videoId,
	])
})

test('playlist Atom feed parser reads yt:videoId entries', () => {
	expect(
		parseYoutubePlaylistFeedXml(
			`<feed><entry><yt:videoId>${videoId}</yt:videoId></entry><entry><yt:videoId>abcdefghijk</yt:videoId></entry></feed>`,
		),
	).toEqual([videoId, 'abcdefghijk'])
})

test('allowlist merge includes playlist, extra ids, and YouTube hrefs', () => {
	expect(
		mergeYoutubeWatchAllowlist({
			playlistVideoIds: [videoId],
			extraVideoIds: ['dQw4w9wgvcQ'],
			hrefs: [
				youtubeWatchHref('oHg5SJYRHA0'),
				`https://youtu.be/${videoId}`,
				null,
			],
		}),
	).toEqual([videoId, 'dQw4w9wgvcQ', 'oHg5SJYRHA0'])
	expect(
		collectYoutubeVideoIdsFromHrefs([youtubeThumbPath(videoId), '/pricing']),
	).toEqual([videoId])
})
