import { expect, test } from 'vitest'
import { desktopSetupStepState } from './desktop-setup-step-state.ts'
test('desktop.setup_step graph', () => {
	expect(desktopSetupStepState.transitions).toEqual({
		overview: ['overview', 'register', 'attach', 'done', 'forget'],
		register: ['register', 'overview', 'attach', 'done', 'forget'],
		attach: ['attach', 'overview', 'done', 'forget'],
		done: ['done', 'overview', 'forget'],
		forget: ['forget', 'overview'],
	})
})
