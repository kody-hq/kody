import { setup, assign } from 'xstate'
import type { UiContext, UiData, UiPayload } from '#client/ui-actor.ts'
export type ClipboardFeedbackState = {
	status: 'idle' | 'copying' | 'copied' | 'error'
}
export type CopyState = Exclude<
	'idle' | 'copying' | 'copied' | 'error',
	'copying'
>

export const clipboardFeedbackState = setup({
	types: {
		context: {} as UiContext<ClipboardFeedbackState>,
		events: {} as
			| {
					type: 'COPY'
					data: UiPayload<ClipboardFeedbackState, 'copying'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_OK'
					data: UiPayload<ClipboardFeedbackState, 'copied'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_ERROR'
					data: UiPayload<ClipboardFeedbackState, 'error'>
					requestId?: unknown
			  }
			| {
					type: 'RESET'
					data: UiPayload<ClipboardFeedbackState, 'idle'>
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
	id: 'clipboard.ui_feedback',
	description:
		'One clipboard write owns feedback until success or failure; its transient label resets after the feedback interval.',
	initial: 'idle',
	context: { data: {} as UiData<ClipboardFeedbackState>, requestId: undefined },
	states: {
		idle: { on: { COPY: { target: 'copying', actions: 'start' } } },
		copying: {
			on: {
				RESPONSE_OK: {
					target: 'copied',
					guard: 'currentRequest',
					actions: 'update',
				},
				RESPONSE_ERROR: {
					target: 'error',
					guard: 'currentRequest',
					actions: 'update',
				},
			},
		},
		copied: {
			on: {
				COPY: { target: 'copying', actions: 'start' },
				RESET: { target: 'idle', actions: 'reset' },
			},
		},
		error: {
			on: {
				COPY: { target: 'copying', actions: 'start' },
				RESET: { target: 'idle', actions: 'reset' },
			},
		},
	},
})
