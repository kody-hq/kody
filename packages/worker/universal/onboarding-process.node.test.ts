import { expect, test } from 'vitest'
import {
	onboardingAccessLede,
	onboardingAccessSelectedLede,
	onboardingStep2Prompt,
} from './onboarding-process.ts'

test('Step 2 prompt inspects this agent first and falls back to first-win ideas', () => {
	expect(onboardingStep2Prompt).toBe(
		"I'm on Kody onboarding Step 2. Look up the onboarding guide with search({ entity: \"guide:onboarding\" }). First, look at what's already in this agent: connections, skills, memories, instructions, and repeating processes. Propose a few that would be more useful if they lived in Kody, wait for my pick, and help me move one. If this agent doesn't have much to move, offer the guide's first-win ideas instead, wait for my pick, then do one small win.",
	)
})

test('Step 2 ledes describe moving into Kody before first-win ideas, without em dashes', () => {
	const ledes = [
		onboardingAccessLede,
		onboardingAccessSelectedLede('Claude Code'),
		onboardingAccessSelectedLede(null),
	]
	for (const lede of ledes) {
		expect(lede).toContain('move into Kody')
		expect(lede).toContain('first-win ideas')
		expect(lede).not.toContain('\u2014')
	}
	expect(onboardingAccessLede).toContain('not a service gateway')
	expect(onboardingAccessSelectedLede('Claude Code')).toContain(
		'Copy this prompt into Claude Code.',
	)
})
