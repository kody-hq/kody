import { setup, types } from 'xstate'
import {
	resetUi,
	startUi,
	type UiContext,
	type UiEvent,
} from '#client/ui-actor.ts'
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
			CLEAR_COMMIT: types<UiEvent<PublishCheckAttempt, 'idle'>>(),
			CHECK_COMMIT: types<UiEvent<PublishCheckAttempt, 'running'>>(),
			CHECK_PASSED: types<UiEvent<PublishCheckAttempt, 'passed'>>(),
			CHECK_FAILED: types<UiEvent<PublishCheckAttempt, 'failed'>>(),
			CHECK_UNAVAILABLE: types<UiEvent<PublishCheckAttempt, 'unavailable'>>(),
		},
	},
	guards: { currentRequest: (a: unknown, b: unknown) => a === b },
}).createMachine({
	id: 'package_publish.ui_checks',
	description:
		'Checks are scoped to the selected commit; changing or clearing that commit releases the old result before starting a new attempt.',
	initial: 'idle',
	context: { data: {}, requestId: undefined },
	states: {
		idle: {
			on: {
				CLEAR_COMMIT: { target: 'idle', context: resetUi },
				CHECK_COMMIT: { target: 'running', context: startUi },
			},
		},
		running: {
			on: {
				CLEAR_COMMIT: { target: 'idle', context: resetUi },
				CHECK_COMMIT: { target: 'running', context: startUi },
				CHECK_PASSED: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'passed', context: { data: event.data } }
				},
				CHECK_FAILED: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'failed', context: { data: event.data } }
				},
				CHECK_UNAVAILABLE: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'unavailable', context: { data: event.data } }
				},
			},
		},
		passed: {
			on: {
				CLEAR_COMMIT: { target: 'idle', context: resetUi },
				CHECK_COMMIT: { target: 'running', context: startUi },
			},
		},
		failed: {
			on: {
				CLEAR_COMMIT: { target: 'idle', context: resetUi },
				CHECK_COMMIT: { target: 'running', context: startUi },
			},
		},
		unavailable: {
			on: {
				CLEAR_COMMIT: { target: 'idle', context: resetUi },
				CHECK_COMMIT: { target: 'running', context: startUi },
			},
		},
	},
})
