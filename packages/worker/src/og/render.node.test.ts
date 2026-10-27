import { expect, test } from 'vitest'
import { truncateOgText, withBalancedTextWrap } from './render.ts'

test('truncateOgText collapses whitespace, breaks on word boundaries, and hard-cuts long words', () => {
	expect(truncateOgText('  Kody   the koala ', 40)).toBe('Kody the koala')

	const excerpt =
		'Those things should live somewhere durable that you own, no matter which host'
	// Ends on a whole word, and the dangling comma goes with it. The old
	// character-count cut produced "…that you own, no m…".
	expect(truncateOgText(excerpt, 60)).toBe(
		'Those things should live somewhere durable that you own…',
	)

	expect(truncateOgText('supercalifragilisticexpialidocious tail', 12)).toBe(
		'supercalifr…',
	)

	expect(
		truncateOgText(
			"For all the agents you use today,\nand the ones you'll use tomorrow",
			160,
		),
	).toBe("For all the agents you use today,\nand the ones you'll use tomorrow")
})

test('withBalancedTextWrap balances text blocks but leaves runs and opt-outs alone', () => {
	expect(
		withBalancedTextWrap('div', { style: { fontSize: 30 } }, ['Some copy']),
	).toEqual({ style: { fontSize: 30, textWrap: 'balance' } })
	// Containers without their own text are left to their children.
	const nested = { style: {} }
	expect(
		withBalancedTextWrap('div', nested, [{ type: 'div', props: {} }]),
	).toBe(nested)
	// Emphasis runs sit side by side in a no-wrap row.
	const run = { style: { color: 'green' } }
	expect(withBalancedTextWrap('span', run, ['cloud'])).toBe(run)
	const nowrap = { style: { whiteSpace: 'nowrap' } }
	expect(withBalancedTextWrap('div', nowrap, ['memory'])).toBe(nowrap)
	const authored = { style: { textWrap: 'wrap' } }
	expect(withBalancedTextWrap('div', authored, ['As written'])).toBe(authored)
})
