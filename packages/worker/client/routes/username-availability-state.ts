import { setup, types } from 'xstate'
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
	schemas: {
		context: types<UiContext<UsernameAvailabilityView>>(),
		events: {
			EDIT: types<{
				data: UiPayload<UsernameAvailabilityView, 'idle'>
				requestId?: unknown
			}>(),
			CHECK: types<{
				data: UiPayload<UsernameAvailabilityView, 'checking'>
				requestId?: unknown
			}>(),
			INVALID_DRAFT: types<{
				data: UiPayload<UsernameAvailabilityView, 'invalid'>
				requestId?: unknown
			}>(),
			RESPONSE_AVAILABLE: types<{
				data: UiPayload<UsernameAvailabilityView, 'available'>
				requestId?: unknown
			}>(),
			RESPONSE_TAKEN: types<{
				data: UiPayload<UsernameAvailabilityView, 'taken'>
				requestId?: unknown
			}>(),
			RESPONSE_RESERVED: types<{
				data: UiPayload<UsernameAvailabilityView, 'reserved'>
				requestId?: unknown
			}>(),
			RESPONSE_INVALID: types<{
				data: UiPayload<UsernameAvailabilityView, 'invalid'>
				requestId?: unknown
			}>(),
			RESPONSE_UNKNOWN: types<{
				data: UiPayload<UsernameAvailabilityView, 'unknown'>
				requestId?: unknown
			}>(),
		},
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
				EDIT: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
				CHECK: {
					target: 'checking',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				INVALID_DRAFT: {
					target: 'invalid',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		checking: {
			on: {
				EDIT: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
				CHECK: {
					target: 'checking',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				INVALID_DRAFT: {
					target: 'invalid',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
				RESPONSE_AVAILABLE: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<UsernameAvailabilityView>
						event: { type: 'RESPONSE_AVAILABLE' } & {
							data: UiPayload<UsernameAvailabilityView, 'available'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'available', context: { data: event.data } }
					},
				},
				RESPONSE_TAKEN: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<UsernameAvailabilityView>
						event: { type: 'RESPONSE_TAKEN' } & {
							data: UiPayload<UsernameAvailabilityView, 'taken'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'taken', context: { data: event.data } }
					},
				},
				RESPONSE_RESERVED: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<UsernameAvailabilityView>
						event: { type: 'RESPONSE_RESERVED' } & {
							data: UiPayload<UsernameAvailabilityView, 'reserved'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'reserved', context: { data: event.data } }
					},
				},
				RESPONSE_INVALID: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<UsernameAvailabilityView>
						event: { type: 'RESPONSE_INVALID' } & {
							data: UiPayload<UsernameAvailabilityView, 'invalid'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'invalid', context: { data: event.data } }
					},
				},
				RESPONSE_UNKNOWN: {
					description: 'Current request',
					to: ({
						context,
						event,
					}: {
						context: UiContext<UsernameAvailabilityView>
						event: { type: 'RESPONSE_UNKNOWN' } & {
							data: UiPayload<UsernameAvailabilityView, 'unknown'>
							requestId?: unknown
						}
					}) => {
						if (!(context.requestId === event.requestId)) return undefined
						return { target: 'unknown', context: { data: event.data } }
					},
				},
			},
		},
		available: {
			on: {
				EDIT: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
				CHECK: {
					target: 'checking',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				INVALID_DRAFT: {
					target: 'invalid',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		taken: {
			on: {
				EDIT: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
				CHECK: {
					target: 'checking',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				INVALID_DRAFT: {
					target: 'invalid',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		reserved: {
			on: {
				EDIT: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
				CHECK: {
					target: 'checking',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				INVALID_DRAFT: {
					target: 'invalid',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		invalid: {
			on: {
				EDIT: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
				CHECK: {
					target: 'checking',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				INVALID_DRAFT: {
					target: 'invalid',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
		unknown: {
			on: {
				EDIT: {
					target: 'idle',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
				CHECK: {
					target: 'checking',
					context: ({ event }) => ({
						data: event.data,
						requestId: event.requestId,
					}),
				},
				INVALID_DRAFT: {
					target: 'invalid',
					context: ({ event }) => ({ data: event.data, requestId: undefined }),
				},
			},
		},
	},
})
