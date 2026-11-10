import { setup, assign } from 'xstate'
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
	types: {
		context: {} as UiContext<PublishCheckAttempt>,
		events: {} as
			| {
					type: 'CLEAR_COMMIT'
					data: UiPayload<PublishCheckAttempt, 'idle'>
					requestId?: unknown
			  }
			| {
					type: 'CHECK_COMMIT'
					data: UiPayload<PublishCheckAttempt, 'running'>
					requestId?: unknown
			  }
			| {
					type: 'CHECK_PASSED'
					data: UiPayload<PublishCheckAttempt, 'passed'>
					requestId?: unknown
			  }
			| {
					type: 'CHECK_FAILED'
					data: UiPayload<PublishCheckAttempt, 'failed'>
					requestId?: unknown
			  }
			| {
					type: 'CHECK_UNAVAILABLE'
					data: UiPayload<PublishCheckAttempt, 'unavailable'>
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
	id: 'package_publish.ui_checks',
	description:
		'Checks are scoped to the selected commit; changing or clearing that commit releases the old result before starting a new attempt.',
	initial: 'idle',
	context: { data: {} as UiData<PublishCheckAttempt>, requestId: undefined },
	states: {
		idle: {
			on: {
				CLEAR_COMMIT: { target: 'idle', actions: 'reset' },
				CHECK_COMMIT: { target: 'running', actions: 'start' },
			},
		},
		running: {
			on: {
				CLEAR_COMMIT: { target: 'idle', actions: 'reset' },
				CHECK_COMMIT: { target: 'running', actions: 'start' },
				CHECK_PASSED: {
					target: 'passed',
					guard: 'currentRequest',
					actions: 'update',
				},
				CHECK_FAILED: {
					target: 'failed',
					guard: 'currentRequest',
					actions: 'update',
				},
				CHECK_UNAVAILABLE: {
					target: 'unavailable',
					guard: 'currentRequest',
					actions: 'update',
				},
			},
		},
		passed: {
			on: {
				CLEAR_COMMIT: { target: 'idle', actions: 'reset' },
				CHECK_COMMIT: { target: 'running', actions: 'start' },
			},
		},
		failed: {
			on: {
				CLEAR_COMMIT: { target: 'idle', actions: 'reset' },
				CHECK_COMMIT: { target: 'running', actions: 'start' },
			},
		},
		unavailable: {
			on: {
				CLEAR_COMMIT: { target: 'idle', actions: 'reset' },
				CHECK_COMMIT: { target: 'running', actions: 'start' },
			},
		},
	},
})
