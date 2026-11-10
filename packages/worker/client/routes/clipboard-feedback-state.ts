import { setup, types } from 'xstate'
import {
	resetUi,
	startUi,
	type UiContext,
	type UiEvent,
} from '#client/ui-actor.ts'
export type ClipboardFeedbackState = {
	status: 'idle' | 'copying' | 'copied' | 'error'
}
export type CopyState = Exclude<
	'idle' | 'copying' | 'copied' | 'error',
	'copying'
>

export const clipboardFeedbackState = setup({
	schemas: {
		context: types<UiContext<ClipboardFeedbackState>>(),
		events: {
			COPY: types<UiEvent<ClipboardFeedbackState, 'copying'>>(),
			RESPONSE_OK: types<UiEvent<ClipboardFeedbackState, 'copied'>>(),
			RESPONSE_ERROR: types<UiEvent<ClipboardFeedbackState, 'error'>>(),
			RESET: types<UiEvent<ClipboardFeedbackState, 'idle'>>(),
		},
	},
	guards: { currentRequest: (a: unknown, b: unknown) => a === b },
}).createMachine({
	id: 'clipboard.ui_feedback',
	description:
		'One clipboard write owns feedback until success or failure; its transient label resets after the feedback interval.',
	initial: 'idle',
	context: { data: {}, requestId: undefined },
	states: {
		idle: {
			on: {
				COPY: { target: 'copying', context: startUi },
			},
		},
		copying: {
			on: {
				RESPONSE_OK: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'copied', context: { data: event.data } }
				},
				RESPONSE_ERROR: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'error', context: { data: event.data } }
				},
			},
		},
		copied: {
			on: {
				COPY: { target: 'copying', context: startUi },
				RESET: { target: 'idle', context: resetUi },
			},
		},
		error: {
			on: {
				COPY: { target: 'copying', context: startUi },
				RESET: { target: 'idle', context: resetUi },
			},
		},
	},
})
