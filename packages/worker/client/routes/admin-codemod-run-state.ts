import { setup, types } from 'xstate'
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
	schemas: {
		context: types<UiContext<AdminCodemodRunState>>(),
		events: {
			SUBMIT: types<{
				data: UiPayload<AdminCodemodRunState, 'running'>
				requestId?: unknown
			}>(),
			PROGRESS: types<{
				data: UiPayload<AdminCodemodRunState, 'running' | 'stopping'>
				requestId?: unknown
			}>(),
			STOP: types<{
				data: UiPayload<AdminCodemodRunState, 'stopping'>
				requestId?: unknown
			}>(),
			RESPONSE_OK: types<{
				data: UiPayload<AdminCodemodRunState, 'complete'>
				requestId?: unknown
			}>(),
			RESPONSE_ERROR: types<{
				data: UiPayload<AdminCodemodRunState, 'error'>
				requestId?: unknown
			}>(),
		},
	},
}).createMachine({
	id: 'admin_codemods.ui_run',
	description:
		'Paged execution owns its progress and terminal feedback; a requested stop is fenced until the current step and history reconciliation finish.',
	initial: 'idle',
	context: { data: {} as UiData<AdminCodemodRunState>, requestId: undefined },
	states: {
		idle: {
			on: {
				SUBMIT: {
					target: 'running',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
			},
		},
		running: {
			on: {
				PROGRESS: { context: ({ event }) => ({ data: event.data }) },
				STOP: {
					target: 'stopping',
					context: ({ event }) => ({ data: event.data }),
				},
				RESPONSE_OK: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<AdminCodemodRunState>
						event: { type: 'RESPONSE_OK' } & {
							data: UiPayload<AdminCodemodRunState, 'complete'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'complete', context: { data: event.data } }
					},
				},
				RESPONSE_ERROR: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<AdminCodemodRunState>
						event: { type: 'RESPONSE_ERROR' } & {
							data: UiPayload<AdminCodemodRunState, 'error'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'error', context: { data: event.data } }
					},
				},
			},
		},
		stopping: {
			on: {
				PROGRESS: { context: ({ event }) => ({ data: event.data }) },
				RESPONSE_OK: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<AdminCodemodRunState>
						event: { type: 'RESPONSE_OK' } & {
							data: UiPayload<AdminCodemodRunState, 'complete'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'complete', context: { data: event.data } }
					},
				},
				RESPONSE_ERROR: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<AdminCodemodRunState>
						event: { type: 'RESPONSE_ERROR' } & {
							data: UiPayload<AdminCodemodRunState, 'error'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'error', context: { data: event.data } }
					},
				},
			},
		},
		complete: {
			on: {
				SUBMIT: {
					target: 'running',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
			},
		},
		error: {
			on: {
				SUBMIT: {
					target: 'running',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
			},
		},
	},
})
