import { expect, test, vi } from 'vitest'
import { createYoutubeThumbHandler } from './youtube-thumb.ts'
import { silenceExpectedConsoleWarns } from '#worker/test-support/console-spies.ts'

const videoId = 'QA0xYMAMjEg'

function callHandler(
	env: Env,
	id: string,
	method: 'GET' | 'HEAD' | 'POST' = 'GET',
) {
	const handler = createYoutubeThumbHandler(env)
	return handler({
		request: new Request(`https://example.com/youtube-thumb/${id}`, {
			method,
		}),
		params: { videoId: id },
		url: new URL(`https://example.com/youtube-thumb/${id}`),
	} as never)
}

function isYoutubeThumbUrl(url: string) {
	return url.includes('i.ytimg.com/vi/')
}

test('youtube thumb proxy 404s unknown and invalid ids', async () => {
	silenceExpectedConsoleWarns(['landing-hero-videos'])
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockRejectedValue(new Error('offline'))
	const env = {
		YOUTUBE_ALLOWED_PLAYLIST_IDS: 'none',
		YOUTUBE_ALLOWED_VIDEO_IDS: videoId,
	} as unknown as Env
	expect((await callHandler(env, 'not-valid')).status).toBe(404)
	expect((await callHandler(env, 'abcdefghijk')).status).toBe(404)
	expect((await callHandler(env, videoId, 'POST')).status).toBe(405)
	fetchMock.mockRestore()
})

test('youtube thumb proxy serves allowlisted first-party bytes', async () => {
	silenceExpectedConsoleWarns(['landing-hero-videos'])
	const bytes = Uint8Array.from([0xff, 0xd8, 0xff])
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input) => {
			const url = String(input)
			if (!isYoutubeThumbUrl(url)) {
				return new Response('Not Found', { status: 404 })
			}
			return new Response(bytes, { headers: { 'Content-Type': 'image/jpeg' } })
		})
	const env = {
		YOUTUBE_ALLOWED_PLAYLIST_IDS: 'none',
		YOUTUBE_ALLOWED_VIDEO_IDS: videoId,
	} as unknown as Env
	const response = await callHandler(env, videoId)
	expect(response.status).toBe(200)
	expect(response.headers.get('Content-Type')).toBe('image/jpeg')
	expect(response.headers.get('Cache-Control')).toContain('max-age=86400')
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
	expect(
		fetchMock.mock.calls
			.map(([input]) => String(input))
			.filter((url) => isYoutubeThumbUrl(url)),
	).toEqual([`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`])
	fetchMock.mockRestore()
})

test('youtube thumb proxy falls back when maxres is missing', async () => {
	silenceExpectedConsoleWarns(['landing-hero-videos'])
	const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xdb])
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input) => {
			const url = String(input)
			if (!isYoutubeThumbUrl(url)) {
				return new Response('Not Found', { status: 404 })
			}
			if (url.endsWith('/maxresdefault.jpg')) {
				return new Response('Not Found', { status: 404 })
			}
			if (url.endsWith('/sddefault.jpg')) {
				return new Response(bytes, {
					headers: { 'Content-Type': 'image/jpeg' },
				})
			}
			return new Response('Not Found', { status: 404 })
		})
	const env = {
		YOUTUBE_ALLOWED_PLAYLIST_IDS: 'none',
		YOUTUBE_ALLOWED_VIDEO_IDS: videoId,
	} as unknown as Env
	const response = await callHandler(env, videoId)
	expect(response.status).toBe(200)
	expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
	expect(
		fetchMock.mock.calls
			.map(([input]) => String(input))
			.filter((url) => isYoutubeThumbUrl(url)),
	).toEqual([
		`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
		`https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,
	])
	fetchMock.mockRestore()
})

test('youtube thumb proxy 404s when every thumbnail quality is missing', async () => {
	silenceExpectedConsoleWarns(['landing-hero-videos'])
	const fetchMock = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input) => {
			const url = String(input)
			if (!isYoutubeThumbUrl(url)) {
				return new Response('Not Found', { status: 404 })
			}
			return new Response('Not Found', { status: 404 })
		})
	const env = {
		YOUTUBE_ALLOWED_PLAYLIST_IDS: 'none',
		YOUTUBE_ALLOWED_VIDEO_IDS: videoId,
	} as unknown as Env
	expect((await callHandler(env, videoId)).status).toBe(404)
	expect(
		fetchMock.mock.calls
			.map(([input]) => String(input))
			.filter((url) => isYoutubeThumbUrl(url)),
	).toEqual([
		`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
		`https://i.ytimg.com/vi/${videoId}/sddefault.jpg`,
		`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
	])
	fetchMock.mockRestore()
})
