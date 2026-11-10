import { setup, types } from 'xstate'
import {
	resetUi,
	startUi,
	type UiContext,
	type UiEvent,
} from '#client/ui-actor.ts'
type Status =
	| 'idle'
	| 'checking'
	| 'available'
	| 'taken'
	| 'reserved'
	| 'invalid'
	| 'unknown'
export type UsernameAvailabilityView =
	| { status: 'idle' | 'checking' }
	| {
			status: Exclude<Status, 'idle' | 'checking'>
			username: string
			reason: string | null
			suggestions: Array<string>
	  }

export const usernameAvailabilityState = setup({
	schemas: {
		context: types<UiContext<UsernameAvailabilityView>>(),
		events: {
			EDIT: types<UiEvent<UsernameAvailabilityView, 'idle'>>(),
			CHECK: types<UiEvent<UsernameAvailabilityView, 'checking'>>(),
			INVALID_DRAFT: types<UiEvent<UsernameAvailabilityView, 'invalid'>>(),
			RESPONSE_AVAILABLE:
				types<UiEvent<UsernameAvailabilityView, 'available'>>(),
			RESPONSE_TAKEN: types<UiEvent<UsernameAvailabilityView, 'taken'>>(),
			RESPONSE_RESERVED: types<UiEvent<UsernameAvailabilityView, 'reserved'>>(),
			RESPONSE_INVALID: types<UiEvent<UsernameAvailabilityView, 'invalid'>>(),
			RESPONSE_UNKNOWN: types<UiEvent<UsernameAvailabilityView, 'unknown'>>(),
		},
	},
	guards: { currentRequest: (a: unknown, b: unknown) => a === b },
}).createMachine({
	id: 'username.availability_ui',
	description:
		'Editing resets or checks a candidate; only the current check may publish a result, and empty or invalid drafts cannot receive old results.',
	initial: 'idle',
	context: { data: {}, requestId: undefined },
	states: {
		idle: {
			on: {
				EDIT: { target: 'idle', context: resetUi },
				CHECK: { target: 'checking', context: startUi },
				INVALID_DRAFT: { target: 'invalid', context: resetUi },
			},
		},
		checking: {
			on: {
				EDIT: { target: 'idle', context: resetUi },
				CHECK: { target: 'checking', context: startUi },
				INVALID_DRAFT: { target: 'invalid', context: resetUi },
				RESPONSE_AVAILABLE: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'available', context: { data: event.data } }
				},
				RESPONSE_TAKEN: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'taken', context: { data: event.data } }
				},
				RESPONSE_RESERVED: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'reserved', context: { data: event.data } }
				},
				RESPONSE_INVALID: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'invalid', context: { data: event.data } }
				},
				RESPONSE_UNKNOWN: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'unknown', context: { data: event.data } }
				},
			},
		},
		available: {
			on: {
				EDIT: { target: 'idle', context: resetUi },
				CHECK: { target: 'checking', context: startUi },
				INVALID_DRAFT: { target: 'invalid', context: resetUi },
			},
		},
		taken: {
			on: {
				EDIT: { target: 'idle', context: resetUi },
				CHECK: { target: 'checking', context: startUi },
				INVALID_DRAFT: { target: 'invalid', context: resetUi },
			},
		},
		reserved: {
			on: {
				EDIT: { target: 'idle', context: resetUi },
				CHECK: { target: 'checking', context: startUi },
				INVALID_DRAFT: { target: 'invalid', context: resetUi },
			},
		},
		invalid: {
			on: {
				EDIT: { target: 'idle', context: resetUi },
				CHECK: { target: 'checking', context: startUi },
				INVALID_DRAFT: { target: 'invalid', context: resetUi },
			},
		},
		unknown: {
			on: {
				EDIT: { target: 'idle', context: resetUi },
				CHECK: { target: 'checking', context: startUi },
				INVALID_DRAFT: { target: 'invalid', context: resetUi },
			},
		},
	},
})
