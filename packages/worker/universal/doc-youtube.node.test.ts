import { expect, test } from 'vitest'
import {
	extractDocWatchMarkdown,
	listDocWatchEmbeds,
	parseDocWatchBlock,
} from './doc-youtube.ts'

const videoId = '_EJTrJFLa3g'
const block = [
	`> [!WATCH] https://www.youtube.com/watch?v=${videoId}`,
	'> Watch: Make your agent safe and autonomous',
].join('\n')

test('parseDocWatchBlock reads a youtube watch blockquote', () => {
	expect(parseDocWatchBlock(block)).toEqual({
		videoId,
		href: `https://www.youtube.com/watch?v=${videoId}`,
		label: 'Watch: Make your agent safe and autonomous',
		title: 'Make your agent safe and autonomous',
		vertical: false,
	})
	expect(
		parseDocWatchBlock(
			[
				`> [!WATCH] https://www.youtube.com/watch?v=${videoId} Watch: Make your agent`,
				'> safe and autonomous',
			].join('\n'),
		),
	).toMatchObject({
		videoId,
		title: 'Make your agent safe and autonomous',
	})
	expect(
		parseDocWatchBlock(
			[`[!WATCH] https://youtu.be/${videoId}`, 'Watch: Introducing Kody'].join(
				'\n',
			),
		)?.videoId,
	).toBe(videoId)
})

test('parseDocWatchBlock marks a [!WATCH-VERTICAL] block as vertical', () => {
	expect(
		parseDocWatchBlock(
			[
				`> [!WATCH-VERTICAL] https://www.youtube.com/watch?v=${videoId}`,
				'> Watch: A phone-shot video',
			].join('\n'),
		),
	).toEqual({
		videoId,
		href: `https://www.youtube.com/watch?v=${videoId}`,
		label: 'Watch: A phone-shot video',
		title: 'A phone-shot video',
		vertical: true,
	})
	expect(
		parseDocWatchBlock(
			`> [!WATCH-SIDEWAYS] https://www.youtube.com/watch?v=${videoId}\n> Watch: Nope`,
		),
	).toBeNull()
})

test('parseDocWatchBlock rejects non-youtube targets and bare markers', () => {
	expect(
		parseDocWatchBlock(
			'> [!WATCH] https://example.com/watch?v=_EJTrJFLa3g\n> Watch: Nope',
		),
	).toBeNull()
	expect(
		parseDocWatchBlock('> [!WATCH] _EJTrJFLa3g\n> Watch: Bare id'),
	).toBeNull()
	expect(parseDocWatchBlock('> [!TIP]\n> Prefer a fork.')).toBeNull()
	expect(
		parseDocWatchBlock('> [!WATCH] https://youtu.be/_EJTrJFLa3g'),
	).toBeNull()
})

test('listDocWatchEmbeds and extract keep one block and skip other quotes', () => {
	const markdown = [
		'Intro paragraph.',
		'',
		'> A normal quote.',
		'',
		block,
		'',
		'## Next',
	].join('\n')
	expect(listDocWatchEmbeds(markdown)).toHaveLength(1)
	expect(listDocWatchEmbeds(markdown)[0]?.videoId).toBe(videoId)
	expect(extractDocWatchMarkdown(markdown)).toBe(block)
	expect(listDocWatchEmbeds('No video here.')).toEqual([])
	expect(extractDocWatchMarkdown('No video here.')).toBe('')
})

test('extract keeps a following Also watch paragraph for interactive pages', () => {
	const markdown = [
		block,
		'',
		'Also watch:',
		'[Build once. Every agent can use it.](https://www.youtube.com/watch?v=QLpTHlQ15Zs).',
		'',
		'## The loop',
	].join('\n')
	expect(extractDocWatchMarkdown(markdown)).toBe(
		[
			block,
			'',
			'Also watch:',
			'[Build once. Every agent can use it.](https://www.youtube.com/watch?v=QLpTHlQ15Zs).',
		].join('\n'),
	)
	expect(listDocWatchEmbeds(markdown)).toHaveLength(1)
})
