import { setup, assign } from 'xstate'
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
	types: {
		context: {} as UiContext<ConnectOauthDeviceState>,
		events: {} as
			| {
					type: 'START'
					data: UiPayload<ConnectOauthDeviceState, 'starting'>
					requestId?: unknown
			  }
			| {
					type: 'SESSION_OK'
					data: UiPayload<ConnectOauthDeviceState, 'polling'>
					requestId?: unknown
			  }
			| {
					type: 'POLL_PENDING'
					data: UiPayload<ConnectOauthDeviceState, 'polling'>
					requestId?: unknown
			  }
			| {
					type: 'TICK'
					data: UiPayload<ConnectOauthDeviceState, 'polling'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_ERROR'
					data: UiPayload<ConnectOauthDeviceState, 'error'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_OK'
					data: UiPayload<ConnectOauthDeviceState, 'success'>
					requestId?: unknown
			  }
			| {
					type: 'RESET'
					data: UiPayload<ConnectOauthDeviceState, 'idle'>
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
				START: { target: 'starting', actions: 'start' },
				RESET: { target: 'idle', actions: 'reset' },
			},
		},
		starting: {
			on: {
				SESSION_OK: {
					target: 'polling',
					guard: 'currentRequest',
					actions: 'update',
				},
				RESPONSE_ERROR: {
					target: 'error',
					guard: 'currentRequest',
					actions: 'update',
				},
				RESET: { target: 'idle', actions: 'reset' },
			},
		},
		polling: {
			on: {
				POLL_PENDING: {
					target: 'polling',
					guard: 'currentRequest',
					actions: 'update',
				},
				TICK: { actions: 'update' },
				RESPONSE_ERROR: {
					target: 'error',
					guard: 'currentRequest',
					actions: 'update',
				},
				RESPONSE_OK: {
					target: 'success',
					guard: 'currentRequest',
					actions: 'update',
				},
				RESET: { target: 'idle', actions: 'reset' },
			},
		},
		error: {
			on: {
				RESPONSE_OK: {
					target: 'success',
					guard: 'currentRequest',
					actions: 'update',
				},
				RESET: { target: 'idle', actions: 'reset' },
			},
		},
		success: { on: { RESET: { target: 'idle', actions: 'reset' } } },
	},
})
