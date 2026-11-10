import { setup, types } from 'xstate'
import {
	resetUi,
	startUi,
	updateUi,
	type UiContext,
	type UiEvent,
} from '#client/ui-actor.ts'
export type DeviceDisplay = {
	userCode: string
	verificationUri: string
	verificationUriComplete: string | null
	expiresIn: number
}
export type DeviceSession = DeviceDisplay & {
	sessionId: string
	interval: number
}
export type ConnectOauthDeviceState =
	| { status: 'idle' | 'starting' }
	| { status: 'polling'; session: DeviceSession }
	| { status: 'error'; message: string; view: DeviceDisplay | null }
	| { status: 'success'; view: DeviceDisplay }

export const connectOauthDeviceState = setup({
	schemas: {
		context: types<UiContext<ConnectOauthDeviceState>>(),
		events: {
			START: types<UiEvent<ConnectOauthDeviceState, 'starting'>>(),
			SESSION_OK: types<UiEvent<ConnectOauthDeviceState, 'polling'>>(),
			POLL_PENDING: types<UiEvent<ConnectOauthDeviceState, 'polling'>>(),
			TICK: types<UiEvent<ConnectOauthDeviceState, 'polling'>>(),
			RESPONSE_ERROR: types<UiEvent<ConnectOauthDeviceState, 'error'>>(),
			RESPONSE_OK: types<UiEvent<ConnectOauthDeviceState, 'success'>>(),
			RESET: types<UiEvent<ConnectOauthDeviceState, 'idle'>>(),
		},
	},
	guards: { currentRequest: (a: unknown, b: unknown) => a === b },
}).createMachine({
	id: 'connect_oauth.device_poll',
	description:
		'A device session polls with transient retries until provider completion or expiry; an already committed late approval remains authoritative after the local deadline.',
	initial: 'idle',
	context: { data: {}, requestId: undefined },
	states: {
		idle: {
			on: {
				START: { target: 'starting', context: startUi },
				RESET: { target: 'idle', context: resetUi },
			},
		},
		starting: {
			on: {
				SESSION_OK: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'polling', context: { data: event.data } }
				},
				RESPONSE_ERROR: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'error', context: { data: event.data } }
				},
				RESET: { target: 'idle', context: resetUi },
			},
		},
		polling: {
			on: {
				POLL_PENDING: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'polling', context: { data: event.data } }
				},
				TICK: { context: updateUi },
				RESPONSE_ERROR: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'error', context: { data: event.data } }
				},
				RESPONSE_OK: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'success', context: { data: event.data } }
				},
				RESET: { target: 'idle', context: resetUi },
			},
		},
		error: {
			on: {
				RESPONSE_OK: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'success', context: { data: event.data } }
				},
				RESET: { target: 'idle', context: resetUi },
			},
		},
		success: {
			on: {
				RESET: { target: 'idle', context: resetUi },
			},
		},
	},
})
