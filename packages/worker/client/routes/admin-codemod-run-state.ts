import { setup, assign } from 'xstate'
import type { UiContext, UiData, UiPayload } from '#client/ui-actor.ts'
import type { LiveRunItem } from './admin-codemods-shared.ts'
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
	types: {
		context: {} as UiContext<AdminCodemodRunState>,
		events: {} as
			| {
					type: 'SUBMIT'
					data: UiPayload<AdminCodemodRunState, 'running'>
					requestId?: unknown
			  }
			| {
					type: 'PROGRESS'
					data: UiPayload<AdminCodemodRunState, 'running' | 'stopping'>
					requestId?: unknown
			  }
			| {
					type: 'STOP'
					data: UiPayload<AdminCodemodRunState, 'stopping'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_OK'
					data: UiPayload<AdminCodemodRunState, 'complete'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_ERROR'
					data: UiPayload<AdminCodemodRunState, 'error'>
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
	id: 'admin_codemods.ui_run',
	description:
		'Paged execution owns its progress and terminal feedback; a requested stop is fenced until the current step and history reconciliation finish.',
	initial: 'idle',
	context: { data: {} as UiData<AdminCodemodRunState>, requestId: undefined },
	states: {
		idle: { on: { SUBMIT: { target: 'running', actions: 'start' } } },
		running: {
			on: {
				PROGRESS: { actions: 'update' },
				STOP: { target: 'stopping', actions: 'update' },
				RESPONSE_OK: {
					target: 'complete',
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
		stopping: {
			on: {
				PROGRESS: { actions: 'update' },
				RESPONSE_OK: {
					target: 'complete',
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
		complete: { on: { SUBMIT: { target: 'running', actions: 'start' } } },
		error: { on: { SUBMIT: { target: 'running', actions: 'start' } } },
	},
})
