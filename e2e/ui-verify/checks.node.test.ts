import { expect, test } from 'vitest'
import { describeFocusProblems } from './checks.ts'

test('describeFocusProblems lists stops without an indicator or size', () => {
	expect(
		describeFocusProblems({
			stops: [
				{ description: '<a> "Docs"', hasIndicator: true, onScreen: true },
				{ description: '<button> "Save"', hasIndicator: false, onScreen: true },
				{
					description: '<input> (no text)',
					hasIndicator: true,
					onScreen: false,
				},
			],
			truncated: null,
		}),
	).toEqual([
		'<button> "Save": no visible focus indicator',
		'<input> (no text): receives focus but has no size',
	])
})

test('describeFocusProblems fails a sweep that hit the stop limit', () => {
	expect(describeFocusProblems({ stops: [], truncated: 80 })).toEqual([
		expect.stringContaining('stopped after 80 focus stops'),
	])
})
