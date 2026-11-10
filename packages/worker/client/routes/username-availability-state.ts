import { setup, assign } from 'xstate'
import type { UiContext, UiData, UiPayload } from '#client/ui-actor.ts'
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
	types: {
		context: {} as UiContext<UsernameAvailabilityView>,
		events: {} as
			| {
					type: 'EDIT'
					data: UiPayload<UsernameAvailabilityView, 'idle'>
					requestId?: unknown
			  }
			| {
					type: 'CHECK'
					data: UiPayload<UsernameAvailabilityView, 'checking'>
					requestId?: unknown
			  }
			| {
					type: 'INVALID_DRAFT'
					data: UiPayload<UsernameAvailabilityView, 'invalid'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_AVAILABLE'
					data: UiPayload<UsernameAvailabilityView, 'available'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_TAKEN'
					data: UiPayload<UsernameAvailabilityView, 'taken'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_RESERVED'
					data: UiPayload<UsernameAvailabilityView, 'reserved'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_INVALID'
					data: UiPayload<UsernameAvailabilityView, 'invalid'>
					requestId?: unknown
			  }
			| {
					type: 'RESPONSE_UNKNOWN'
					data: UiPayload<UsernameAvailabilityView, 'unknown'>
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
	id: 'username.availability_ui',
	description:
		'Editing resets or checks a candidate; only the current check may publish a result, and empty or invalid drafts cannot receive old results.',
	initial: 'idle',
	context: {
		data: {} as UiData<UsernameAvailabilityView>,
		requestId: undefined,
	},
	states: {
		idle: {
			on: {
				EDIT: { target: 'idle', actions: 'reset' },
				CHECK: { target: 'checking', actions: 'start' },
				INVALID_DRAFT: { target: 'invalid', actions: 'reset' },
			},
		},
		checking: {
			on: {
				EDIT: { target: 'idle', actions: 'reset' },
				CHECK: { target: 'checking', actions: 'start' },
				INVALID_DRAFT: { target: 'invalid', actions: 'reset' },
				RESPONSE_AVAILABLE: {
					target: 'available',
					guard: 'currentRequest',
					actions: 'update',
				},
				RESPONSE_TAKEN: {
					target: 'taken',
					guard: 'currentRequest',
					actions: 'update',
				},
				RESPONSE_RESERVED: {
					target: 'reserved',
					guard: 'currentRequest',
					actions: 'update',
				},
				RESPONSE_INVALID: {
					target: 'invalid',
					guard: 'currentRequest',
					actions: 'update',
				},
				RESPONSE_UNKNOWN: {
					target: 'unknown',
					guard: 'currentRequest',
					actions: 'update',
				},
			},
		},
		available: {
			on: {
				EDIT: { target: 'idle', actions: 'reset' },
				CHECK: { target: 'checking', actions: 'start' },
				INVALID_DRAFT: { target: 'invalid', actions: 'reset' },
			},
		},
		taken: {
			on: {
				EDIT: { target: 'idle', actions: 'reset' },
				CHECK: { target: 'checking', actions: 'start' },
				INVALID_DRAFT: { target: 'invalid', actions: 'reset' },
			},
		},
		reserved: {
			on: {
				EDIT: { target: 'idle', actions: 'reset' },
				CHECK: { target: 'checking', actions: 'start' },
				INVALID_DRAFT: { target: 'invalid', actions: 'reset' },
			},
		},
		invalid: {
			on: {
				EDIT: { target: 'idle', actions: 'reset' },
				CHECK: { target: 'checking', actions: 'start' },
				INVALID_DRAFT: { target: 'invalid', actions: 'reset' },
			},
		},
		unknown: {
			on: {
				EDIT: { target: 'idle', actions: 'reset' },
				CHECK: { target: 'checking', actions: 'start' },
				INVALID_DRAFT: { target: 'invalid', actions: 'reset' },
			},
		},
	},
})
