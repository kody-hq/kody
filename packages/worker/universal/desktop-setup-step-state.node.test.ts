import { canHandle } from '@kody-internal/shared/state-machine.ts'
import { expect, test } from 'vitest'
import { desktopSetupStepState } from './desktop-setup-step-state.ts'
test('setup wizard cannot re-enter register from attach, done, or forget', () => {
	expect(canHandle(desktopSetupStepState, 'overview', 'REGISTER')).toBe(true)
	expect(canHandle(desktopSetupStepState, 'register', 'ATTACH')).toBe(true)
	expect(canHandle(desktopSetupStepState, 'attach', 'REGISTER')).toBe(false)
	expect(canHandle(desktopSetupStepState, 'done', 'REGISTER')).toBe(false)
	expect(canHandle(desktopSetupStepState, 'forget', 'RESET')).toBe(true)
	expect(canHandle(desktopSetupStepState, 'forget', 'COMPLETE')).toBe(false)
})
