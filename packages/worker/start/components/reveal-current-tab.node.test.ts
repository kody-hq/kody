import { expect, test } from 'vitest'
import { revealCurrentTab } from './reveal-current-tab.ts'

function tabRow(input: {
	clientWidth: number
	current?: { offsetLeft: number; offsetWidth: number }
}) {
	return {
		clientWidth: input.clientWidth,
		scrollLeft: 0,
		querySelector: () => (input.current ?? null) as never,
	}
}

test('scrolls an offscreen current tab into view', () => {
	const row = tabRow({
		clientWidth: 300,
		current: { offsetLeft: 380, offsetWidth: 80 },
	})
	revealCurrentTab(row)
	expect(row.scrollLeft).toBe(200)
})

test('leaves the row alone when the current tab already fits', () => {
	const row = tabRow({
		clientWidth: 300,
		current: { offsetLeft: 100, offsetWidth: 80 },
	})
	revealCurrentTab(row)
	expect(row.scrollLeft).toBe(0)
})

test('does nothing without a current tab', () => {
	const row = tabRow({ clientWidth: 300 })
	revealCurrentTab(row)
	expect(row.scrollLeft).toBe(0)
})
