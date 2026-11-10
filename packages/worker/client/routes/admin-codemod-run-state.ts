import { setup, types } from 'xstate'
import type { LiveRunItem } from './admin-codemods-shared.ts'
import {
	startUi,
	updateUi,
	type UiContext,
	type UiEvent,
} from '#client/ui-actor.ts'
export type RunPhase = Exclude<
	'idle' | 'running' | 'stopping' | 'complete' | 'error',
	'stopping'
>
type RunProgress = {
	runId: string | null
	items: Array<LiveRunItem>
	summary: Record<string, number>
}
export type AdminCodemodRunState =
	| { status: 'idle' }
	| (RunProgress &
			(
				| { status: 'running' | 'stopping' }
				| { status: 'complete' | 'error'; message: string }
			))

export const adminCodemodRunState = setup({
	schemas: {
		context: types<UiContext<AdminCodemodRunState>>(),
		events: {
			SUBMIT: types<UiEvent<AdminCodemodRunState, 'running'>>(),
			PROGRESS: types<UiEvent<AdminCodemodRunState, 'running' | 'stopping'>>(),
			STOP: types<UiEvent<AdminCodemodRunState, 'stopping'>>(),
			RESPONSE_OK: types<UiEvent<AdminCodemodRunState, 'complete'>>(),
			RESPONSE_ERROR: types<UiEvent<AdminCodemodRunState, 'error'>>(),
		},
	},
	guards: { currentRequest: (a: unknown, b: unknown) => a === b },
}).createMachine({
	id: 'admin_codemods.ui_run',
	description:
		'Paged execution owns its progress and terminal feedback; a requested stop is fenced until the current step and history reconciliation finish.',
	initial: 'idle',
	context: { data: {}, requestId: undefined },
	states: {
		idle: {
			on: {
				SUBMIT: { target: 'running', context: startUi },
			},
		},
		running: {
			on: {
				PROGRESS: { context: updateUi },
				STOP: { target: 'stopping', context: updateUi },
				RESPONSE_OK: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'complete', context: { data: event.data } }
				},
				RESPONSE_ERROR: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'error', context: { data: event.data } }
				},
			},
		},
		stopping: {
			on: {
				PROGRESS: { context: updateUi },
				RESPONSE_OK: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'complete', context: { data: event.data } }
				},
				RESPONSE_ERROR: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'error', context: { data: event.data } }
				},
			},
		},
		complete: {
			on: {
				SUBMIT: { target: 'running', context: startUi },
			},
		},
		error: {
			on: {
				SUBMIT: { target: 'running', context: startUi },
			},
		},
	},
})
