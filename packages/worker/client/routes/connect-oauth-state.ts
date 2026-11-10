import { setup, assign } from 'xstate'
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
	types: {
		context: {} as UiContext<ConnectOauthStepView>,
		events: {} as
			| {
					type: 'EDIT'
					data: UiPayload<
						ConnectOauthStepView,
						'setup' | 'connect' | 'device' | 'callback' | 'success'
					>
					requestId?: unknown
			  }
			| {
					type: 'SETUP'
					data: UiPayload<ConnectOauthStepView, 'setup'>
					requestId?: unknown
			  }
			| {
					type: 'CONNECT'
					data: UiPayload<ConnectOauthStepView, 'connect'>
					requestId?: unknown
			  }
			| {
					type: 'DEVICE'
					data: UiPayload<ConnectOauthStepView, 'device'>
					requestId?: unknown
			  }
			| {
					type: 'CALLBACK'
					data: UiPayload<ConnectOauthStepView, 'callback'>
					requestId?: unknown
			  }
			| {
					type: 'CREDENTIALS_SAVED'
					data: UiPayload<ConnectOauthStepView, 'success'>
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
	id: 'connect_oauth.step',
	description:
		'Client setup advances to browser or device authorization, callbacks can repair credentials, and only success carries a saved-token receipt.',
	initial: 'setup',
	context: { data: {} as UiData<ConnectOauthStepView>, requestId: undefined },
	states: {
		setup: {
			on: {
				EDIT: { actions: 'update' },
				SETUP: { target: 'setup', actions: 'update' },
				CONNECT: { target: 'connect', actions: 'update' },
				CALLBACK: { target: 'callback', actions: 'update' },
			},
		},
		connect: {
			on: {
				EDIT: { actions: 'update' },
				SETUP: { target: 'setup', actions: 'update' },
				CONNECT: { target: 'connect', actions: 'update' },
				DEVICE: { target: 'device', actions: 'update' },
				CALLBACK: { target: 'callback', actions: 'update' },
			},
		},
		device: {
			on: {
				EDIT: { actions: 'update' },
				CONNECT: { target: 'connect', actions: 'update' },
				DEVICE: { target: 'device', actions: 'update' },
				CREDENTIALS_SAVED: { target: 'success', actions: 'update' },
			},
		},
		callback: {
			on: {
				EDIT: { actions: 'update' },
				SETUP: { target: 'setup', actions: 'update' },
				CONNECT: { target: 'connect', actions: 'update' },
				CALLBACK: { target: 'callback', actions: 'update' },
				CREDENTIALS_SAVED: { target: 'success', actions: 'update' },
			},
		},
		success: {
			on: {
				EDIT: { actions: 'update' },
				SETUP: { target: 'setup', actions: 'update' },
				CREDENTIALS_SAVED: { target: 'success', actions: 'update' },
			},
		},
	},
})

type ConnectOauthOperationView = { status: 'idle' | 'submitting' }
export const connectOauthOperationState = setup({
	types: {
		context: {} as UiContext<ConnectOauthOperationView>,
		events: {} as
			| {
					type: 'SUBMIT'
					data: UiPayload<ConnectOauthOperationView, 'submitting'>
					requestId?: unknown
			  }
			| {
					type: 'SETTLED'
					data: UiPayload<ConnectOauthOperationView, 'idle'>
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
	id: 'connect_oauth.operation',
	description:
		'One setup or authorize request fences submission independently of the displayed OAuth step and its feedback.',
	initial: 'idle',
	context: {
		data: {} as UiData<ConnectOauthOperationView>,
		requestId: undefined,
	},
	states: {
		idle: { on: { SUBMIT: { target: 'submitting', actions: 'start' } } },
		submitting: {
			on: {
				SETTLED: { target: 'idle', guard: 'currentRequest', actions: 'reset' },
			},
		},
	},
})
