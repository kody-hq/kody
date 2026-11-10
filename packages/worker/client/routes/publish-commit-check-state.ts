import { setup, types } from 'xstate'
import type { UiContext, UiData, UiPayload } from '#client/ui-actor.ts'
type Payloads = {
	idle: {}
	running: {}
	passed: {}
	failed: { failedChecks: Array<{ kind: string; message: string }> }
	unavailable: { error: string }
}
type Status = 'idle' | 'running' | 'passed' | 'failed' | 'unavailable'
export type PublishCommitChecksState = {
	[S in Status]: { status: S } & Payloads[S]
}[Status]
export type PublishCheckAttempt =
	| { status: 'idle' }
	| (Exclude<PublishCommitChecksState, { status: 'idle' }> & { key: string })

export const publishCommitCheckState = setup({
	schemas: {
		context: types<UiContext<PublishCheckAttempt>>(),
		events: {
			CLEAR_COMMIT: types<{
				data: UiPayload<PublishCheckAttempt, 'idle'>
				requestId?: unknown
			}>(),
			CHECK_COMMIT: types<{
				data: UiPayload<PublishCheckAttempt, 'running'>
				requestId?: unknown
			}>(),
			CHECK_PASSED: types<{
				data: UiPayload<PublishCheckAttempt, 'passed'>
				requestId?: unknown
			}>(),
			CHECK_FAILED: types<{
				data: UiPayload<PublishCheckAttempt, 'failed'>
				requestId?: unknown
			}>(),
			CHECK_UNAVAILABLE: types<{
				data: UiPayload<PublishCheckAttempt, 'unavailable'>
				requestId?: unknown
			}>(),
		},
	},
}).createMachine({
	id: 'package_publish.ui_checks',
	description:
		'Checks are scoped to the selected commit; changing or clearing that commit releases the old result before starting a new attempt.',
	initial: 'idle',
	context: { data: {} as UiData<PublishCheckAttempt>, requestId: undefined },
	states: {
		idle: {
			on: {
				CLEAR_COMMIT: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
				CHECK_COMMIT: {
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
				CLEAR_COMMIT: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
				CHECK_COMMIT: {
					target: 'running',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				CHECK_PASSED: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<PublishCheckAttempt>
						event: { type: 'CHECK_PASSED' } & {
							data: UiPayload<PublishCheckAttempt, 'passed'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'passed', context: { data: event.data } }
					},
				},
				CHECK_FAILED: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<PublishCheckAttempt>
						event: { type: 'CHECK_FAILED' } & {
							data: UiPayload<PublishCheckAttempt, 'failed'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'failed', context: { data: event.data } }
					},
				},
				CHECK_UNAVAILABLE: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<PublishCheckAttempt>
						event: { type: 'CHECK_UNAVAILABLE' } & {
							data: UiPayload<PublishCheckAttempt, 'unavailable'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'unavailable', context: { data: event.data } }
					},
				},
			},
		},
		passed: {
			on: {
				CLEAR_COMMIT: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
				CHECK_COMMIT: {
					target: 'running',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
			},
		},
		failed: {
			on: {
				CLEAR_COMMIT: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
				CHECK_COMMIT: {
					target: 'running',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
			},
		},
		unavailable: {
			on: {
				CLEAR_COMMIT: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
				CHECK_COMMIT: {
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
