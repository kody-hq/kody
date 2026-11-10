import { setup, assign } from 'xstate'
import type { UiContext, UiData, UiPayload } from '#client/ui-actor.ts'
type Preview = {
	previewUrl: string
	imageSize: { width: number; height: number }
}
export type AvatarCropState =
	| { status: 'decoding' }
	| { status: 'decode_error'; error: string }
	| (Preview &
			(
				| { status: 'ready' | 'applying' }
				| { status: 'prepare_error'; error: string }
			))

export const avatarCropState = setup({
	types: {
		context: {} as UiContext<AvatarCropState>,
		events: {} as
			| {
					type: 'DECODE'
					data: UiPayload<AvatarCropState, 'decoding'>
					requestId?: unknown
			  }
			| {
					type: 'DECODE_OK'
					data: UiPayload<AvatarCropState, 'ready'>
					requestId?: unknown
			  }
			| {
					type: 'DECODE_ERROR'
					data: UiPayload<AvatarCropState, 'decode_error'>
					requestId?: unknown
			  }
			| {
					type: 'APPLY'
					data: UiPayload<AvatarCropState, 'applying'>
					requestId?: unknown
			  }
			| {
					type: 'PREPARE_ERROR'
					data: UiPayload<AvatarCropState, 'prepare_error'>
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
	id: 'avatar.ui_crop',
	description:
		'Decoded previews exist only while editing or preparing; decode failures cannot be applied and preparation failures can be retried.',
	initial: 'decoding',
	context: { data: {} as UiData<AvatarCropState>, requestId: undefined },
	states: {
		decoding: {
			on: {
				DECODE: { target: 'decoding', actions: 'start' },
				DECODE_OK: {
					target: 'ready',
					guard: 'currentRequest',
					actions: 'update',
				},
				DECODE_ERROR: {
					target: 'decode_error',
					guard: 'currentRequest',
					actions: 'update',
				},
			},
		},
		ready: {
			on: {
				DECODE: { target: 'decoding', actions: 'start' },
				APPLY: { target: 'applying', actions: 'update' },
			},
		},
		applying: {
			on: {
				DECODE: { target: 'decoding', actions: 'start' },
				PREPARE_ERROR: {
					target: 'prepare_error',
					guard: 'currentRequest',
					actions: 'update',
				},
			},
		},
		decode_error: { on: { DECODE: { target: 'decoding', actions: 'start' } } },
		prepare_error: {
			on: {
				DECODE: { target: 'decoding', actions: 'start' },
				APPLY: { target: 'applying', actions: 'update' },
			},
		},
	},
})
