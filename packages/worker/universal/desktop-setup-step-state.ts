import { setup, types } from 'xstate'
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
			REGISTER: types<{ data: Record<string, never>; requestId?: unknown }>(),
			ATTACH: types<{ data: Record<string, never>; requestId?: unknown }>(),
			COMPLETE: types<{ data: Record<string, never>; requestId?: unknown }>(),
			FORGET: types<{ data: Record<string, never>; requestId?: unknown }>(),
			RESET: types<{ data: Record<string, never>; requestId?: unknown }>(),
		},
	},
}).createMachine({
	id: 'desktop.setup_step',
	description:
		'The resumable setup wizard registers a personal machine before optional team attachment and permits explicit reset or forget.',
	initial: 'overview',
	context: { data: {} as Record<string, never>, requestId: undefined },
	states: {
		overview: {
			on: {
				REGISTER: {
					target: 'register',
					context: ({ event }) => ({ data: event.data }),
				},
				ATTACH: {
					target: 'attach',
					context: ({ event }) => ({ data: event.data }),
				},
				COMPLETE: {
					target: 'done',
					context: ({ event }) => ({ data: event.data }),
				},
				FORGET: {
					target: 'forget',
					context: ({ event }) => ({ data: event.data }),
				},
			},
		},
		register: {
			on: {
				ATTACH: {
					target: 'attach',
					context: ({ event }) => ({ data: event.data }),
				},
				COMPLETE: {
					target: 'done',
					context: ({ event }) => ({ data: event.data }),
				},
				FORGET: {
					target: 'forget',
					context: ({ event }) => ({ data: event.data }),
				},
				RESET: {
					target: 'overview',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		attach: {
			on: {
				COMPLETE: {
					target: 'done',
					context: ({ event }) => ({ data: event.data }),
				},
				FORGET: {
					target: 'forget',
					context: ({ event }) => ({ data: event.data }),
				},
				RESET: {
					target: 'overview',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		done: {
			on: {
				FORGET: {
					target: 'forget',
					context: ({ event }) => ({ data: event.data }),
				},
				RESET: {
					target: 'overview',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		forget: {
			on: {
				RESET: {
					target: 'overview',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
	},
})
