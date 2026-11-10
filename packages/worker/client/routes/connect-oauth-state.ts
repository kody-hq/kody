import { setup, types } from 'xstate'
import type { ConnectOauthUiState } from './connect-oauth-view.ts'
import {
	resetUi,
	startUi,
	updateUi,
	uiContext,
	type UiContext,
	type UiData,
	type UiEvent,
} from '#client/ui-actor.ts'
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
	return { data, requestId: undefined }
}
export const connectOauthStepState = setup({
	schemas: {
		context: types<UiContext<ConnectOauthStepView>>(),
		events: {
			EDIT: types<
				UiEvent<
					ConnectOauthStepView,
					'setup' | 'connect' | 'device' | 'callback' | 'success'
				>
			>(),
			SETUP: types<UiEvent<ConnectOauthStepView, 'setup'>>(),
			CONNECT: types<UiEvent<ConnectOauthStepView, 'connect'>>(),
			DEVICE: types<UiEvent<ConnectOauthStepView, 'device'>>(),
			CALLBACK: types<UiEvent<ConnectOauthStepView, 'callback'>>(),
			CREDENTIALS_SAVED: types<UiEvent<ConnectOauthStepView, 'success'>>(),
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
				EDIT: { context: updateUi },
				SETUP: { target: 'setup', context: updateUi },
				CONNECT: { target: 'connect', context: updateUi },
				CALLBACK: { target: 'callback', context: updateUi },
			},
		},
		connect: {
			on: {
				EDIT: { context: updateUi },
				SETUP: { target: 'setup', context: updateUi },
				CONNECT: { target: 'connect', context: updateUi },
				DEVICE: { target: 'device', context: updateUi },
				CALLBACK: { target: 'callback', context: updateUi },
			},
		},
		device: {
			on: {
				EDIT: { context: updateUi },
				CONNECT: { target: 'connect', context: updateUi },
				DEVICE: { target: 'device', context: updateUi },
				CREDENTIALS_SAVED: { target: 'success', context: updateUi },
			},
		},
		callback: {
			on: {
				EDIT: { context: updateUi },
				SETUP: { target: 'setup', context: updateUi },
				CONNECT: { target: 'connect', context: updateUi },
				CALLBACK: { target: 'callback', context: updateUi },
				CREDENTIALS_SAVED: { target: 'success', context: updateUi },
			},
		},
		success: {
			on: {
				EDIT: { context: updateUi },
				SETUP: { target: 'setup', context: updateUi },
				CREDENTIALS_SAVED: { target: 'success', context: updateUi },
			},
		},
	},
})

type ConnectOauthOperationView = { status: 'idle' | 'submitting' }
export const connectOauthOperationState = setup({
	schemas: {
		context: types<UiContext<ConnectOauthOperationView>>(),
		events: {
			SUBMIT: types<UiEvent<ConnectOauthOperationView, 'submitting'>>(),
			SETTLED: types<UiEvent<ConnectOauthOperationView, 'idle'>>(),
		},
	},
	guards: { currentRequest: (a: unknown, b: unknown) => a === b },
}).createMachine({
	id: 'connect_oauth.operation',
	description:
		'One setup or authorize request fences submission independently of the displayed OAuth step and its feedback.',
	initial: 'idle',
	context: { data: {}, requestId: undefined },
	states: {
		idle: {
			on: {
				SUBMIT: { target: 'submitting', context: startUi },
			},
		},
		submitting: {
			on: {
				SETTLED: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'idle', context: resetUi({ event }) }
				},
			},
		},
	},
})
