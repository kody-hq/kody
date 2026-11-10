import { setup, assign } from 'xstate'
export type DesktopSetupWizardStep =
	| 'overview'
	| 'register'
	| 'attach'
	| 'done'
	| 'forget'

export const desktopSetupStepState = setup({
	types: {
		context: {} as { data: Record<string, never>; requestId: unknown },
		events: {} as
			| {
					type: 'REGISTER'
					data: Record<string, never>
					requestId?: unknown
			  }
			| {
					type: 'ATTACH'
					data: Record<string, never>
					requestId?: unknown
			  }
			| {
					type: 'COMPLETE'
					data: Record<string, never>
					requestId?: unknown
			  }
			| {
					type: 'FORGET'
					data: Record<string, never>
					requestId?: unknown
			  }
			| {
					type: 'RESET'
					data: Record<string, never>
					requestId?: unknown
			  },
	},
	guards: {
		currentRequest: ({ context, event }) =>
			context.requestId === event.requestId,
	},
	actions: {
		update: assign({ data: ({ event }) => event.data }),
		start: assign({
			data: ({ event }) => event.data,
			requestId: ({ event }) => event.requestId,
		}),
		reset: assign({ data: ({ event }) => event.data, requestId: undefined }),
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
				REGISTER: { target: 'register', actions: 'update' },
				ATTACH: { target: 'attach', actions: 'update' },
				COMPLETE: { target: 'done', actions: 'update' },
				FORGET: { target: 'forget', actions: 'update' },
			},
		},
		register: {
			on: {
				ATTACH: { target: 'attach', actions: 'update' },
				COMPLETE: { target: 'done', actions: 'update' },
				FORGET: { target: 'forget', actions: 'update' },
				RESET: { target: 'overview', actions: 'reset' },
			},
		},
		attach: {
			on: {
				COMPLETE: { target: 'done', actions: 'update' },
				FORGET: { target: 'forget', actions: 'update' },
				RESET: { target: 'overview', actions: 'reset' },
			},
		},
		done: {
			on: {
				FORGET: { target: 'forget', actions: 'update' },
				RESET: { target: 'overview', actions: 'reset' },
			},
		},
		forget: { on: { RESET: { target: 'overview', actions: 'reset' } } },
	},
})
