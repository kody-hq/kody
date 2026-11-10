import { setup, types } from 'xstate'
import {
	uiContext,
	type UiContext,
	type UiData,
	type UiPayload,
} from '#client/ui-actor.ts'
import type { ConnectOauthUiState } from './connect-oauth-view.ts'
export type ConnectOauthStep =
	| 'setup'
	| 'connect'
	| 'device'
	| 'callback'
	| 'success'

export type ConnectOauthStepView = ConnectOauthUiState extends infer V
	? V extends { status: string }
		? Omit<V, 'request'>
		: never
	: never
export function connectOauthStepContext(
	view: ConnectOauthUiState,
): UiContext<ConnectOauthStepView> {
	const { request: _request, ...data } = {
		...uiContext(view).data,
		request: undefined,
	}
	return { data, requestId: undefined } as UiContext<ConnectOauthStepView>
}
export const connectOauthStepState = setup({
	schemas: {
		context: types<UiContext<ConnectOauthStepView>>(),
		events: {
			EDIT: types<{
				data: UiPayload<
					ConnectOauthStepView,
					'setup' | 'connect' | 'device' | 'callback' | 'success'
				>
				requestId?: unknown
			}>(),
			SETUP: types<{
				data: UiPayload<ConnectOauthStepView, 'setup'>
				requestId?: unknown
			}>(),
			CONNECT: types<{
				data: UiPayload<ConnectOauthStepView, 'connect'>
				requestId?: unknown
			}>(),
			DEVICE: types<{
				data: UiPayload<ConnectOauthStepView, 'device'>
				requestId?: unknown
			}>(),
			CALLBACK: types<{
				data: UiPayload<ConnectOauthStepView, 'callback'>
				requestId?: unknown
			}>(),
			CREDENTIALS_SAVED: types<{
				data: UiPayload<ConnectOauthStepView, 'success'>
				requestId?: unknown
			}>(),
		},
	},
}).createMachine({
	id: 'connect_oauth.step',
	description:
		'Client setup advances to browser or device authorization, callbacks can repair credentials, and only success carries a saved-token receipt.',
	initial: 'setup',
	context: { data: {} as UiData<ConnectOauthStepView>, requestId: undefined },
	states: {
		setup: {
			on: {
				EDIT: { context: ({ event }) => ({ data: event.data }) },
				SETUP: {
					target: 'setup',
					context: ({ event }) => ({ data: event.data }),
				},
				CONNECT: {
					target: 'connect',
					context: ({ event }) => ({ data: event.data }),
				},
				CALLBACK: {
					target: 'callback',
					context: ({ event }) => ({ data: event.data }),
				},
			},
		},
		connect: {
			on: {
				EDIT: { context: ({ event }) => ({ data: event.data }) },
				SETUP: {
					target: 'setup',
					context: ({ event }) => ({ data: event.data }),
				},
				CONNECT: {
					target: 'connect',
					context: ({ event }) => ({ data: event.data }),
				},
				DEVICE: {
					target: 'device',
					context: ({ event }) => ({ data: event.data }),
				},
				CALLBACK: {
					target: 'callback',
					context: ({ event }) => ({ data: event.data }),
				},
			},
		},
		device: {
			on: {
				EDIT: { context: ({ event }) => ({ data: event.data }) },
				CONNECT: {
					target: 'connect',
					context: ({ event }) => ({ data: event.data }),
				},
				DEVICE: {
					target: 'device',
					context: ({ event }) => ({ data: event.data }),
				},
				CREDENTIALS_SAVED: {
					target: 'success',
					context: ({ event }) => ({ data: event.data }),
				},
			},
		},
		callback: {
			on: {
				EDIT: { context: ({ event }) => ({ data: event.data }) },
				SETUP: {
					target: 'setup',
					context: ({ event }) => ({ data: event.data }),
				},
				CONNECT: {
					target: 'connect',
					context: ({ event }) => ({ data: event.data }),
				},
				CALLBACK: {
					target: 'callback',
					context: ({ event }) => ({ data: event.data }),
				},
				CREDENTIALS_SAVED: {
					target: 'success',
					context: ({ event }) => ({ data: event.data }),
				},
			},
		},
		success: {
			on: {
				EDIT: { context: ({ event }) => ({ data: event.data }) },
				SETUP: {
					target: 'setup',
					context: ({ event }) => ({ data: event.data }),
				},
				CREDENTIALS_SAVED: {
					target: 'success',
					context: ({ event }) => ({ data: event.data }),
				},
			},
		},
	},
})

type ConnectOauthOperationView = { status: 'idle' | 'submitting' }
export const connectOauthOperationState = setup({
	schemas: {
		context: types<UiContext<ConnectOauthOperationView>>(),
		events: {
			SUBMIT: types<{
				data: UiPayload<ConnectOauthOperationView, 'submitting'>
				requestId?: unknown
			}>(),
			SETTLED: types<{
				data: UiPayload<ConnectOauthOperationView, 'idle'>
				requestId?: unknown
			}>(),
		},
	},
}).createMachine({
	id: 'connect_oauth.operation',
	description:
		'One setup or authorize request fences submission independently of the displayed OAuth step and its feedback.',
	initial: 'idle',
	context: {
		data: {} as UiData<ConnectOauthOperationView>,
		requestId: undefined,
	},
	states: {
		idle: {
			on: {
				SUBMIT: {
					target: 'submitting',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
			},
		},
		submitting: {
			on: {
				SETTLED: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<ConnectOauthOperationView>
						event: { type: 'SETTLED' } & {
							data: UiPayload<ConnectOauthOperationView, 'idle'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return {
							target: 'idle',
							context: { data: event.data, requestId: undefined },
						}
					},
				},
			},
		},
	},
})
