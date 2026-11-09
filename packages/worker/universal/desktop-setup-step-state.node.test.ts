import { expect, test } from 'vitest'
import { desktopSetupStepState } from './desktop-setup-step-state.ts'

test('setup wizard cannot re-enter register from attach, done, or forget', () => {
	expect(desktopSetupStepState.can('overview', 'register')).toBe(true)
	expect(desktopSetupStepState.can('register', 'attach')).toBe(true)
	expect(desktopSetupStepState.can('attach', 'register')).toBe(false)
	expect(desktopSetupStepState.can('done', 'register')).toBe(false)
	expect(desktopSetupStepState.can('forget', 'overview')).toBe(true)
	expect(desktopSetupStepState.can('forget', 'done')).toBe(false)
})
