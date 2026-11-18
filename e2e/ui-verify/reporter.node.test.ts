import { expect, test } from 'vitest'
import { summarizeFailure } from './reporter.ts'

test('keeps the labelled line and each listed axe or keyboard problem', () => {
	const message = [
		'Error: keyboard: tabbing through / (light, desktop) found stops without a visible focus indicator.',
		'',
		'\u001b[2mexpect(\u001b[22mreceived\u001b[2m).toEqual(\u001b[22mexpected\u001b[2m)\u001b[22m',
		'- Array []',
		'+ Array [',
		'+   "<div role=\\"listbox\\"> \\"Watch Some Demos\\": no visible focus indicator",',
		'+ ]',
	].join('\n')
	expect(summarizeFailure(message)).toEqual([
		'keyboard: tabbing through / (light, desktop) found stops without a visible focus indicator.',
		'  - <div role="listbox"> "Watch Some Demos": no visible focus indicator',
	])
})

test('reports a visual diff once and turns a missing baseline into the update command', () => {
	expect(
		summarizeFailure(
			[
				'Error: visual: / (light, mobile) no longer matches its baseline.',
				'  7679 pixels (ratio 0.01 of all image pixels) are different.',
				'Call log:',
				'+   "7679 pixels (ratio 0.01 of all image pixels) are different.",',
			].join('\n'),
		),
	).toEqual([
		'visual: / (light, mobile) no longer matches its baseline.',
		'  7679 pixels (ratio 0.01 of all image pixels) are different.',
	])
	expect(
		summarizeFailure(
			"Error: A snapshot doesn't exist at /repo/e2e/ui-verify/baselines/x.png, writing actual.",
		),
	).toEqual([
		'  No baseline yet. Create it with `npm run ui:verify -- --update` and commit it.',
	])
})

test('falls back to the first line for unexpected errors', () => {
	expect(
		summarizeFailure('Error: Failed to seed user (400)\n    at stack'),
	).toEqual(['Error: Failed to seed user (400)'])
})
