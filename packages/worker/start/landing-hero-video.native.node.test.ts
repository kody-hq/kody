import { jsx } from '@emotion/react/jsx-runtime'
import { renderStartPage as renderToString } from './test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import {
	chooserOverflow,
	LandingHeroVideo,
	nextChooserIndex,
} from './components/landing-hero-video.tsx'

const fixtureVideos = [
	{
		videoId: 'iGMkgjXc8Ho',
		title: 'Build in Cursor, then run it from Claude Code or ChatGPT',
	},
	{
		videoId: 'QA0xYMAMjEg',
		title: 'Introducing Kody: Your Personal Software Factory',
	},
	{
		videoId: 'o5L5OprLhBg',
		title: 'Kody fixes a Stripe webhook after we renamed the domain',
	},
	{
		videoId: 'OZKDO9Pzmo0',
		title: 'Shade automation from an INTENT.md',
	},
] as const

test('nextChooserIndex moves along the strip, wraps at the ends, ignores other keys', () => {
	expect(nextChooserIndex(0, 'ArrowRight', 3)).toBe(1)
	expect(nextChooserIndex(0, 'ArrowDown', 3)).toBe(1)
	expect(nextChooserIndex(2, 'ArrowRight', 3)).toBe(0)
	expect(nextChooserIndex(1, 'ArrowLeft', 3)).toBe(0)
	expect(nextChooserIndex(1, 'ArrowUp', 3)).toBe(0)
	expect(nextChooserIndex(0, 'ArrowLeft', 3)).toBe(2)
	expect(nextChooserIndex(1, 'Home', 3)).toBe(0)
	expect(nextChooserIndex(1, 'End', 3)).toBe(2)
	expect(nextChooserIndex(1, 'Enter', 3)).toBeNull()
	expect(nextChooserIndex(1, 'a', 3)).toBeNull()
	expect(nextChooserIndex(0, 'ArrowRight', 0)).toBeNull()
})

test('chooserOverflow only reports an edge when there is content past it', () => {
	const fits = { scrollLeft: 0, clientWidth: 400, scrollWidth: 400 }
	expect(chooserOverflow(fits)).toEqual({ start: false, end: false })
	const atStart = { scrollLeft: 0, clientWidth: 400, scrollWidth: 900 }
	expect(chooserOverflow(atStart)).toEqual({ start: false, end: true })
	const middle = { scrollLeft: 200, clientWidth: 400, scrollWidth: 900 }
	expect(chooserOverflow(middle)).toEqual({ start: true, end: true })
	const atEnd = { scrollLeft: 500, clientWidth: 400, scrollWidth: 900 }
	expect(chooserOverflow(atEnd)).toEqual({ start: true, end: false })
	// Sub-pixel scroll positions do not flicker the fades.
	const nearlyEnd = { scrollLeft: 499.5, clientWidth: 400, scrollWidth: 900 }
	expect(chooserOverflow(nearlyEnd)).toEqual({ start: true, end: false })
})

test('hero video renders playlist order in the player and listbox', async () => {
	const html = await renderToString(
		jsx(LandingHeroVideo, { videos: fixtureVideos }),
	)
	const [first, ...rest] = fixtureVideos

	// Poster, not an embed, until the visitor clicks.
	expect(html).not.toContain('youtube-nocookie.com')
	expect(html).toContain('data-testid="landing-hero-video-play"')

	expect(html).toContain('role="listbox"')
	expect(html).toMatch(/tabindex="0"/i)
	expect(html.match(/role="option"/g)).toHaveLength(fixtureVideos.length)
	expect(html.match(/aria-selected="true"/g)).toHaveLength(1)
	expect(html).toContain(`/youtube-thumb/${first.videoId}`)
	for (const video of rest) {
		expect(html).toContain(`/youtube-thumb/${video.videoId}`)
	}

	const optionThumbs = [
		...html.matchAll(
			/role="option"[\s\S]*?\/youtube-thumb\/([A-Za-z0-9_-]{11})/g,
		),
	].map((match) => match[1])
	expect(optionThumbs).toEqual(fixtureVideos.map((video) => video.videoId))
	expect(html).toContain(first.title)
	expect(html).toContain(rest[0]?.title)
	expect(html).not.toContain('data-embed-playlist')
})

test('hero video is omitted when the playlist is empty', async () => {
	const html = await renderToString(jsx(LandingHeroVideo, { videos: [] }))
	expect(html.replace(/<!--.*?-->/g, '')).toBe('')
})
