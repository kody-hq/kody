import { setup, types } from 'xstate'
import type { UiContext, UiData, UiPayload } from '#client/ui-actor.ts'
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
			COPY: types<{
				data: UiPayload<ClipboardFeedbackState, 'copying'>
				requestId?: unknown
			}>(),
			RESPONSE_OK: types<{
				data: UiPayload<ClipboardFeedbackState, 'copied'>
				requestId?: unknown
			}>(),
			RESPONSE_ERROR: types<{
				data: UiPayload<ClipboardFeedbackState, 'error'>
				requestId?: unknown
			}>(),
			RESET: types<{
				data: UiPayload<ClipboardFeedbackState, 'idle'>
				requestId?: unknown
			}>(),
		},
	},
}).createMachine({
	id: 'clipboard.ui_feedback',
	description:
		'One clipboard write owns feedback until success or failure; its transient label resets after the feedback interval.',
	initial: 'idle',
	context: { data: {} as UiData<ClipboardFeedbackState>, requestId: undefined },
	states: {
		idle: {
			on: {
				COPY: {
					target: 'copying',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
			},
		},
		copying: {
			on: {
				RESPONSE_OK: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<ClipboardFeedbackState>
						event: { type: 'RESPONSE_OK' } & {
							data: UiPayload<ClipboardFeedbackState, 'copied'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'copied', context: { data: event.data } }
					},
				},
				RESPONSE_ERROR: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<ClipboardFeedbackState>
						event: { type: 'RESPONSE_ERROR' } & {
							data: UiPayload<ClipboardFeedbackState, 'error'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'error', context: { data: event.data } }
					},
				},
			},
		},
		copied: {
			on: {
				COPY: {
					target: 'copying',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				RESET: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		error: {
			on: {
				COPY: {
					target: 'copying',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				RESET: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
	},
})
