import { setup, types } from 'xstate'
import type { UiContext, UiData, UiPayload } from '#client/ui-actor.ts'
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
			START: types<{
				data: UiPayload<ConnectOauthDeviceState, 'starting'>
				requestId?: unknown
			}>(),
			SESSION_OK: types<{
				data: UiPayload<ConnectOauthDeviceState, 'polling'>
				requestId?: unknown
			}>(),
			POLL_PENDING: types<{
				data: UiPayload<ConnectOauthDeviceState, 'polling'>
				requestId?: unknown
			}>(),
			TICK: types<{
				data: UiPayload<ConnectOauthDeviceState, 'polling'>
				requestId?: unknown
			}>(),
			RESPONSE_ERROR: types<{
				data: UiPayload<ConnectOauthDeviceState, 'error'>
				requestId?: unknown
			}>(),
			RESPONSE_OK: types<{
				data: UiPayload<ConnectOauthDeviceState, 'success'>
				requestId?: unknown
			}>(),
			RESET: types<{
				data: UiPayload<ConnectOauthDeviceState, 'idle'>
				requestId?: unknown
			}>(),
		},
	},
}).createMachine({
	id: 'connect_oauth.device_poll',
	description:
		'A device session polls with transient retries until provider completion or expiry; an already committed late approval remains authoritative after the local deadline.',
	initial: 'idle',
	context: {
		data: {} as UiData<ConnectOauthDeviceState>,
		requestId: undefined,
	},
	states: {
		idle: {
			on: {
				START: {
					target: 'starting',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				RESET: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		starting: {
			on: {
				SESSION_OK: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<ConnectOauthDeviceState>
						event: { type: 'SESSION_OK' } & {
							data: UiPayload<ConnectOauthDeviceState, 'polling'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'polling', context: { data: event.data } }
					},
				},
				RESPONSE_ERROR: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<ConnectOauthDeviceState>
						event: { type: 'RESPONSE_ERROR' } & {
							data: UiPayload<ConnectOauthDeviceState, 'error'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'error', context: { data: event.data } }
					},
				},
				RESET: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		polling: {
			on: {
				POLL_PENDING: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<ConnectOauthDeviceState>
						event: { type: 'POLL_PENDING' } & {
							data: UiPayload<ConnectOauthDeviceState, 'polling'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'polling', context: { data: event.data } }
					},
				},
				TICK: { context: ({ event }) => ({ data: event.data }) },
				RESPONSE_ERROR: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<ConnectOauthDeviceState>
						event: { type: 'RESPONSE_ERROR' } & {
							data: UiPayload<ConnectOauthDeviceState, 'error'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'error', context: { data: event.data } }
					},
				},
				RESPONSE_OK: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<ConnectOauthDeviceState>
						event: { type: 'RESPONSE_OK' } & {
							data: UiPayload<ConnectOauthDeviceState, 'success'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'success', context: { data: event.data } }
					},
				},
				RESET: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		error: {
			on: {
				RESPONSE_OK: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<ConnectOauthDeviceState>
						event: { type: 'RESPONSE_OK' } & {
							data: UiPayload<ConnectOauthDeviceState, 'success'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'success', context: { data: event.data } }
					},
				},
				RESET: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		success: {
			on: {
				RESET: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
	},
})
