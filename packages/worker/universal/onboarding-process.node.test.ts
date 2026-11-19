import { expect, test } from 'vitest'
import {
	onboardingAccessLede,
	onboardingAccessSelectedLede,
	onboardingGuideHref,
	onboardingStep2Prompt,
} from './onboarding-process.ts'

test('Step 2 prompt inspects this agent first and falls back to first-win ideas', () => {
	const guideSlug = onboardingGuideHref.replace(/^\/docs\//, '')
	expect(onboardingStep2Prompt).toContain(
		`search({ entity: "guide:${guideSlug}" })`,
	)
	const inspectAt = onboardingStep2Prompt.indexOf(
		"what's already in this agent",
	)
	const firstWinAt = onboardingStep2Prompt.indexOf('first-win ideas')
	expect(inspectAt).toBeGreaterThan(-1)
	expect(firstWinAt).toBeGreaterThan(inspectAt)
	expect(onboardingStep2Prompt).not.toContain('\u2014')
})

test('Step 2 ledes describe moving into Kody before first-win ideas, without em dashes', () => {
	const named = onboardingAccessSelectedLede('Claude Code')
	const unnamed = onboardingAccessSelectedLede(null)
	for (const lede of [onboardingAccessLede, named, unnamed]) {
		const moveAt = lede.indexOf('move into Kody')
		const firstWinAt = lede.indexOf('first-win ideas')
		expect(moveAt).toBeGreaterThan(-1)
		expect(firstWinAt).toBeGreaterThan(moveAt)
		expect(lede).not.toContain('\u2014')
	}
	expect(onboardingAccessLede).toContain('not a service gateway')
	expect(named).toContain('Copy this prompt into Claude Code.')
	expect(unnamed).toContain('Copy this prompt into your agent.')
	expect(named).not.toContain('your agent')
})
