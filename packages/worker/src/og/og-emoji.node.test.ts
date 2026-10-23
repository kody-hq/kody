import { expect, test, vi } from 'vitest'
import {
	emojiToTwemojiCodes,
	loadAdditionalOgAsset,
	loadTwemojiDataUri,
	resetTwemojiCache,
} from './og-emoji.ts'

const TWEMOJI_KOALA_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"><path fill="#99AAB5" d="M36 13.533C36 8.867 32.866 7 29 7z"/></svg>'

test('Twemoji OG helpers map codes, fetch/cache SVG data URIs, and ignore non-emoji', async () => {
	expect.hasAssertions()
	expect(emojiToTwemojiCodes('🐨')).toEqual(['1f428'])
	expect(emojiToTwemojiCodes('❤️')).toEqual(['2764', '2764-fe0f'])
	expect(emojiToTwemojiCodes('👨‍💻')).toEqual(['1f468-200d-1f4bb'])
	expect(emojiToTwemojiCodes('')).toEqual([])

	resetTwemojiCache()

	const fetchSpy = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (input) => {
			const url = String(input)
			if (url.endsWith('/1f428.svg')) {
				return new Response(TWEMOJI_KOALA_SVG, { status: 200 })
			}
			if (url.endsWith('/2764.svg')) {
				return new Response(null, { status: 404 })
			}
			if (url.endsWith('/2764-fe0f.svg')) {
				return new Response(
					'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36"></svg>',
					{ status: 200 },
				)
			}
			throw new Error(`unexpected fetch: ${url}`)
		})

	try {
		const koala = await loadTwemojiDataUri('🐨')
		expect(koala.startsWith('data:image/svg+xml;base64,')).toBe(true)
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(fetchSpy.mock.calls[0]?.[1]).toEqual(
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		)

		const koalaAgain = await loadTwemojiDataUri('🐨')
		expect(koalaAgain).toBe(koala)
		expect(fetchSpy).toHaveBeenCalledTimes(1)

		const heart = await loadTwemojiDataUri('❤️')
		expect(heart.startsWith('data:image/svg+xml;base64,')).toBe(true)
		expect(fetchSpy).toHaveBeenCalledTimes(3)

		expect(await loadAdditionalOgAsset('emoji', '🐨')).toBe(koala)
		expect(await loadAdditionalOgAsset('unknown', '中')).toBe('')

		fetchSpy.mockImplementation(async () => {
			throw new Error('network down')
		})
		expect(await loadTwemojiDataUri('🔥')).toBe('')
	} finally {
		fetchSpy.mockRestore()
		resetTwemojiCache()
	}
})
