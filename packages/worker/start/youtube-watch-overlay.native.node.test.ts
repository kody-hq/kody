import { createElement as jsx } from 'react'
import { renderStartPage as renderToString } from './test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { YouTubeWatchOverlay } from './components/youtube-watch-overlay.tsx'
import {
	youtubeWatchHref,
	youtubeWatchSampleVideoId,
} from '#universal/youtube-watch.ts'

const videoId = youtubeWatchSampleVideoId

function renderOverlay(input: {
	url: string
	allowedVideoIds?: Array<string>
}) {
	const url = new URL(input.url, 'https://example.com')
	return renderToString(
		jsx(YouTubeWatchOverlay, {
			snapshot: { allowedVideoIds: input.allowedVideoIds ?? [videoId] },
			location: { pathname: url.pathname, searchStr: url.search },
		}),
		input.url,
	)
}

test('youtube watch overlay stays closed without an allowlisted youtubeId', async () => {
	expect(await renderOverlay({ url: '/' })).not.toContain(
		'data-testid="youtube-watch-overlay"',
	)
	expect(
		await renderOverlay({
			url: youtubeWatchHref(videoId),
			allowedVideoIds: ['dQw4w9wgvcQ'],
		}),
	).not.toContain('data-testid="youtube-watch-overlay"')
})

test('youtube watch overlay paints a poster for an allowlisted youtubeId', async () => {
	const html = await renderOverlay({ url: youtubeWatchHref(videoId) })
	expect(html).toContain('data-testid="youtube-watch-overlay"')
	expect(html).toContain(`data-video-id="${videoId}"`)
	expect(html).toContain(`/youtube-thumb/${videoId}`)
	expect(html).toContain('data-testid="youtube-watch-play"')
	expect(html).toContain('▶')
	expect(html).not.toContain('youtube-nocookie.com')
})
