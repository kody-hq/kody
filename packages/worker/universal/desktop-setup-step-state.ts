import { setup, types } from 'xstate'
import { resetUi, updateUi } from './ui-context.ts'
type StepEvent = { data: Record<string, never>; requestId?: unknown }
export type DesktopSetupWizardStep =
	| 'overview'
	| 'register'
	| 'attach'
	| 'done'
	| 'forget'

export const desktopSetupStepState = setup({
	schemas: {
		context: types<{ data: Record<string, never>; requestId: unknown }>(),
		events: {
			REGISTER: types<StepEvent>(),
			ATTACH: types<StepEvent>(),
			COMPLETE: types<StepEvent>(),
			FORGET: types<StepEvent>(),
			RESET: types<StepEvent>(),
		},
	},
}).createMachine({
	id: 'desktop.setup_step',
	description:
		'The resumable setup wizard registers a personal machine before optional team attachment and permits explicit reset or forget.',
	initial: 'overview',
	context: { data: {}, requestId: undefined },
	states: {
		overview: {
			on: {
				REGISTER: { target: 'register', context: updateUi },
				ATTACH: { target: 'attach', context: updateUi },
				COMPLETE: { target: 'done', context: updateUi },
				FORGET: { target: 'forget', context: updateUi },
			},
		},
		register: {
			on: {
				ATTACH: { target: 'attach', context: updateUi },
				COMPLETE: { target: 'done', context: updateUi },
				FORGET: { target: 'forget', context: updateUi },
				RESET: { target: 'overview', context: resetUi },
			},
		},
		attach: {
			on: {
				COMPLETE: { target: 'done', context: updateUi },
				FORGET: { target: 'forget', context: updateUi },
				RESET: { target: 'overview', context: resetUi },
			},
		},
		done: {
			on: {
				FORGET: { target: 'forget', context: updateUi },
				RESET: { target: 'overview', context: resetUi },
			},
		},
		forget: {
			on: {
				RESET: { target: 'overview', context: resetUi },
			},
		},
	},
})
