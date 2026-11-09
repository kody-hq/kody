import {
	defineStateMachine,
	type StateOf,
} from '@kody-internal/shared/state-machine.ts'
export const desktopSetupStepState = defineStateMachine({
	name: 'desktop.setup_step',
	description:
		'The resumable setup wizard registers a personal machine before optional team attachment and permits explicit reset or forget.',
	initial: 'overview',
	transitions: {
		overview: ['overview', 'register', 'attach', 'done', 'forget'],
		register: ['register', 'overview', 'attach', 'done', 'forget'],
		attach: ['attach', 'overview', 'done', 'forget'],
		done: ['done', 'overview', 'forget'],
		forget: ['forget', 'overview'],
	},
})
export type DesktopSetupWizardStep = StateOf<typeof desktopSetupStepState>
