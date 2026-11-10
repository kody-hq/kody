import { setup, types } from 'xstate'
import {
	startUi,
	updateUi,
	type UiContext,
	type UiEvent,
} from '#client/ui-actor.ts'
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
	schemas: {
		context: types<UiContext<AvatarCropState>>(),
		events: {
			DECODE: types<UiEvent<AvatarCropState, 'decoding'>>(),
			DECODE_OK: types<UiEvent<AvatarCropState, 'ready'>>(),
			DECODE_ERROR: types<UiEvent<AvatarCropState, 'decode_error'>>(),
			APPLY: types<UiEvent<AvatarCropState, 'applying'>>(),
			PREPARE_ERROR: types<UiEvent<AvatarCropState, 'prepare_error'>>(),
		},
	},
	guards: { currentRequest: (a: unknown, b: unknown) => a === b },
}).createMachine({
	id: 'avatar.ui_crop',
	description:
		'Decoded previews exist only while editing or preparing; decode failures cannot be applied and preparation failures can be retried.',
	initial: 'decoding',
	context: { data: {}, requestId: undefined },
	states: {
		decoding: {
			on: {
				DECODE: { target: 'decoding', context: startUi },
				DECODE_OK: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'ready', context: { data: event.data } }
				},
				DECODE_ERROR: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'decode_error', context: { data: event.data } }
				},
			},
		},
		ready: {
			on: {
				DECODE: { target: 'decoding', context: startUi },
				APPLY: { target: 'applying', context: updateUi },
			},
		},
		applying: {
			on: {
				DECODE: { target: 'decoding', context: startUi },
				PREPARE_ERROR: ({ context, event, guards }) => {
					if (!guards.currentRequest(context.requestId, event.requestId)) return
					return { target: 'prepare_error', context: { data: event.data } }
				},
			},
		},
		decode_error: {
			on: {
				DECODE: { target: 'decoding', context: startUi },
			},
		},
		prepare_error: {
			on: {
				DECODE: { target: 'decoding', context: startUi },
				APPLY: { target: 'applying', context: updateUi },
			},
		},
	},
})
